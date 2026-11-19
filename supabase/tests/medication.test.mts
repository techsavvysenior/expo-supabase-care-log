import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { buildWorld, PERMISSION_DENIED, queryAs, queryAsService, type World } from './harness.mts';

const TZ = 'America/New_York';

let w: World;

beforeEach(async () => {
  w = await buildWorld();
});

afterEach(async () => {
  await w.db.close();
});

/**
 * A dose slot `offsetMinutes` from now, as the site's local time of day and
 * the matching instant. Built in SQL so it is correct across midnight and
 * daylight saving changes.
 */
async function slot(offsetMinutes: number): Promise<{ time: string; at: string }> {
  const { rows } = await w.db.query<{ time: string; at: Date }>(
    `with l as (select date_trunc('minute', (now() at time zone $1) + make_interval(mins => $2)) as local)
     select to_char(local, 'HH24:MI') as time, local at time zone $1 as at from l`,
    [TZ, offsetMinutes],
  );
  return { time: rows[0].time, at: rows[0].at.toISOString() };
}

async function order(times: string[], resident = w.ruth, by = w.nurse): Promise<string> {
  const [{ id }] = await queryAs<{ id: string }>(
    w.db,
    by,
    `insert into public.med_orders (org_id, resident_id, drug_name, dose, route, times, starts_on)
     values ($1, $2, 'Metformin', '500 mg', 'oral', $3::time[], current_date - 7) returning id`,
    [w.orgA, resident, times],
  );
  return id;
}

const record = (user: string, orderId: string, at: string, status: string, reason: string | null = null, ref = randomUUID()) =>
  queryAs<{ id: string }>(w.db, user, 'select public.record_dose($1, $2, $3, $4, $5) as id', [orderId, at, status, reason, ref]).then(
    (rows) => rows[0].id,
  );

describe('UC-09 see doses due', () => {
  it('UC-09 lists each scheduled time in the window with what was recorded', async () => {
    const past = await slot(-90);
    const soon = await slot(30);
    const id = await order([past.time, soon.time]);
    await record(w.carer, id, past.at, 'given');

    const rows = await queryAs<{ scheduled_for: Date; status: string | null }>(
      w.db,
      w.carer,
      "select scheduled_for, status from public.due_doses($1, now() - interval '2 hours', now() + interval '2 hours')",
      [w.maple],
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].scheduled_for.toISOString(), new Date(past.at).toISOString());
    assert.equal(rows[0].status, 'given');
    assert.equal(rows[1].status, null);
  });

  it('UC-09 shows nothing for a site the caller cannot see', async () => {
    const soon = await slot(30);
    await order([soon.time], w.sam);
    const rows = await queryAs(w.db, w.carer, "select * from public.due_doses($1, now() - interval '2 hours', now() + interval '2 hours')", [
      w.cedar,
    ]);
    assert.equal(rows.length, 0);
  });

  it('UC-09 lets only nurses and admins enter medication orders', async () => {
    const soon = await slot(30);
    await assert.rejects(order([soon.time], w.ruth, w.carer), /row-level security/);
  });
});

describe('UC-10 record a dose', () => {
  it('UC-10 records a given dose and audits it', async () => {
    const now = await slot(-10);
    const id = await order([now.time]);
    const doseId = await record(w.carer, id, now.at, 'given');
    const events = await queryAs<{ details: { status: string } }>(w.db, w.admin, "select details from public.audit_events where action = 'dose.recorded' and entity_id = $1", [doseId]);
    assert.equal(events[0].details.status, 'given');
  });

  it('UC-10 needs a reason for a refused or held dose', async () => {
    const now = await slot(-10);
    const id = await order([now.time]);
    await assert.rejects(record(w.carer, id, now.at, 'refused'), /REASON_REQUIRED/);
    await record(w.carer, id, now.at, 'refused', 'Resident declined, said she felt nauseous');
  });

  it('UC-10 refuses a second record for the same dose', async () => {
    const now = await slot(-10);
    const id = await order([now.time]);
    await record(w.carer, id, now.at, 'given');
    await assert.rejects(record(w.nurse, id, now.at, 'given'), /DOSE_ALREADY_RECORDED/);
  });

  it('UC-10 treats an offline retry as the same record', async () => {
    const now = await slot(-10);
    const id = await order([now.time]);
    const ref = randomUUID();
    const first = await record(w.carer, id, now.at, 'given', null, ref);
    const again = await record(w.carer, id, now.at, 'given', null, ref);
    assert.equal(again, first);
  });

  it('UC-10 refuses a time that is not on the order', async () => {
    const now = await slot(-10);
    const other = await slot(-20);
    const id = await order([now.time]);
    await assert.rejects(record(w.carer, id, other.at, 'given'), /NOT_A_SCHEDULED_TIME/);
  });

  it('UC-10 refuses a dose more than an hour early', async () => {
    const later = await slot(120);
    const id = await order([later.time]);
    await assert.rejects(record(w.carer, id, later.at, 'given'), /TOO_EARLY/);
  });

  it('UC-10 refuses a dose after the order ended', async () => {
    const now = await slot(-10);
    const id = await order([now.time]);
    await queryAs(w.db, w.nurse, "update public.med_orders set ends_on = current_date - 1 where id = $1", [id]);
    await assert.rejects(record(w.carer, id, now.at, 'given'), /ORDER_NOT_ACTIVE/);
  });

  it('UC-10 keeps missed for the system and auditors out of the record', async () => {
    const now = await slot(-10);
    const id = await order([now.time]);
    await assert.rejects(record(w.nurse, id, now.at, 'missed'), /MISSED_IS_SYSTEM_RECORDED/);
    await assert.rejects(record(w.auditor, id, now.at, 'given'), /FORBIDDEN/);
  });

  it('UC-10 keeps dose records append-only', async () => {
    const now = await slot(-10);
    const id = await order([now.time]);
    const doseId = await record(w.carer, id, now.at, 'given');
    await assert.rejects(queryAs(w.db, w.admin, "update public.med_administrations set status = 'held' where id = $1", [doseId]), PERMISSION_DENIED);
    await assert.rejects(queryAsService(w.db, 'delete from public.med_administrations where id = $1', [doseId]), /RECORDS_ARE_APPEND_ONLY/);
  });
});

describe('UC-11 mark missed doses', () => {
  it('UC-11 marks a dose missed after the grace period and alerts nurses and admins', async () => {
    const late = await slot(-90);
    const id = await order([late.time]);
    const [{ count }] = await queryAsService<{ count: number }>(w.db, 'select public.mark_missed_doses() as count');
    assert.equal(count, 1);

    const rows = await queryAs<{ status: string }>(w.db, w.nurse, 'select status from public.med_administrations where order_id = $1', [id]);
    assert.deepEqual(rows.map((r) => r.status), ['missed']);

    const outbox = await queryAsService<{ recipient_id: string; template: string }>(
      w.db,
      "select recipient_id, template from public.notification_outbox where template = 'dose_missed' order by recipient_id",
    );
    assert.deepEqual(outbox.map((o) => o.recipient_id).sort(), [w.admin, w.nurse].sort());
  });

  it('UC-11 leaves recorded doses and doses inside the grace period alone', async () => {
    const recent = await slot(-30);
    const done = await slot(-120);
    const id = await order([recent.time, done.time]);
    await record(w.carer, id, done.at, 'given');
    await queryAsService(w.db, 'select public.mark_missed_doses()');
    // Yesterday's slots of this week-old order may be marked missed; these two must not be.
    const rows = await queryAs<{ scheduled_for: Date; status: string }>(
      w.db,
      w.nurse,
      'select scheduled_for, status from public.med_administrations where order_id = $1 and scheduled_for = any($2::timestamptz[])',
      [id, [recent.at, done.at]],
    );
    assert.deepEqual(rows.map((r) => [r.scheduled_for.toISOString(), r.status]), [[new Date(done.at).toISOString(), 'given']]);
  });

  it('UC-11 is safe to run twice', async () => {
    const late = await slot(-90);
    await order([late.time]);
    await queryAsService(w.db, 'select public.mark_missed_doses()');
    const [{ count }] = await queryAsService<{ count: number }>(w.db, 'select public.mark_missed_doses() as count');
    assert.equal(count, 0);
  });

  it('UC-11 cannot be run by a signed-in user', async () => {
    await assert.rejects(queryAs(w.db, w.admin, 'select public.mark_missed_doses()'), PERMISSION_DENIED);
  });
});
