import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OfflineError, RuleViolationError, ruleFromMessage, toAppError, RULE_MESSAGES } from '../errors';
import { canRecord, doseState, groupByTime, reasonRequired, type DueDose } from '../mar/dose-window';
import { OfflineQueue, type QueuedWrite, type QueueState } from '../offline/queue';
import { capabilitiesOf, STAFF_ROLES } from '../roles';

const MIGRATIONS = join(__dirname, '..', '..', '..', 'supabase', 'migrations');
const sql = (file: string) => readFileSync(join(MIGRATIONS, file), 'utf8');

describe('UC-04 roles mirror the database', () => {
  it('UC-04 lists the same roles as the staff_role enum', () => {
    const match = sql('20261119200000_tenancy.sql').match(/create type public\.staff_role as enum \(([^)]+)\)/);
    const fromSql = match?.[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(fromSql).toEqual([...STAFF_ROLES]);
  });

  it('UC-04 gives auditors read access only and caregivers no admin rights', () => {
    expect(capabilitiesOf('auditor')).toMatchObject({ writeCareNotes: false, recordDoses: false, readAuditTrail: true });
    expect(capabilitiesOf('caregiver')).toMatchObject({ allSites: false, manageStaff: false, admitResidents: false });
    expect(capabilitiesOf(null).writeCareNotes).toBe(false);
  });

  it('UC-04 has a user message for every rule the database raises', () => {
    const raised = new Set(
      [...['20261119200000_tenancy.sql', '20261119200100_care_records.sql', '20261119200200_notifications.sql'].map(sql).join('\n').matchAll(/raise exception '([A-Z_]+)/g)].map(
        (m) => m[1],
      ),
    );
    for (const rule of raised) expect(RULE_MESSAGES).toHaveProperty(rule);
  });
});

describe('UC-10 error mapping', () => {
  it('UC-10 turns a database rule into a plain sentence', () => {
    const error = toAppError({ message: 'REASON_REQUIRED', code: 'P0001' });
    expect(error).toBeInstanceOf(RuleViolationError);
    expect(error.userMessage).toBe(RULE_MESSAGES.REASON_REQUIRED);
    expect(ruleFromMessage('RECORDS_ARE_APPEND_ONLY: UPDATE on care_notes')).toBe('RECORDS_ARE_APPEND_ONLY');
  });

  it('UC-10 treats a network failure as offline and retryable', () => {
    const error = toAppError(new TypeError('Network request failed'));
    expect(error).toBeInstanceOf(OfflineError);
    expect(error.retryable).toBe(true);
  });

  it('UC-10 maps an RLS denial to FORBIDDEN', () => {
    expect(toAppError({ code: '42501', message: 'new row violates row-level security policy' }).code).toBe('FORBIDDEN');
  });
});

describe('UC-09 dose window', () => {
  const dose = (scheduledFor: string, status: DueDose['status'] = null): DueDose => ({
    orderId: 'o',
    residentId: 'r',
    drugName: 'Metformin',
    dose: '500 mg',
    route: 'oral',
    scheduledFor,
    status,
  });
  const now = new Date('2026-11-19T13:00:00Z');

  it('UC-09 opens a dose an hour before its time', () => {
    expect(doseState(dose('2026-11-19T14:30:00Z'), now)).toEqual({ kind: 'not_yet', opensInMinutes: 30 });
    expect(doseState(dose('2026-11-19T13:45:00Z'), now)).toEqual({ kind: 'due', minutesFromSchedule: -45 });
    expect(canRecord(doseState(dose('2026-11-19T14:30:00Z'), now))).toBe(false);
  });

  it('UC-09 shows overdue doses and recorded ones', () => {
    expect(doseState(dose('2026-11-19T11:30:00Z'), now)).toEqual({ kind: 'overdue', minutesLate: 90 });
    expect(doseState(dose('2026-11-19T11:30:00Z', 'given'), now)).toEqual({ kind: 'recorded', status: 'given' });
  });

  it('UC-10 asks for a reason only when a dose is not given', () => {
    expect([reasonRequired('given'), reasonRequired('refused'), reasonRequired('held')]).toEqual([false, true, true]);
  });

  it('UC-09 groups a med pass by time, then resident', () => {
    const groups = groupByTime([dose('2026-11-19T20:00:00Z'), dose('2026-11-19T08:00:00Z'), dose('2026-11-19T08:00:00Z')]);
    expect(groups.map((g) => [g.scheduledFor, g.doses.length])).toEqual([
      ['2026-11-19T08:00:00Z', 2],
      ['2026-11-19T20:00:00Z', 1],
    ]);
  });
});

describe('UC-07 offline queue', () => {
  const memory = () => {
    let saved: QueueState | null = null;
    return { load: async () => saved, save: async (s: QueueState) => void (saved = s), peek: () => saved };
  };
  const note = (ref: string): QueuedWrite => ({
    kind: 'care_note',
    clientRef: ref,
    createdAt: '2026-11-19T10:00:00Z',
    payload: { residentId: 'r', noteKind: 'observation', body: 'Ate lunch.', occurredAt: '2026-11-19T10:00:00Z' },
  });

  it('UC-07 persists items and sends them in order when back online', async () => {
    const storage = memory();
    const queue = new OfflineQueue(storage);
    await queue.enqueue(note('a'));
    await queue.enqueue(note('b'));
    expect(storage.peek()?.pending).toHaveLength(2);

    const sent: string[] = [];
    const result = await queue.flush(async (item) => void sent.push(item.clientRef));
    expect(sent).toEqual(['a', 'b']);
    expect(result).toEqual({ sent: 2, failed: 0, stoppedOffline: false });
    expect(storage.peek()?.pending).toEqual([]);
  });

  it('UC-07 ignores a double tap that queues the same item twice', async () => {
    const queue = new OfflineQueue(memory());
    await queue.enqueue(note('a'));
    await queue.enqueue(note('a'));
    expect((await queue.load()).pending).toHaveLength(1);
  });

  it('UC-07 stops at the first network failure and keeps the rest for later', async () => {
    const queue = new OfflineQueue(memory());
    await queue.enqueue(note('a'));
    await queue.enqueue(note('b'));
    const result = await queue.flush(async () => {
      throw new TypeError('Network request failed');
    });
    expect(result).toEqual({ sent: 0, failed: 0, stoppedOffline: true });
    expect((await queue.load()).pending.map((p) => p.clientRef)).toEqual(['a', 'b']);
  });

  it('UC-10 sets aside an item the database refuses and carries on', async () => {
    const queue = new OfflineQueue(memory(), () => new Date('2026-11-19T12:00:00Z'));
    await queue.enqueue(note('a'));
    await queue.enqueue(note('b'));
    const result = await queue.flush(async (item) => {
      if (item.clientRef === 'a') throw new Error('DOSE_ALREADY_RECORDED');
    });
    expect(result).toEqual({ sent: 1, failed: 1, stoppedOffline: false });
    const state = await queue.load();
    expect(state.failed).toMatchObject([{ clientRef: 'a', error: RULE_MESSAGES.DOSE_ALREADY_RECORDED }]);
  });

  it('UC-07 shares one run between concurrent flushes', async () => {
    const queue = new OfflineQueue(memory());
    await queue.enqueue(note('a'));
    const send = jest.fn(async () => undefined);
    await Promise.all([queue.flush(send), queue.flush(send)]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
