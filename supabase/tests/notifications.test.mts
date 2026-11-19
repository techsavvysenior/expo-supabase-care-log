import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { buildWorld, PERMISSION_DENIED, queryAs, queryAsService, type World } from './harness.mts';

let w: World;

beforeEach(async () => {
  w = await buildWorld();
});

afterEach(async () => {
  await w.db.close();
});

const note = (user: string, resident: string, kind: string, body: string) =>
  queryAs<{ id: string }>(w.db, user, 'select public.add_care_note($1, $2, $3, now(), $4) as id', [resident, kind, body, randomUUID()]).then(
    (rows) => rows[0].id,
  );

type Outbox = { id: number; recipient_id: string; template: string; payload: Record<string, string>; status: string; attempts: number };
const outbox = () =>
  queryAsService<Outbox>(w.db, 'select id, recipient_id, template, payload, status, attempts from public.notification_outbox order by id');

describe('UC-12 notify staff without health information', () => {
  it('UC-12 tells nurses and admins about an incident, not the author', async () => {
    await note(w.nurse, w.ruth, 'incident', 'Ruth Baker slipped in the bathroom, no injury.');
    const rows = await outbox();
    assert.deepEqual(rows.map((r) => r.recipient_id), [w.admin]);
    assert.equal(rows[0].template, 'incident_reported');
  });

  it('UC-12 tells the caregivers assigned to the site about a handoff', async () => {
    await note(w.nurse, w.ruth, 'handoff', 'Night shift handoff.');
    const recipients = (await outbox()).map((r) => r.recipient_id).sort();
    assert.deepEqual(recipients, [w.admin, w.carer].sort());
  });

  it('UC-12 sends nothing for routine observations', async () => {
    await note(w.carer, w.ruth, 'observation', 'Watched TV after dinner.');
    assert.equal((await outbox()).length, 0);
  });

  it('UC-12 puts only identifiers in the payload, never the note or the name', async () => {
    await note(w.nurse, w.ruth, 'incident', 'Ruth Baker slipped in the bathroom.');
    const [row] = await outbox();
    assert.deepEqual(Object.keys(row.payload).sort(), ['note_id', 'resident_id', 'site_id']);
    assert.ok(!JSON.stringify(row.payload).match(/Ruth|Baker|bathroom/));
  });

  it('UC-12 rejects any payload that is not identifiers only', async () => {
    const [{ ok }] = await queryAs<{ ok: boolean }>(w.db, w.admin, "select public.is_phi_free('{\"resident_name\": \"Ruth\"}') as ok");
    assert.equal(ok, false);
    const [{ ok: notUuid }] = await queryAs<{ ok: boolean }>(w.db, w.admin, "select public.is_phi_free('{\"resident_id\": \"Ruth\"}') as ok");
    assert.equal(notUuid, false);
    await assert.rejects(
      queryAsService(
        w.db,
        "insert into public.notification_outbox (org_id, recipient_id, template, payload) values ($1, $2, 'incident_reported', '{\"note\": \"fell\"}')",
        [w.orgA, w.nurse],
      ),
      /check constraint/,
    );
  });

  it('UC-12 keeps the outbox away from signed-in users', async () => {
    await assert.rejects(queryAs(w.db, w.admin, 'select * from public.notification_outbox'), PERMISSION_DENIED);
    await assert.rejects(queryAs(w.db, w.admin, 'select * from public.claim_notifications(10)'), PERMISSION_DENIED);
  });

  it('UC-12 claims each message once, with contact details and devices', async () => {
    await queryAs(w.db, w.admin, "select public.register_device('ExponentPushToken[abc123]', 'ios')");
    await note(w.nurse, w.ruth, 'incident', 'Fall.');
    const claimed = await queryAsService<{ email: string; push_tokens: string[]; attempts: number }>(
      w.db,
      'select email, push_tokens, attempts from public.claim_notifications(10)',
    );
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].email, 'ada@a.example');
    assert.deepEqual(claimed[0].push_tokens, ['ExponentPushToken[abc123]']);
    assert.equal(claimed[0].attempts, 1);
    const again = await queryAsService(w.db, 'select * from public.claim_notifications(10)');
    assert.equal(again.length, 0);
  });

  it('UC-12 retries a failed send with backoff and gives up after five attempts', async () => {
    await note(w.nurse, w.ruth, 'incident', 'Fall.');
    const [{ id }] = await outbox();
    for (let attempt = 1; attempt <= 5; attempt++) {
      await w.db.query('update public.notification_outbox set next_attempt_at = now() where id = $1', [id]);
      await queryAsService(w.db, 'select * from public.claim_notifications(10)');
      await queryAsService(w.db, "select public.complete_notification($1, false, 'timeout')", [id]);
    }
    const [row] = await outbox();
    assert.equal(row.status, 'dead');
    assert.equal(row.attempts, 5);
  });

  it('UC-12 marks a permanent failure dead at once', async () => {
    await note(w.nurse, w.ruth, 'incident', 'Fall.');
    await queryAsService(w.db, 'select * from public.claim_notifications(10)');
    const [{ id }] = await outbox();
    await queryAsService(w.db, "select public.complete_notification($1, false, 'invalid number', false)", [id]);
    assert.equal((await outbox())[0].status, 'dead');
  });

  it('UC-12 moves a device to whoever signs in on it, and forgets dead tokens', async () => {
    const token = 'ExponentPushToken[shared1]';
    await queryAs(w.db, w.carer, 'select public.register_device($1, $2)', [token, 'android']);
    await queryAs(w.db, w.nurse, 'select public.register_device($1, $2)', [token, 'android']);
    assert.equal((await queryAs(w.db, w.carer, 'select token from public.device_tokens')).length, 0);
    assert.equal((await queryAs(w.db, w.nurse, 'select token from public.device_tokens')).length, 1);
    await queryAsService(w.db, 'select public.forget_device_token($1)', [token]);
    assert.equal((await queryAs(w.db, w.nurse, 'select token from public.device_tokens')).length, 0);
  });

  it('UC-12 rejects something that is not an Expo push token', async () => {
    await assert.rejects(queryAs(w.db, w.carer, "select public.register_device('not-a-token', 'ios')"), /device_tokens_token_check|check constraint/);
  });
});

describe('UC-13 AI handoff draft input', () => {
  it('UC-13 gives the handoff function only notes the caller can see', async () => {
    await note(w.carer, w.ruth, 'observation', 'Maple note.');
    await note(w.nurse, w.sam, 'observation', 'Cedar note.');
    const mine = await queryAs<{ body: string }>(
      w.db,
      w.carer,
      "select body from public.handoff_notes($1, now() - interval '1 hour', now() + interval '1 hour')",
      [w.maple],
    );
    assert.deepEqual(mine.map((n) => n.body), ['Maple note.']);
    const notMine = await queryAs(
      w.db,
      w.carer,
      "select body from public.handoff_notes($1, now() - interval '1 hour', now() + interval '1 hour')",
      [w.cedar],
    );
    assert.equal(notMine.length, 0);
  });

  it('UC-13 audits each AI draft request as the person who asked', async () => {
    await w.db.query("update public.organizations set ai_baa_signed_on = '2026-11-01', ai_summaries_enabled = true where id = $1", [w.orgA]);
    await queryAs(w.db, w.carer, 'select public.record_ai_handoff_request($1, 3)', [w.maple]);
    const rows = await queryAs<{ actor_id: string; details: { note_count: number } }>(
      w.db,
      w.auditor,
      "select actor_id, details from public.audit_events where action = 'ai.handoff_drafted'",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_id, w.carer);
    assert.equal(rows[0].details.note_count, 3);
  });

  it('UC-13 refuses AI drafts when the provider has not enabled them, or for unseen sites', async () => {
    await assert.rejects(queryAs(w.db, w.carer, 'select public.record_ai_handoff_request($1, 1)', [w.maple]), /AI_NOT_ENABLED/);
    await w.db.query("update public.organizations set ai_baa_signed_on = '2026-11-01', ai_summaries_enabled = true where id = $1", [w.orgA]);
    await assert.rejects(queryAs(w.db, w.carer, 'select public.record_ai_handoff_request($1, 1)', [w.cedar]), /FORBIDDEN/);
  });

  it('UC-13 keeps the raw audit writer for the service role only', async () => {
    await assert.rejects(queryAs(w.db, w.admin, "select public.log_event($1, 'ai.handoff_drafted', null)", [w.orgA]), PERMISSION_DENIED);
  });
});
