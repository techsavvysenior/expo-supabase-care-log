-- Residents, care notes, the medication record and the audit trail.
--
-- Clinical records are append-only. Nobody, including admins and the service
-- role, can edit or delete a note or a dose record. A mistake is fixed by
-- writing a correction that points at the original, so the history stays
-- readable in an inspection.

create type public.note_kind as enum ('observation', 'incident', 'handoff', 'correction');
create type public.dose_status as enum ('given', 'refused', 'held', 'missed');

create table public.residents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  site_id uuid not null,
  first_name text not null check (length(btrim(first_name)) between 1 and 80),
  last_name text not null check (length(btrim(last_name)) between 1 and 80),
  date_of_birth date not null check (date_of_birth > date '1900-01-01'),
  room text check (room is null or length(room) <= 20),
  admitted_on date not null default current_date,
  discharged_on date,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (site_id, org_id) references public.sites (id, org_id),
  check (discharged_on is null or discharged_on >= admitted_on)
);
create index residents_site_idx on public.residents (site_id);

create table public.care_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  resident_id uuid not null,
  author_id uuid not null references auth.users (id),
  kind public.note_kind not null,
  body text not null check (length(btrim(body)) between 1 and 4000),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  amends_note_id uuid references public.care_notes (id),
  -- Set by the app's offline queue. A retry with the same client_ref returns
  -- the note already written instead of creating a duplicate.
  client_ref uuid not null,
  unique (author_id, client_ref),
  foreign key (resident_id, org_id) references public.residents (id, org_id),
  check ((kind = 'correction') = (amends_note_id is not null)),
  -- Late entries are allowed (and visible as such); notes about the future are not.
  check (occurred_at <= created_at + interval '5 minutes')
);
create index care_notes_resident_idx on public.care_notes (resident_id, occurred_at desc);

create table public.med_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  resident_id uuid not null,
  drug_name text not null check (length(btrim(drug_name)) between 1 and 120),
  dose text not null check (length(btrim(dose)) between 1 and 60),
  route text not null check (route in ('oral', 'topical', 'inhaled', 'injection', 'sublingual', 'other')),
  -- Local times at the resident's site, e.g. {08:00,20:00}.
  times time[] not null check (cardinality(times) between 1 and 12),
  starts_on date not null,
  ends_on date,
  created_by uuid not null references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (resident_id, org_id) references public.residents (id, org_id),
  check (ends_on is null or ends_on >= starts_on)
);
create index med_orders_resident_idx on public.med_orders (resident_id);

create table public.med_administrations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  order_id uuid not null,
  scheduled_for timestamptz not null,
  status public.dose_status not null,
  reason text check (reason is null or length(btrim(reason)) between 3 and 500),
  recorded_by uuid references auth.users (id),
  recorded_at timestamptz not null default now(),
  client_ref uuid,
  unique (order_id, scheduled_for),
  unique (recorded_by, client_ref),
  foreign key (order_id, org_id) references public.med_orders (id, org_id),
  check (status not in ('refused', 'held') or reason is not null),
  -- Missed doses are written by the system job, never by a person.
  check ((status = 'missed') = (recorded_by is null))
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,
  actor_id uuid,
  action text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  entity_id uuid,
  -- Identifiers only. Never names, note text or anything clinical.
  details jsonb not null default '{}' check (jsonb_typeof(details) = 'object'),
  at timestamptz not null default now()
);
create index audit_events_org_idx on public.audit_events (org_id, at desc);

-- ---------------------------------------------------------------------------
-- Append-only enforcement. A trigger, not just missing grants, so it also
-- holds for the service role and the table owner.
-- ---------------------------------------------------------------------------

create function public.forbid_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'RECORDS_ARE_APPEND_ONLY: % on %', tg_op, tg_table_name;
end;
$$;

create trigger care_notes_append_only before update or delete on public.care_notes
  for each row execute function public.forbid_change();
create trigger med_administrations_append_only before update or delete on public.med_administrations
  for each row execute function public.forbid_change();
create trigger audit_events_append_only before update or delete on public.audit_events
  for each row execute function public.forbid_change();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function public.log_event(p_org uuid, p_action text, p_entity uuid, p_details jsonb default '{}')
returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_events (org_id, actor_id, action, entity_id, details)
  values (p_org, auth.uid(), p_action, p_entity, p_details)
$$;

create function public.can_see_resident(p_resident uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select public.can_see_site(site_id) from public.residents where id = p_resident), false)
$$;

create function public.can_write_resident(p_resident uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select public.can_write_site(site_id) from public.residents where id = p_resident), false)
$$;

create function public.site_timezone_for_order(p_order uuid) returns text
language sql stable security definer set search_path = '' as $$
  select s.timezone
  from public.med_orders o
  join public.residents r on r.id = o.resident_id
  join public.sites s on s.id = r.site_id
  where o.id = p_order
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.residents enable row level security;
alter table public.care_notes enable row level security;
alter table public.med_orders enable row level security;
alter table public.med_administrations enable row level security;
alter table public.audit_events enable row level security;

revoke all on public.residents, public.care_notes, public.med_orders, public.med_administrations, public.audit_events
  from anon, authenticated;

-- Residents: listed through the site rules. Admins and nurses admit residents
-- and update room, site and discharge date.
grant select on public.residents to authenticated;
grant insert (org_id, site_id, first_name, last_name, date_of_birth, room, admitted_on) on public.residents to authenticated;
grant update (site_id, room, discharged_on) on public.residents to authenticated;
create policy residents_read on public.residents for select to authenticated
  using (public.can_see_site(site_id));
create policy residents_clinical_insert on public.residents for insert to authenticated
  with check (public.has_role(org_id, 'admin', 'nurse'));
create policy residents_clinical_update on public.residents for update to authenticated
  using (public.has_role(org_id, 'admin', 'nurse')) with check (public.has_role(org_id, 'admin', 'nurse'));

-- Notes: read through the site rules. Written only through add_care_note().
grant select on public.care_notes to authenticated;
create policy care_notes_read on public.care_notes for select to authenticated
  using (public.can_see_resident(resident_id));

-- Medication orders: nurses and admins transcribe and discontinue them.
grant select on public.med_orders to authenticated;
grant insert (org_id, resident_id, drug_name, dose, route, times, starts_on, ends_on) on public.med_orders to authenticated;
grant update (ends_on) on public.med_orders to authenticated;
create policy med_orders_read on public.med_orders for select to authenticated
  using (public.can_see_resident(resident_id));
create policy med_orders_clinical_insert on public.med_orders for insert to authenticated
  with check (public.has_role(org_id, 'admin', 'nurse') and public.can_see_resident(resident_id));
create policy med_orders_clinical_update on public.med_orders for update to authenticated
  using (public.has_role(org_id, 'admin', 'nurse')) with check (public.has_role(org_id, 'admin', 'nurse'));

grant select on public.med_administrations to authenticated;
create policy med_administrations_read on public.med_administrations for select to authenticated
  using (exists (select 1 from public.med_orders o where o.id = order_id and public.can_see_resident(o.resident_id)));

-- Audit trail: admins and auditors only.
grant select on public.audit_events to authenticated;
create policy audit_events_read on public.audit_events for select to authenticated
  using (public.has_role(org_id, 'admin', 'auditor'));

-- ---------------------------------------------------------------------------
-- Write paths
-- ---------------------------------------------------------------------------

create function public.add_care_note(
  p_resident uuid,
  p_kind public.note_kind,
  p_body text,
  p_occurred_at timestamptz,
  p_client_ref uuid,
  p_amends uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_existing uuid;
  v_org uuid;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  select id into v_existing from public.care_notes where author_id = auth.uid() and client_ref = p_client_ref;
  if v_existing is not null then
    return v_existing;
  end if;

  if not public.can_write_resident(p_resident) then
    raise exception 'FORBIDDEN';
  end if;
  if p_amends is not null
     and not exists (select 1 from public.care_notes where id = p_amends and resident_id = p_resident) then
    raise exception 'AMENDED_NOTE_NOT_FOUND';
  end if;

  select org_id into v_org from public.residents where id = p_resident;
  insert into public.care_notes (org_id, resident_id, author_id, kind, body, occurred_at, amends_note_id, client_ref)
  values (v_org, p_resident, auth.uid(), p_kind, btrim(p_body), p_occurred_at, p_amends, p_client_ref)
  returning id into v_id;

  perform public.log_event(v_org, 'note.created', v_id, jsonb_build_object('kind', p_kind, 'resident_id', p_resident));
  return v_id;
end;
$$;

-- Records one scheduled dose. The rules:
--   * the order is active on the dose's local date and the time is one of its times
--   * nothing is recorded more than 60 minutes before the scheduled time
--   * refused and held need a reason
--   * missed is written only by mark_missed_doses()
--   * one record per dose; a retry with the same client_ref is a no-op
create function public.record_dose(
  p_order uuid,
  p_scheduled_for timestamptz,
  p_status public.dose_status,
  p_reason text,
  p_client_ref uuid
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_order public.med_orders;
  v_tz text;
  v_local timestamp;
  v_existing uuid;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  select id into v_existing from public.med_administrations where recorded_by = auth.uid() and client_ref = p_client_ref;
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_order from public.med_orders where id = p_order;
  if v_order.id is null or not public.can_write_resident(v_order.resident_id) then
    raise exception 'FORBIDDEN';
  end if;
  if p_status = 'missed' then
    raise exception 'MISSED_IS_SYSTEM_RECORDED';
  end if;
  if p_status in ('refused', 'held') and coalesce(length(btrim(p_reason)), 0) < 3 then
    raise exception 'REASON_REQUIRED';
  end if;

  v_tz := public.site_timezone_for_order(p_order);
  v_local := p_scheduled_for at time zone v_tz;
  if v_local::date < v_order.starts_on or (v_order.ends_on is not null and v_local::date > v_order.ends_on) then
    raise exception 'ORDER_NOT_ACTIVE';
  end if;
  if not (v_local::time = any (v_order.times)) then
    raise exception 'NOT_A_SCHEDULED_TIME';
  end if;
  if p_scheduled_for > now() + interval '60 minutes' then
    raise exception 'TOO_EARLY';
  end if;

  if exists (select 1 from public.med_administrations where order_id = p_order and scheduled_for = p_scheduled_for) then
    raise exception 'DOSE_ALREADY_RECORDED';
  end if;

  insert into public.med_administrations (org_id, order_id, scheduled_for, status, reason, recorded_by, client_ref)
  values (v_order.org_id, p_order, p_scheduled_for, p_status, nullif(btrim(p_reason), ''), auth.uid(), p_client_ref)
  returning id into v_id;

  perform public.log_event(v_order.org_id, 'dose.recorded', v_id,
    jsonb_build_object('status', p_status, 'order_id', p_order, 'resident_id', v_order.resident_id));
  return v_id;
end;
$$;

-- Doses scheduled at a site in a window, with what was recorded for each.
-- SECURITY INVOKER: row-level security limits it to what the caller can see.
create function public.due_doses(p_site uuid, p_from timestamptz, p_to timestamptz)
returns table (
  order_id uuid,
  resident_id uuid,
  drug_name text,
  dose text,
  route text,
  scheduled_for timestamptz,
  status public.dose_status,
  reason text
)
language sql stable security invoker set search_path = '' as $$
  with site as (
    select id, timezone from public.sites where id = p_site
  ),
  days as (
    select generate_series(
      ((p_from at time zone site.timezone)::date - 1)::timestamp,
      ((p_to at time zone site.timezone)::date + 1)::timestamp,
      interval '1 day'
    )::date as day, site.timezone
    from site
  ),
  slots as (
    select o.id as order_id, o.resident_id, o.drug_name, o.dose, o.route,
           ((d.day + t) at time zone d.timezone) as scheduled_for, d.day, o.starts_on, o.ends_on
    from public.med_orders o
    join public.residents r on r.id = o.resident_id and r.site_id = p_site and r.discharged_on is null
    cross join days d
    cross join lateral unnest(o.times) as t
  )
  select s.order_id, s.resident_id, s.drug_name, s.dose, s.route, s.scheduled_for, a.status, a.reason
  from slots s
  left join public.med_administrations a on a.order_id = s.order_id and a.scheduled_for = s.scheduled_for
  where s.scheduled_for >= p_from and s.scheduled_for < p_to
    and s.day >= s.starts_on and (s.ends_on is null or s.day <= s.ends_on)
  order by s.scheduled_for, s.drug_name
$$;

-- Opens one resident's record and writes a "viewed" entry to the audit trail.
-- The app uses this for the detail screen, so every chart opening is logged.
create function public.open_resident(p_resident uuid) returns public.residents
language plpgsql security definer set search_path = '' as $$
declare
  v_resident public.residents;
begin
  if not public.can_see_resident(p_resident) then
    raise exception 'FORBIDDEN';
  end if;
  select * into v_resident from public.residents where id = p_resident;
  perform public.log_event(v_resident.org_id, 'resident.viewed', p_resident);
  return v_resident;
end;
$$;

-- Notes for the AI handoff draft: one site, one shift window. INVOKER, so the
-- summarize-handoff function only ever sees what the signed-in user could.
create function public.handoff_notes(p_site uuid, p_from timestamptz, p_to timestamptz)
returns table (note_id uuid, resident_id uuid, first_name text, last_name text, kind public.note_kind, body text, occurred_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select n.id, r.id, r.first_name, r.last_name, n.kind, n.body, n.occurred_at
  from public.care_notes n
  join public.residents r on r.id = n.resident_id
  where r.site_id = p_site and n.occurred_at >= p_from and n.occurred_at < p_to
  order by n.occurred_at
$$;

create function public.log_resident_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.log_event(new.org_id,
    case when tg_op = 'INSERT' then 'resident.admitted' else 'resident.updated' end,
    new.id,
    jsonb_build_object('site_id', new.site_id));
  return new;
end;
$$;
create trigger residents_audit after insert or update on public.residents
  for each row execute function public.log_resident_change();

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
  public.handoff_notes(uuid, timestamptz, timestamptz)
  to authenticated;
grant execute on function public.log_event(uuid, text, uuid, jsonb) to service_role;
