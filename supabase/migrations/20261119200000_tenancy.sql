-- Organizations, sites, staff and who can see what.
--
-- One Supabase project serves many care providers. Every row that belongs to
-- a provider carries org_id, and composite foreign keys make it impossible to
-- attach a row to a site or resident from another provider, even by mistake.
-- Row-level security then decides what each signed-in person can read.

create type public.staff_role as enum ('admin', 'nurse', 'caregiver', 'auditor');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 2 and 120),
  -- AI handoff drafts send care notes to OpenAI. They stay off until an admin
  -- records the date the provider's Business Associate Agreement was signed.
  ai_summaries_enabled boolean not null default false,
  ai_baa_signed_on date,
  created_at timestamptz not null default now(),
  constraint ai_requires_baa check (not ai_summaries_enabled or ai_baa_signed_on is not null)
);

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (length(btrim(name)) between 2 and 120),
  address text not null check (length(btrim(address)) between 5 and 300),
  timezone text not null default 'America/New_York',
  -- Written only by the geocode-site function. A site's address is the
  -- facility's, never a resident's, so it is not health information.
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  place_id text,
  geocoded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, name),
  unique (id, org_id)
);

create table public.memberships (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.staff_role not null,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

-- Caregivers see only the sites they are assigned to. Admins, nurses and
-- auditors see every site in their organization.
create table public.site_assignments (
  site_id uuid not null,
  org_id uuid not null,
  user_id uuid not null,
  primary key (site_id, user_id),
  foreign key (site_id, org_id) references public.sites (id, org_id) on delete cascade,
  foreign key (org_id, user_id) references public.memberships (org_id, user_id) on delete cascade
);
create index site_assignments_user_idx on public.site_assignments (user_id);

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  full_name text check (full_name is null or length(btrim(full_name)) between 1 and 120),
  email text,
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  push_enabled boolean not null default true,
  email_enabled boolean not null default true,
  -- SMS costs money per message and needs a phone number, so it is opt-in.
  sms_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id, email, full_name)
  values (new.id, lower(new.email), nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''));
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.validate_site_timezone() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'UNKNOWN_TIMEZONE: %', new.timezone;
  end if;
  return new;
end;
$$;
create trigger sites_validate_timezone before insert or update of timezone on public.sites
  for each row execute function public.validate_site_timezone();

-- ---------------------------------------------------------------------------
-- Access helpers. SECURITY DEFINER so policies can read memberships without
-- recursing into the memberships policy. Each one only ever answers for
-- auth.uid(), the caller.
-- ---------------------------------------------------------------------------

create function public.my_role(p_org uuid) returns public.staff_role
language sql stable security definer set search_path = '' as $$
  select role from public.memberships where org_id = p_org and user_id = auth.uid()
$$;

create function public.has_role(p_org uuid, variadic p_roles public.staff_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.my_role(p_org) = any (p_roles), false)
$$;

create function public.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.my_role(p_org) is not null
$$;

-- Takes the org as well as the site so the sites policy can check a row
-- that is still being inserted (and so not yet visible to a lookup).
create function public.can_see_site_in(p_site uuid, p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.has_role(p_org, 'admin', 'nurse', 'auditor')
      or (public.has_role(p_org, 'caregiver')
          and exists (select 1 from public.site_assignments a where a.site_id = p_site and a.user_id = auth.uid()))
$$;

create function public.can_see_site(p_site uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select public.can_see_site_in(s.id, s.org_id) from public.sites s where s.id = p_site), false)
$$;

-- For the geocode-site function: is the caller an admin of this site's organization?
create function public.is_site_admin(p_site uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select public.has_role(org_id, 'admin') from public.sites where id = p_site), false)
$$;

-- Auditors read; they never write care records.
create function public.can_write_site(p_site uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.sites s
    join public.memberships m on m.org_id = s.org_id and m.user_id = auth.uid()
    where s.id = p_site
      and (
        m.role in ('admin', 'nurse')
        or (m.role = 'caregiver'
            and exists (select 1 from public.site_assignments a where a.site_id = s.id and a.user_id = auth.uid()))
      )
  )
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.organizations enable row level security;
alter table public.sites enable row level security;
alter table public.memberships enable row level security;
alter table public.site_assignments enable row level security;
alter table public.profiles enable row level security;

revoke all on public.organizations, public.sites, public.memberships, public.site_assignments, public.profiles
  from anon, authenticated;

-- Organizations: members read; admins change the name and the AI settings.
grant select on public.organizations to authenticated;
grant update (name, ai_summaries_enabled, ai_baa_signed_on) on public.organizations to authenticated;
create policy organizations_read on public.organizations for select to authenticated
  using (public.is_member(id));
create policy organizations_admin_update on public.organizations for update to authenticated
  using (public.has_role(id, 'admin')) with check (public.has_role(id, 'admin'));

-- Sites: visible per can_see_site; admins add and edit them. Coordinates are
-- not in the column grant, so only the service role can write them.
grant select on public.sites to authenticated;
grant insert (org_id, name, address, timezone), update (name, address, timezone) on public.sites to authenticated;
create policy sites_read on public.sites for select to authenticated
  using (public.can_see_site_in(id, org_id));
create policy sites_admin_insert on public.sites for insert to authenticated
  with check (public.has_role(org_id, 'admin'));
create policy sites_admin_update on public.sites for update to authenticated
  using (public.has_role(org_id, 'admin')) with check (public.has_role(org_id, 'admin'));

-- Memberships: staff can see who else works in their organization. Changes go
-- through the functions below so the last admin can't be removed.
grant select on public.memberships to authenticated;
create policy memberships_read on public.memberships for select to authenticated
  using (public.is_member(org_id));

grant select, insert, delete on public.site_assignments to authenticated;
create policy site_assignments_read on public.site_assignments for select to authenticated
  using (public.is_member(org_id));
create policy site_assignments_admin_insert on public.site_assignments for insert to authenticated
  with check (public.has_role(org_id, 'admin'));
create policy site_assignments_admin_delete on public.site_assignments for delete to authenticated
  using (public.has_role(org_id, 'admin'));

-- Profiles: everyone in a shared organization sees names. Email and phone are
-- left out of the grant; people read their own through my_profile().
grant select (user_id, full_name) on public.profiles to authenticated;
grant update (full_name, phone_e164, push_enabled, email_enabled, sms_enabled) on public.profiles to authenticated;
create policy profiles_read on public.profiles for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.memberships mine
      join public.memberships theirs on theirs.org_id = mine.org_id
      where mine.user_id = auth.uid() and theirs.user_id = profiles.user_id
    )
  );
create policy profiles_own_update on public.profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create function public.my_profile() returns public.profiles
language sql stable security definer set search_path = '' as $$
  select * from public.profiles where user_id = auth.uid()
$$;

-- ---------------------------------------------------------------------------
-- Organization lifecycle
-- ---------------------------------------------------------------------------

create function public.create_organization(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  insert into public.organizations (name) values (p_name) returning id into v_org;
  insert into public.memberships (org_id, user_id, role) values (v_org, auth.uid(), 'admin');
  return v_org;
end;
$$;

create function public.change_role(p_org uuid, p_user uuid, p_role public.staff_role) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_role(p_org, 'admin') then
    raise exception 'FORBIDDEN';
  end if;
  if p_role <> 'admin'
     and (select role from public.memberships where org_id = p_org and user_id = p_user) = 'admin'
     and (select count(*) from public.memberships where org_id = p_org and role = 'admin') = 1 then
    raise exception 'LAST_ADMIN';
  end if;
  update public.memberships set role = p_role where org_id = p_org and user_id = p_user;
  if not found then
    raise exception 'NOT_A_MEMBER';
  end if;
end;
$$;

create function public.remove_member(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_role(p_org, 'admin') then
    raise exception 'FORBIDDEN';
  end if;
  if (select role from public.memberships where org_id = p_org and user_id = p_user) = 'admin'
     and (select count(*) from public.memberships where org_id = p_org and role = 'admin') = 1 then
    raise exception 'LAST_ADMIN';
  end if;
  delete from public.memberships where org_id = p_org and user_id = p_user;
end;
$$;

-- ---------------------------------------------------------------------------
-- Invitations. The raw token is returned once, to the invite-staff function,
-- which emails it. Only its SHA-256 hash is stored.
-- ---------------------------------------------------------------------------

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role public.staff_role not null,
  site_ids uuid[] not null default '{}',
  token_hash text not null unique,
  invited_by uuid not null references auth.users (id),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

alter table public.invitations enable row level security;
revoke all on public.invitations from anon, authenticated;
grant select (id, org_id, email, role, site_ids, expires_at, accepted_at, created_at) on public.invitations to authenticated;
create policy invitations_admin_read on public.invitations for select to authenticated
  using (public.has_role(org_id, 'admin'));

create function public.create_invitation(p_org uuid, p_email text, p_role public.staff_role, p_site_ids uuid[] default '{}')
returns table (invitation_id uuid, token text)
language plpgsql security definer set search_path = '' as $$
declare
  v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_id uuid;
begin
  if not public.has_role(p_org, 'admin') then
    raise exception 'FORBIDDEN';
  end if;
  if exists (select 1 from unnest(p_site_ids) s(id)
             where not exists (select 1 from public.sites where sites.id = s.id and sites.org_id = p_org)) then
    raise exception 'SITE_NOT_IN_ORGANIZATION';
  end if;
  insert into public.invitations (org_id, email, role, site_ids, token_hash, invited_by)
  values (p_org, lower(btrim(p_email)), p_role, p_site_ids, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), auth.uid())
  returning id into v_id;
  return query select v_id, v_token;
end;
$$;

create function public.accept_invitation(p_token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_invite public.invitations;
begin
  select * into v_invite from public.invitations
  where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
  for update;

  if v_invite.id is null then
    raise exception 'INVITATION_NOT_FOUND';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'INVITATION_ALREADY_USED';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'INVITATION_EXPIRED';
  end if;
  if lower(coalesce(auth.jwt() ->> 'email', '')) <> v_invite.email then
    raise exception 'INVITATION_EMAIL_MISMATCH';
  end if;

  insert into public.memberships (org_id, user_id, role)
  values (v_invite.org_id, auth.uid(), v_invite.role)
  on conflict (org_id, user_id) do update set role = excluded.role;

  insert into public.site_assignments (site_id, org_id, user_id)
  select unnest(v_invite.site_ids), v_invite.org_id, auth.uid()
  on conflict do nothing;

  update public.invitations set accepted_at = now(), accepted_by = auth.uid() where id = v_invite.id;
  return v_invite.org_id;
end;
$$;

-- Service role only: the geocode-site function writes coordinates here.
create function public.set_site_location(p_site uuid, p_lat double precision, p_lng double precision, p_place_id text)
returns void
language sql security definer set search_path = '' as $$
  update public.sites
  set latitude = p_lat, longitude = p_lng, place_id = p_place_id, geocoded_at = now()
  where id = p_site
$$;

-- Function privileges: nothing is callable unless granted here.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.my_role(uuid), public.has_role(uuid, public.staff_role[]), public.is_member(uuid),
  public.can_see_site_in(uuid, uuid), public.can_see_site(uuid), public.can_write_site(uuid), public.is_site_admin(uuid), public.my_profile(),
  public.create_organization(text), public.change_role(uuid, uuid, public.staff_role),
  public.remove_member(uuid, uuid), public.create_invitation(uuid, text, public.staff_role, uuid[]),
  public.accept_invitation(text)
  to authenticated;
grant execute on function public.set_site_location(uuid, double precision, double precision, text) to service_role;
