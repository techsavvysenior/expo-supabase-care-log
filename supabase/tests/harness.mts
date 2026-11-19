import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite, type Transaction } from '@electric-sql/pglite';

/**
 * Real Postgres, in process, so policies, triggers and functions are tested
 * as SQL rather than mocked.
 *
 * This recreates the parts of a Supabase project the migrations depend on:
 * the API roles, the `auth` schema, `auth.uid()` and `auth.jwt()` reading the
 * request claims, and Supabase's broad default grants, which the migrations
 * then narrow.
 */
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb not null default '{}'
  );
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  $$;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(auth.jwt() ->> 'sub', '')::uuid
  $$;

  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

export async function createDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return db;
}

/** Signs a user up the way Supabase Auth would. */
export async function signUp(db: PGlite, email: string, fullName?: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id',
    [email, JSON.stringify(fullName ? { full_name: fullName } : {})],
  );
  return rows[0].id;
}

async function emailOf(db: PGlite, userId: string): Promise<string> {
  const { rows } = await db.query<{ email: string }>('select email from auth.users where id = $1', [userId]);
  return rows[0].email;
}

/** Runs `work` as a signed-in user reaching the database through the API. */
export async function asUser<T>(db: PGlite, userId: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
  const claims = { sub: userId, role: 'authenticated', aud: 'authenticated', email: await emailOf(db, userId) };
  return db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    return work(tx);
  }) as Promise<T>;
}

/** Runs `work` as an Edge Function or cron job using the service role. */
export function asService<T>(db: PGlite, work: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec('set local role service_role');
    return work(tx);
  }) as Promise<T>;
}

export function asAnonymous<T>(db: PGlite, work: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec('set local role anon');
    return work(tx);
  }) as Promise<T>;
}

/** Runs one query as `userId` and returns its rows. */
export async function queryAs<T>(db: PGlite, userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, userId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

/** Runs one query as the service role and returns its rows. */
export async function queryAsService<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
}

export type World = {
  db: PGlite;
  orgA: string;
  orgB: string;
  maple: string; // site in org A
  cedar: string; // second site in org A
  harbor: string; // site in org B
  admin: string;
  nurse: string;
  carer: string; // caregiver assigned to Maple only
  auditor: string;
  outsider: string; // admin of org B
  ruth: string; // resident at Maple
  sam: string; // resident at Cedar
  otto: string; // resident at Harbor (org B)
};

/**
 * Two care providers. Provider A has two houses, Maple and Cedar, and four
 * staff roles. Provider B has one house. Every isolation test starts here.
 */
export async function buildWorld(): Promise<World> {
  const db = await createDatabase();
  const admin = await signUp(db, 'ada@a.example', 'Ada Admin');
  const nurse = await signUp(db, 'nia@a.example', 'Nia Nurse');
  const carer = await signUp(db, 'cal@a.example', 'Cal Carer');
  const auditor = await signUp(db, 'aud@a.example', 'Audrey Auditor');
  const outsider = await signUp(db, 'bob@b.example', 'Bob Other');

  const [{ id: orgA }] = await queryAs<{ id: string }>(db, admin, "select public.create_organization('Provider A') as id");
  const [{ id: orgB }] = await queryAs<{ id: string }>(db, outsider, "select public.create_organization('Provider B') as id");

  const site = async (userId: string, org: string, name: string) =>
    (
      await queryAs<{ id: string }>(
        db,
        userId,
        "insert into public.sites (org_id, name, address, timezone) values ($1, $2, '1 Main St, Springfield, VA', 'America/New_York') returning id",
        [org, name],
      )
    )[0].id;
  const maple = await site(admin, orgA, 'Maple House');
  const cedar = await site(admin, orgA, 'Cedar House');
  const harbor = await site(outsider, orgB, 'Harbor House');

  await db.query(
    `insert into public.memberships (org_id, user_id, role) values ($1, $2, 'nurse'), ($1, $3, 'caregiver'), ($1, $4, 'auditor')`,
    [orgA, nurse, carer, auditor],
  );
  await db.query('insert into public.site_assignments (site_id, org_id, user_id) values ($1, $2, $3)', [maple, orgA, carer]);

  const resident = async (userId: string, org: string, siteId: string, first: string, last: string) =>
    (
      await queryAs<{ id: string }>(
        db,
        userId,
        `insert into public.residents (org_id, site_id, first_name, last_name, date_of_birth, room)
         values ($1, $2, $3, $4, '1940-05-01', '12') returning id`,
        [org, siteId, first, last],
      )
    )[0].id;
  const ruth = await resident(nurse, orgA, maple, 'Ruth', 'Baker');
  const sam = await resident(nurse, orgA, cedar, 'Sam', 'Cole');
  const otto = await resident(outsider, orgB, harbor, 'Otto', 'Diaz');

  return { db, orgA, orgB, maple, cedar, harbor, admin, nurse, carer, auditor, outsider, ruth, sam, otto };
}

export const PERMISSION_DENIED = /permission denied/;
