import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  asAnonymous,
  buildWorld,
  PERMISSION_DENIED,
  queryAs,
  queryAsService,
  signUp,
  type World,
} from './harness.mts';

let w: World;

beforeEach(async () => {
  w = await buildWorld();
});

afterEach(async () => {
  await w.db.close();
});

describe('UC-01 create a care organization', () => {
  it('UC-01 makes the creator its first admin', async () => {
    const founder = await signUp(w.db, 'fay@c.example');
    const [{ id }] = await queryAs<{ id: string }>(w.db, founder, "select public.create_organization('Provider C') as id");
    const [{ role }] = await queryAs<{ role: string }>(w.db, founder, 'select public.my_role($1) as role', [id]);
    assert.equal(role, 'admin');
  });

  it('UC-01 does not let anyone insert an organization directly', async () => {
    await assert.rejects(
      queryAs(w.db, w.admin, "insert into public.organizations (name) values ('Sneaky')"),
      PERMISSION_DENIED,
    );
  });

  it('UC-01 refuses AI summaries until a BAA date is recorded', async () => {
    await assert.rejects(
      queryAs(w.db, w.admin, 'update public.organizations set ai_summaries_enabled = true where id = $1', [w.orgA]),
      /ai_requires_baa/,
    );
    await queryAs(
      w.db,
      w.admin,
      "update public.organizations set ai_baa_signed_on = '2026-11-01', ai_summaries_enabled = true where id = $1",
      [w.orgA],
    );
    const [org] = await queryAs<{ ai_summaries_enabled: boolean }>(
      w.db,
      w.nurse,
      'select ai_summaries_enabled from public.organizations where id = $1',
      [w.orgA],
    );
    assert.equal(org.ai_summaries_enabled, true);
  });

  it('UC-01 lets only admins change organization settings', async () => {
    const rows = await queryAs(w.db, w.nurse, "update public.organizations set name = 'Renamed' where id = $1 returning id", [w.orgA]);
    assert.equal(rows.length, 0);
  });
});

describe('UC-03 keep each provider separate', () => {
  it('UC-03 hides the other provider and its sites', async () => {
    const orgs = await queryAs<{ name: string }>(w.db, w.admin, 'select name from public.organizations');
    assert.deepEqual(orgs.map((o) => o.name), ['Provider A']);
    const sites = await queryAs<{ name: string }>(w.db, w.outsider, 'select name from public.sites');
    assert.deepEqual(sites.map((s) => s.name), ['Harbor House']);
  });

  it('UC-03 hides other providers residents from every role', async () => {
    for (const user of [w.admin, w.nurse, w.carer, w.auditor]) {
      const rows = await queryAs(w.db, user, 'select id from public.residents where id = $1', [w.otto]);
      assert.equal(rows.length, 0);
    }
  });

  it('UC-03 cannot attach a resident to another providers site', async () => {
    await assert.rejects(
      queryAs(
        w.db,
        w.nurse,
        "insert into public.residents (org_id, site_id, first_name, last_name, date_of_birth) values ($1, $2, 'X', 'Y', '1950-01-01')",
        [w.orgA, w.harbor],
      ),
      /foreign key|violates/,
    );
  });

  it('UC-03 cannot create a site inside another provider', async () => {
    await assert.rejects(
      queryAs(w.db, w.admin, "insert into public.sites (org_id, name, address) values ($1, 'Inside B', '2 Side St, Town')", [w.orgB]),
      /row-level security/,
    );
  });

  it('UC-03 gives anonymous callers nothing', async () => {
    await assert.rejects(
      asAnonymous(w.db, (tx) => tx.query('select * from public.residents')),
      PERMISSION_DENIED,
    );
  });

  it('UC-03 shows staff names but not emails or phone numbers', async () => {
    const names = await queryAs<{ full_name: string }>(w.db, w.carer, 'select full_name from public.profiles order by full_name');
    assert.deepEqual(names.map((n) => n.full_name), ['Ada Admin', 'Audrey Auditor', 'Cal Carer', 'Nia Nurse']);
    await assert.rejects(queryAs(w.db, w.carer, 'select email from public.profiles'), PERMISSION_DENIED);
    const [mine] = await queryAs<{ email: string }>(w.db, w.carer, 'select email from public.my_profile()');
    assert.equal(mine.email, 'cal@a.example');
  });
});

describe('UC-04 caregivers see only their sites', () => {
  it('UC-04 shows a caregiver only the assigned house', async () => {
    const sites = await queryAs<{ name: string }>(w.db, w.carer, 'select name from public.sites');
    assert.deepEqual(sites.map((s) => s.name), ['Maple House']);
    const residents = await queryAs<{ id: string }>(w.db, w.carer, 'select id from public.residents');
    assert.deepEqual(residents.map((r) => r.id), [w.ruth]);
  });

  it('UC-04 shows nurses and auditors every house in their provider', async () => {
    for (const user of [w.nurse, w.auditor]) {
      const residents = await queryAs(w.db, user, 'select id from public.residents');
      assert.equal(residents.length, 2);
    }
  });

  it('UC-04 updates access as soon as an admin assigns a site', async () => {
    await queryAs(w.db, w.admin, 'insert into public.site_assignments (site_id, org_id, user_id) values ($1, $2, $3)', [
      w.cedar,
      w.orgA,
      w.carer,
    ]);
    const residents = await queryAs(w.db, w.carer, 'select id from public.residents');
    assert.equal(residents.length, 2);
  });

  it('UC-04 does not let a caregiver assign themselves', async () => {
    await assert.rejects(
      queryAs(w.db, w.carer, 'insert into public.site_assignments (site_id, org_id, user_id) values ($1, $2, $3)', [
        w.cedar,
        w.orgA,
        w.carer,
      ]),
      /row-level security/,
    );
  });
});

describe('UC-02 invite staff', () => {
  const invite = (email: string, role = 'caregiver', sites: string[] = []) =>
    queryAs<{ invitation_id: string; token: string }>(w.db, w.admin, 'select * from public.create_invitation($1, $2, $3, $4)', [
      w.orgA,
      email,
      role,
      sites,
    ]).then((rows) => rows[0]);

  it('UC-02 stores only a hash of the token', async () => {
    const { invitation_id, token } = await invite('new@a.example');
    assert.match(token, /^[0-9a-f]{64}$/);
    const [row] = await queryAsService<{ token_hash: string }>(w.db, 'select token_hash from public.invitations where id = $1', [
      invitation_id,
    ]);
    assert.notEqual(row.token_hash, token);
    await assert.rejects(queryAs(w.db, w.admin, 'select token_hash from public.invitations'), PERMISSION_DENIED);
  });

  it('UC-02 joins the invitee with the role and sites chosen', async () => {
    const { token } = await invite('new@a.example', 'caregiver', [w.cedar]);
    const newbie = await signUp(w.db, 'new@a.example');
    const [{ org }] = await queryAs<{ org: string }>(w.db, newbie, 'select public.accept_invitation($1) as org', [token]);
    assert.equal(org, w.orgA);
    const residents = await queryAs<{ id: string }>(w.db, newbie, 'select id from public.residents');
    assert.deepEqual(residents.map((r) => r.id), [w.sam]);
  });

  it('UC-02 refuses a token used by someone with a different email', async () => {
    const { token } = await invite('new@a.example');
    const stranger = await signUp(w.db, 'other@x.example');
    await assert.rejects(queryAs(w.db, stranger, 'select public.accept_invitation($1)', [token]), /INVITATION_EMAIL_MISMATCH/);
  });

  it('UC-02 refuses a token twice', async () => {
    const { token } = await invite('new@a.example');
    const newbie = await signUp(w.db, 'new@a.example');
    await queryAs(w.db, newbie, 'select public.accept_invitation($1)', [token]);
    await assert.rejects(queryAs(w.db, newbie, 'select public.accept_invitation($1)', [token]), /INVITATION_ALREADY_USED/);
  });

  it('UC-02 refuses an expired token', async () => {
    const { invitation_id, token } = await invite('new@a.example');
    await w.db.query("update public.invitations set expires_at = now() - interval '1 minute' where id = $1", [invitation_id]);
    const newbie = await signUp(w.db, 'new@a.example');
    await assert.rejects(queryAs(w.db, newbie, 'select public.accept_invitation($1)', [token]), /INVITATION_EXPIRED/);
  });

  it('UC-02 lets only admins invite, and only to their own sites', async () => {
    await assert.rejects(
      queryAs(w.db, w.nurse, "select * from public.create_invitation($1, 'x@a.example', 'caregiver')", [w.orgA]),
      /FORBIDDEN/,
    );
    await assert.rejects(invite('x@a.example', 'caregiver', [w.harbor]), /SITE_NOT_IN_ORGANIZATION/);
  });
});

describe('UC-17 manage roles safely', () => {
  it('UC-17 lets an admin promote a nurse', async () => {
    await queryAs(w.db, w.admin, "select public.change_role($1, $2, 'admin')", [w.orgA, w.nurse]);
    const [{ role }] = await queryAs<{ role: string }>(w.db, w.nurse, 'select public.my_role($1) as role', [w.orgA]);
    assert.equal(role, 'admin');
  });

  it('UC-17 never leaves a provider without an admin', async () => {
    await assert.rejects(queryAs(w.db, w.admin, "select public.change_role($1, $2, 'nurse')", [w.orgA, w.admin]), /LAST_ADMIN/);
    await assert.rejects(queryAs(w.db, w.admin, 'select public.remove_member($1, $2)', [w.orgA, w.admin]), /LAST_ADMIN/);
  });

  it('UC-17 does not let non-admins change roles', async () => {
    await assert.rejects(queryAs(w.db, w.nurse, "select public.change_role($1, $2, 'admin')", [w.orgA, w.nurse]), /FORBIDDEN/);
  });

  it('UC-17 cuts off access the moment someone is removed', async () => {
    await queryAs(w.db, w.admin, 'select public.remove_member($1, $2)', [w.orgA, w.carer]);
    const residents = await queryAs(w.db, w.carer, 'select id from public.residents');
    assert.equal(residents.length, 0);
  });
});

describe('UC-14 site locations', () => {
  it('UC-14 lets only the service role write coordinates', async () => {
    await assert.rejects(
      queryAs(w.db, w.admin, 'update public.sites set latitude = 1 where id = $1', [w.maple]),
      PERMISSION_DENIED,
    );
    await assert.rejects(
      queryAs(w.db, w.admin, "select public.set_site_location($1, 38.9, -77.6, 'abc')", [w.maple]),
      PERMISSION_DENIED,
    );
    await queryAsService(w.db, "select public.set_site_location($1, 38.94, -77.63, 'place-1')", [w.maple]);
    const [site] = await queryAs<{ latitude: number; place_id: string }>(
      w.db,
      w.carer,
      'select latitude, place_id from public.sites where id = $1',
      [w.maple],
    );
    assert.equal(site.latitude, 38.94);
    assert.equal(site.place_id, 'place-1');
  });

  it('UC-14 tells the geocode function who is an admin of a site', async () => {
    const check = (user: string, site: string) =>
      queryAs<{ ok: boolean }>(w.db, user, 'select public.is_site_admin($1) as ok', [site]).then((r) => r[0].ok);
    assert.equal(await check(w.admin, w.maple), true);
    assert.equal(await check(w.nurse, w.maple), false);
    assert.equal(await check(w.admin, w.harbor), false);
  });

  it('UC-14 rejects an unknown time zone', async () => {
    await assert.rejects(
      queryAs(w.db, w.admin, "update public.sites set timezone = 'Mars/Olympus' where id = $1", [w.maple]),
      /UNKNOWN_TIMEZONE/,
    );
  });
});
