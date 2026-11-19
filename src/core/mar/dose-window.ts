/**
 * The medication record screen's view of a dose. The database is the
 * authority (record_dose() applies the same rules); this exists so the
 * screen can grey out buttons and explain why before anyone taps them.
 */

export const EARLY_WINDOW_MINUTES = 60;
export const MISSED_AFTER_MINUTES = 60;

export type DueDose = {
  orderId: string;
  residentId: string;
  drugName: string;
  dose: string;
  route: string;
  scheduledFor: string;
  status: 'given' | 'refused' | 'held' | 'missed' | null;
};

export type DoseState =
  | { kind: 'recorded'; status: NonNullable<DueDose['status']> }
  | { kind: 'not_yet'; opensInMinutes: number }
  | { kind: 'due'; minutesFromSchedule: number }
  | { kind: 'overdue'; minutesLate: number };

export function doseState(dose: DueDose, now: Date): DoseState {
  if (dose.status) return { kind: 'recorded', status: dose.status };
  const minutes = Math.round((now.getTime() - Date.parse(dose.scheduledFor)) / 60_000);
  if (minutes < -EARLY_WINDOW_MINUTES) return { kind: 'not_yet', opensInMinutes: -minutes - EARLY_WINDOW_MINUTES };
  if (minutes > MISSED_AFTER_MINUTES) return { kind: 'overdue', minutesLate: minutes };
  return { kind: 'due', minutesFromSchedule: minutes };
}

export function canRecord(state: DoseState): boolean {
  return state.kind === 'due' || state.kind === 'overdue';
}

export function reasonRequired(status: 'given' | 'refused' | 'held'): boolean {
  return status !== 'given';
}

/** Groups doses by scheduled time, then resident, the way a med pass is done. */
export function groupByTime(doses: DueDose[]): { scheduledFor: string; doses: DueDose[] }[] {
  const groups = new Map<string, DueDose[]>();
  for (const dose of [...doses].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor) || a.residentId.localeCompare(b.residentId))) {
    const list = groups.get(dose.scheduledFor) ?? [];
    list.push(dose);
    groups.set(dose.scheduledFor, list);
  }
  return [...groups.entries()].map(([scheduledFor, list]) => ({ scheduledFor, doses: list }));
}
