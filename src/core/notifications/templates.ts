/**
 * What a notification says. Deliberately vague: a push banner shows on a lock
 * screen and an SMS sits on a phone carrier's servers, so neither names a
 * resident or describes care. The message only says something needs a look,
 * and the link opens the app, where access rules apply.
 */

export const TEMPLATES = ['incident_reported', 'dose_missed', 'handoff_posted'] as const;
export type Template = (typeof TEMPLATES)[number];

export type Payload = Partial<Record<'org_id' | 'site_id' | 'resident_id' | 'note_id' | 'order_id' | 'administration_id', string>>;

export type Rendered = {
  title: string;
  body: string;
  /** App deep link. Identifiers only. */
  url: string;
  emailSubject: string;
  sms: string;
};

const APP = 'Care Log';

export function render(template: Template, payload: Payload, scheme = 'carelog'): Rendered {
  switch (template) {
    case 'incident_reported':
      return finish({
        title: 'Incident reported',
        body: 'An incident was logged at one of your sites. Open Care Log to review it.',
        url: `${scheme}://notes/${payload.note_id}`,
      });
    case 'dose_missed':
      return finish({
        title: 'Dose not recorded',
        body: 'A scheduled dose has no record. Open Care Log to check the medication record.',
        url: `${scheme}://doses?site=${payload.site_id}`,
      });
    case 'handoff_posted':
      return finish({
        title: 'Shift handoff posted',
        body: 'A handoff note is ready for your shift. Open Care Log to read it.',
        url: `${scheme}://notes/${payload.note_id}`,
      });
  }
}

function finish(message: { title: string; body: string; url: string }): Rendered {
  return {
    ...message,
    emailSubject: `${APP}: ${message.title}`,
    // Carriers split long SMS into parts that each cost money; stay in one.
    sms: `${APP}: ${message.body}`.slice(0, 160),
  };
}

/**
 * Words that must never appear in a rendered message. A test renders every
 * template and checks; this is the guard if someone later edits the copy.
 */
export const FORBIDDEN_IN_MESSAGES = /\b(resident name|diagnos|medication name|mg\b|fell|fall|bleed|seizure|dementia)/i;
