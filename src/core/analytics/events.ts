/**
 * The complete list of product analytics events and the only properties each
 * may carry. Anything not listed is dropped before it reaches PostHog, so a
 * resident's name or a note can't end up in analytics by accident.
 *
 * Properties are counts, enums and booleans. No ids of residents or notes:
 * product questions ("do people use offline mode?") don't need them.
 */

export const EVENTS = {
  signed_in: [],
  organization_switched: [],
  resident_opened: ['from'],
  care_note_saved: ['kind', 'offline'],
  dose_recorded: ['status', 'offline', 'minutes_from_schedule'],
  handoff_draft_requested: ['note_count'],
  handoff_draft_posted: ['edited'],
  offline_queue_flushed: ['sent', 'failed'],
  staff_invited: ['role'],
  site_geocoded: ['partial_match'],
} as const satisfies Record<string, readonly string[]>;

export type EventName = keyof typeof EVENTS;
type Primitive = string | number | boolean;

const ALLOWED_VALUES: Record<string, readonly Primitive[] | 'number' | 'boolean'> = {
  from: ['list', 'notification', 'search'],
  kind: ['observation', 'incident', 'handoff', 'correction'],
  status: ['given', 'refused', 'held'],
  role: ['admin', 'nurse', 'caregiver', 'auditor'],
  offline: 'boolean',
  edited: 'boolean',
  partial_match: 'boolean',
  minutes_from_schedule: 'number',
  note_count: 'number',
  sent: 'number',
  failed: 'number',
};

export type AnalyticsEvent = { name: EventName; properties?: Record<string, Primitive> };

/**
 * Returns only the allowed properties, with values checked against their
 * allowed set or type. Free text never passes.
 */
export function sanitize(event: AnalyticsEvent): { name: EventName; properties: Record<string, Primitive> } {
  const allowedKeys = EVENTS[event.name] as readonly string[];
  const properties: Record<string, Primitive> = {};
  for (const [key, value] of Object.entries(event.properties ?? {})) {
    if (!allowedKeys.includes(key)) continue;
    const rule = ALLOWED_VALUES[key];
    if (rule === 'number' && typeof value === 'number' && Number.isFinite(value)) properties[key] = Math.round(value);
    else if (rule === 'boolean' && typeof value === 'boolean') properties[key] = value;
    else if (Array.isArray(rule) && rule.includes(value)) properties[key] = value;
  }
  return { name: event.name, properties };
}

export type AnalyticsSink = { capture(name: string, properties: Record<string, Primitive>): void };

/** The only way the app sends analytics. */
export class Analytics {
  constructor(private readonly sink: AnalyticsSink | undefined) {}

  track(event: AnalyticsEvent): void {
    if (!this.sink) return;
    const clean = sanitize(event);
    try {
      this.sink.capture(clean.name, clean.properties);
    } catch {
      // Analytics must never break a care workflow.
    }
  }
}
