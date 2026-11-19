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

const addNote = (
  userId: string,
  resident: string,
  kind: string,
  body: string,
  clientRef: string = randomUUID(),
  amends: string | null = null,
  occurredAt = 'now()',
) =>
  queryAs<{ id: string }>(
    w.db,
    userId,
    `select public.add_care_note($1, $2, $3, ${occurredAt}, $4, $5) as id`,
    [resident, kind, body, clientRef, amends],
  ).then((rows) => rows[0].id);

describe('UC-05 admit a resident', () => {
  it('UC-05 lets nurses and admins admit residents', async () => {
    const rows = await queryAs<{ id: string }>(
      w.db,
      w.admin,
      "insert into public.residents (org_id, site_id, first_name, last_name, date_of_birth) values ($1, $2, 'Iris', 'Moss', '1938-02-11') returning id",
      [w.orgA, w.maple],
    );
    assert.equal(rows.length, 1);
  });

  it('UC-05 does not let caregivers or auditors admit residents', async () => {
    for (const user of [w.carer, w.auditor]) {
      await assert.rejects(
        queryAs(
          w.db,
          user,
          "insert into public.residents (org_id, site_id, first_name, last_name, date_of_birth) values ($1, $2, 'Iris', 'Moss', '1938-02-11')",
          [w.orgA, w.maple],
        ),
        /row-level security/,
      );
    }
  });

  it('UC-05 writes admissions to the audit trail without the residents name', async () => {
    const events = await queryAs<{ action: string; details: Record<string, string> }>(
      w.db,
      w.auditor,
      "select action, details from public.audit_events where action = 'resident.admitted' and entity_id = $1",
      [w.ruth],
    );
    assert.equal(events.length, 1);
    assert.deepEqual(Object.keys(events[0].details), ['site_id']);
  });
});

describe('UC-06 open a resident record', () => {
  it('UC-06 logs every opening of a record', async () => {
    await queryAs(w.db, w.carer, 'select * from public.open_resident($1)', [w.ruth]);
    await queryAs(w.db, w.carer, 'select * from public.open_resident($1)', [w.ruth]);
    const events = await queryAs<{ actor_id: string }>(
      w.db,
      w.admin,
      "select actor_id from public.audit_events where action = 'resident.viewed' and entity_id = $1",
      [w.ruth],
    );
    assert.deepEqual(events.map((e) => e.actor_id), [w.carer, w.carer]);
  });

  it('UC-06 refuses records outside the callers sites', async () => {
    await assert.rejects(queryAs(w.db, w.carer, 'select * from public.open_resident($1)', [w.sam]), /FORBIDDEN/);
    await assert.rejects(queryAs(w.db, w.admin, 'select * from public.open_resident($1)', [w.otto]), /FORBIDDEN/);
  });
});

describe('UC-07 write a care note', () => {
  it('UC-07 lets an assigned caregiver write a note', async () => {
    const id = await addNote(w.carer, w.ruth, 'observation', 'Ate most of lunch, walked to the garden.');
    const [note] = await queryAs<{ author_id: string; body: string }>(w.db, w.nurse, 'select author_id, body from public.care_notes where id = $1', [id]);
    assert.equal(note.author_id, w.carer);
    assert.equal(note.body, 'Ate most of lunch, walked to the garden.');
  });

  it('UC-07 returns the same note when the offline queue retries', async () => {
    const ref = randomUUID();
    const first = await addNote(w.carer, w.ruth, 'observation', 'Slept well.', ref);
    const retry = await addNote(w.carer, w.ruth, 'observation', 'Slept well.', ref);
    assert.equal(retry, first);
    const rows = await queryAs(w.db, w.nurse, 'select id from public.care_notes where resident_id = $1', [w.ruth]);
    assert.equal(rows.length, 1);
  });

  it('UC-07 refuses notes from auditors and from staff not assigned to the site', async () => {
    await assert.rejects(addNote(w.auditor, w.ruth, 'observation', 'Should not save.'), /FORBIDDEN/);
    await assert.rejects(addNote(w.carer, w.sam, 'observation', 'Should not save.'), /FORBIDDEN/);
    await assert.rejects(addNote(w.outsider, w.ruth, 'observation', 'Should not save.'), /FORBIDDEN/);
  });

  it('UC-07 accepts a late entry but not a note about the future', async () => {
    await addNote(w.carer, w.ruth, 'observation', 'Late entry for the night shift.', randomUUID(), null, "now() - interval '6 hours'");
    await assert.rejects(
      addNote(w.carer, w.ruth, 'observation', 'Future.', randomUUID(), null, "now() + interval '2 hours'"),
      /care_notes_check1|check constraint/,
    );
  });

  it('UC-07 does not allow inserting notes directly, bypassing the rules', async () => {
    await assert.rejects(
      queryAs(
        w.db,
        w.carer,
        "insert into public.care_notes (org_id, resident_id, author_id, kind, body, occurred_at, client_ref) values ($1, $2, $3, 'observation', 'x', now(), gen_random_uuid())",
        [w.orgA, w.ruth, w.carer],
      ),
      PERMISSION_DENIED,
    );
  });
});

describe('UC-08 correct a note without editing it', () => {
  it('UC-08 never lets anyone edit or delete a note, not even the service role', async () => {
    const id = await addNote(w.carer, w.ruth, 'observation', 'Original text.');
    await assert.rejects(queryAs(w.db, w.admin, "update public.care_notes set body = 'changed' where id = $1", [id]), PERMISSION_DENIED);
    await assert.rejects(queryAs(w.db, w.admin, 'delete from public.care_notes where id = $1', [id]), PERMISSION_DENIED);
    await assert.rejects(
      queryAsService(w.db, "update public.care_notes set body = 'changed' where id = $1", [id]),
      /RECORDS_ARE_APPEND_ONLY/,
    );
    await assert.rejects(queryAsService(w.db, 'delete from public.care_notes where id = $1', [id]), /RECORDS_ARE_APPEND_ONLY/);
  });

  it('UC-08 links a correction to the note it corrects', async () => {
    const original = await addNote(w.carer, w.ruth, 'observation', 'Gave 2 biscuits.');
    const fix = await addNote(w.carer, w.ruth, 'correction', 'Correction, it was 1 biscuit.', randomUUID(), original);
    const [row] = await queryAs<{ amends_note_id: string }>(w.db, w.nurse, 'select amends_note_id from public.care_notes where id = $1', [fix]);
    assert.equal(row.amends_note_id, original);
  });

  it('UC-08 requires a correction to point at a note for the same resident', async () => {
    const samNote = await addNote(w.nurse, w.sam, 'observation', 'Note about Sam.');
    await assert.rejects(addNote(w.nurse, w.ruth, 'correction', 'Wrong resident.', randomUUID(), samNote), /AMENDED_NOTE_NOT_FOUND/);
    await assert.rejects(addNote(w.nurse, w.ruth, 'correction', 'No target.'), /care_notes_check|check constraint/);
  });
});

describe('UC-15 review the audit trail', () => {
  it('UC-15 lets admins and auditors read the trail, not nurses or caregivers', async () => {
    await addNote(w.carer, w.ruth, 'observation', 'Something happened.');
    for (const user of [w.admin, w.auditor]) {
      const rows = await queryAs(w.db, user, "select id from public.audit_events where action = 'note.created'");
      assert.equal(rows.length, 1);
    }
    for (const user of [w.nurse, w.carer]) {
      const rows = await queryAs(w.db, user, 'select id from public.audit_events');
      assert.equal(rows.length, 0);
    }
  });

  it('UC-15 keeps the trail append-only and free of note text', async () => {
    await addNote(w.carer, w.ruth, 'observation', 'Private clinical detail.');
    const [event] = await queryAsService<{ id: number; details: unknown }>(w.db, "select id, details from public.audit_events where action = 'note.created'");
    assert.ok(!JSON.stringify(event.details).includes('Private clinical detail'));
    await assert.rejects(queryAsService(w.db, 'delete from public.audit_events where id = $1', [event.id]), /RECORDS_ARE_APPEND_ONLY/);
  });

  it('UC-15 does not show one providers trail to another', async () => {
    const rows = await queryAs(w.db, w.outsider, 'select id from public.audit_events where org_id = $1', [w.orgA]);
    assert.equal(rows.length, 0);
  });
});
