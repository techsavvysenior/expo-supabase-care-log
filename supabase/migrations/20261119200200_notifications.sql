-- Notifications go through an outbox. Database triggers write a row with
-- identifiers only; the dispatch-notifications function renders a generic
-- message and sends it by push, email or SMS. No health information leaves
-- the database through Expo, Resend or Twilio: the person opens the app to
-- see what happened.

create type public.notification_template as enum ('incident_reported', 'dose_missed', 'handoff_posted');
create type public.outbox_status as enum ('pending', 'sending', 'sent', 'failed', 'dead');

create table public.device_tokens (
  token text primary key check (token ~ '^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]+\]$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index device_tokens_user_idx on public.device_tokens (user_id);

-- True when a payload carries only allow-listed identifier keys with UUID
-- values. The outbox refuses anything else, so a careless trigger can't leak
-- a name or a note into a push message.
create function public.is_phi_free(p_payload jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_payload) = 'object'
     and not exists (
       select 1 from jsonb_each(p_payload) e
       where e.key not in ('org_id', 'site_id', 'resident_id', 'note_id', 'order_id', 'administration_id')
          or jsonb_typeof(e.value) <> 'string'
          or (e.value #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     )
$$;

create table public.notification_outbox (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  template public.notification_template not null,
  payload jsonb not null check (public.is_phi_free(payload)),
  status public.outbox_status not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  -- One notification per person per event, however often a trigger fires.
  unique (recipient_id, template, payload)
);
create index notification_outbox_due_idx on public.notification_outbox (next_attempt_at) where status = 'pending';

alter table public.device_tokens enable row level security;
alter table public.notification_outbox enable row level security;
revoke all on public.device_tokens, public.notification_outbox from anon, authenticated;

-- People see and remove their own devices. The outbox has no user access.
grant select, delete on public.device_tokens to authenticated;
create policy device_tokens_own_read on public.device_tokens for select to authenticated
  using (user_id = auth.uid());
create policy device_tokens_own_delete on public.device_tokens for delete to authenticated
  using (user_id = auth.uid());

-- A device that changes hands (sign out, sign in as someone else) moves to
-- the new user, so the previous user stops getting its pushes.
create function public.register_device(p_token text, p_platform text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  insert into public.device_tokens (token, user_id, platform)
  values (p_token, auth.uid(), p_platform)
  on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, last_seen_at = now();
end;
$$;

create function public.enqueue_notification(p_org uuid, p_recipients uuid[], p_template public.notification_template, p_payload jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  insert into public.notification_outbox (org_id, recipient_id, template, payload)
  select p_org, r, p_template, p_payload from unnest(p_recipients) r
  on conflict (recipient_id, template, payload) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Who hears about something at a site: admins and nurses of the organization,
-- plus (for handoffs) the caregivers assigned there.
create function public.site_recipients(p_site uuid, p_include_caregivers boolean, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct m.user_id), '{}')
  from public.sites s
  join public.memberships m on m.org_id = s.org_id
  where s.id = p_site
    and m.user_id is distinct from p_exclude
    and (
      m.role in ('admin', 'nurse')
      or (p_include_caregivers and m.role = 'caregiver'
          and exists (select 1 from public.site_assignments a where a.site_id = s.id and a.user_id = m.user_id))
    )
$$;

create function public.notify_on_note() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_site uuid;
begin
  if new.kind not in ('incident', 'handoff') then
    return new;
  end if;
  select site_id into v_site from public.residents where id = new.resident_id;
  perform public.enqueue_notification(
    new.org_id,
    public.site_recipients(v_site, new.kind = 'handoff', new.author_id),
    case new.kind when 'incident' then 'incident_reported' else 'handoff_posted' end::public.notification_template,
    jsonb_build_object('site_id', v_site, 'resident_id', new.resident_id, 'note_id', new.id)
  );
  return new;
end;
$$;
create trigger care_notes_notify after insert on public.care_notes
  for each row execute function public.notify_on_note();

-- Run every few minutes by pg_cron (see supabase/schedules.sql). Writes a
-- "missed" record for each dose more than p_grace past its time with nothing
-- recorded, and tells the nurses and admins of that site.
create function public.mark_missed_doses(p_now timestamptz default now(), p_grace interval default interval '60 minutes')
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_row record;
  v_count integer := 0;
  v_id uuid;
begin
  for v_row in
    with slots as (
      select o.id as order_id, o.org_id, o.resident_id, r.site_id, s.timezone, o.starts_on, o.ends_on,
             d.day, ((d.day + t) at time zone s.timezone) as scheduled_for
      from public.med_orders o
      join public.residents r on r.id = o.resident_id and r.discharged_on is null
      join public.sites s on s.id = r.site_id
      cross join lateral (
        select generate_series(((p_now at time zone s.timezone)::date - 1)::timestamp,
                               (p_now at time zone s.timezone)::date::timestamp,
                               interval '1 day')::date as day
      ) d
      cross join lateral unnest(o.times) as t
    )
    select sl.* from slots sl
    where sl.scheduled_for <= p_now - p_grace
      and sl.scheduled_for > p_now - p_grace - interval '24 hours'
      and sl.day >= sl.starts_on and (sl.ends_on is null or sl.day <= sl.ends_on)
      and not exists (select 1 from public.med_administrations a
                      where a.order_id = sl.order_id and a.scheduled_for = sl.scheduled_for)
  loop
    insert into public.med_administrations (org_id, order_id, scheduled_for, status)
    values (v_row.org_id, v_row.order_id, v_row.scheduled_for, 'missed')
    on conflict (order_id, scheduled_for) do nothing
    returning id into v_id;

    if v_id is not null then
      v_count := v_count + 1;
      perform public.enqueue_notification(
        v_row.org_id,
        public.site_recipients(v_row.site_id, false, null),
        'dose_missed',
        jsonb_build_object('site_id', v_row.site_id, 'resident_id', v_row.resident_id,
                           'order_id', v_row.order_id, 'administration_id', v_id)
      );
      insert into public.audit_events (org_id, actor_id, action, entity_id, details)
      values (v_row.org_id, null, 'dose.missed', v_id, jsonb_build_object('order_id', v_row.order_id));
    end if;
  end loop;
  return v_count;
end;
$$;

-- The dispatcher claims a batch, sends it, then reports each result. SKIP
-- LOCKED lets two dispatcher runs overlap without sending anything twice.
create function public.claim_notifications(p_limit integer default 50)
returns table (
  id bigint,
  template public.notification_template,
  payload jsonb,
  attempts integer,
  recipient_id uuid,
  email text,
  phone_e164 text,
  push_enabled boolean,
  email_enabled boolean,
  sms_enabled boolean,
  push_tokens text[]
)
language sql security definer set search_path = '' as $$
  with claimed as (
    update public.notification_outbox o
    set status = 'sending', attempts = o.attempts + 1
    where o.id in (
      select id from public.notification_outbox
      where status = 'pending' and next_attempt_at <= now()
      order by id
      for update skip locked
      limit p_limit
    )
    returning o.*
  )
  select c.id, c.template, c.payload, c.attempts, c.recipient_id,
         p.email, p.phone_e164, p.push_enabled, p.email_enabled, p.sms_enabled,
         coalesce((select array_agg(t.token order by t.last_seen_at desc) from public.device_tokens t
                   where t.user_id = c.recipient_id), '{}')
  from claimed c
  join public.profiles p on p.user_id = c.recipient_id
  order by c.id
$$;

-- Failed sends retry with backoff (2, 4, 8, 16 minutes) and stop after five
-- attempts. A message that can never succeed (bad address) goes straight to
-- dead with p_retryable = false.
create function public.complete_notification(p_id bigint, p_ok boolean, p_error text default null, p_retryable boolean default true)
returns void
language sql security definer set search_path = '' as $$
  update public.notification_outbox
  set status = case
        when p_ok then 'sent'
        when not p_retryable or attempts >= 5 then 'dead'
        else 'pending'
      end::public.outbox_status,
      sent_at = case when p_ok then now() end,
      last_error = case when p_ok then null else left(p_error, 500) end,
      next_attempt_at = case when p_ok then next_attempt_at
                             else now() + make_interval(mins => power(2, attempts)::int) end
  where id = p_id and status = 'sending'
$$;

-- Expo reported the token as no longer registered (app removed).
create function public.forget_device_token(p_token text) returns void
language sql security definer set search_path = '' as $$
  delete from public.device_tokens where token = p_token
$$;

-- The summarize-handoff function records each AI draft request in the audit
-- trail as the signed-in user: which site and how many notes, never the text.
create function public.record_ai_handoff_request(p_site uuid, p_note_count integer) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  if not public.can_see_site(p_site) then
    raise exception 'FORBIDDEN';
  end if;
  select org_id into v_org from public.sites where id = p_site;
  if not (select ai_summaries_enabled from public.organizations where id = v_org) then
    raise exception 'AI_NOT_ENABLED';
  end if;
  perform public.log_event(v_org, 'ai.handoff_drafted', p_site, jsonb_build_object('note_count', p_note_count));
end;
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.my_role(uuid), public.has_role(uuid, public.staff_role[]), public.is_member(uuid),
  public.can_see_site_in(uuid, uuid), public.can_see_site(uuid), public.can_write_site(uuid), public.is_site_admin(uuid), public.my_profile(),
  public.create_organization(text), public.change_role(uuid, uuid, public.staff_role),
  public.remove_member(uuid, uuid), public.create_invitation(uuid, text, public.staff_role, uuid[]),
  public.accept_invitation(text),
  public.can_see_resident(uuid), public.can_write_resident(uuid),
  public.add_care_note(uuid, public.note_kind, text, timestamptz, uuid, uuid),
  public.record_dose(uuid, timestamptz, public.dose_status, text, uuid),
  public.due_doses(uuid, timestamptz, timestamptz),
  public.open_resident(uuid),
  public.handoff_notes(uuid, timestamptz, timestamptz),
  public.register_device(text, text),
  public.is_phi_free(jsonb),
  public.record_ai_handoff_request(uuid, integer)
  to authenticated;
grant execute on function
  public.log_event(uuid, text, uuid, jsonb),
  public.mark_missed_doses(timestamptz, interval),
  public.claim_notifications(integer),
  public.complete_notification(bigint, boolean, text, boolean),
  public.forget_device_token(text)
  to service_role;
