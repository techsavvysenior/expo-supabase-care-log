import { Analytics, sanitize } from '../analytics/events';
import { pseudonymize, reidentify } from '../handoff/pseudonymize';
import { redactText, scrubBreadcrumb, scrubEvent } from '../privacy/scrub';

describe('UC-16 crash reports carry no health information', () => {
  it('UC-16 keeps only the user id and drops request bodies and extras', () => {
    const event = scrubEvent({
      user: { id: 'u1', email: 'nia@a.example', username: 'Nia' },
      request: { url: 'https://x.supabase.co/rest/v1/residents?last_name=eq.Baker', data: { body: 'Ruth fell' }, cookies: 'c' },
      extra: { note: 'Ruth fell in the bathroom' },
      contexts: { app: { v: 1 }, device: { m: 'iPhone' }, state: { form: 'Ruth' } },
    });
    expect(event.user).toEqual({ id: 'u1' });
    expect(event.request).toEqual({ url: 'https://x.supabase.co/rest/v1/residents?[redacted]' });
    expect(event.extra).toBeUndefined();
    expect(Object.keys(event.contexts ?? {})).not.toContain('state');
  });

  it('UC-16 masks emails, phone numbers and dates in messages', () => {
    expect(redactText('Failed for nia@a.example, DOB 1940-05-01, call +1 540 555 0100')).toBe(
      'Failed for [email], DOB [date], call [phone]',
    );
    const event = scrubEvent({ exception: { values: [{ value: 'duplicate key for nia@a.example' }] } });
    expect(event.exception?.values?.[0].value).toBe('duplicate key for [email]');
  });

  it('UC-16 drops console and UI breadcrumbs and strips network data to method, status and path', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'Ruth Baker' })).toBeNull();
    expect(scrubBreadcrumb({ category: 'ui.click', message: 'Ruth Baker' })).toBeNull();
    expect(
      scrubBreadcrumb({ category: 'fetch', data: { method: 'POST', status_code: 500, url: 'https://x/rpc/add_care_note?x=1', body: 'secret' } }),
    ).toEqual({ category: 'fetch', data: { method: 'POST', status_code: 500, url: 'https://x/rpc/add_care_note?[redacted]' } });
  });
});

describe('UC-16 analytics carry no health information', () => {
  it('UC-16 drops unknown properties and free text', () => {
    expect(
      sanitize({ name: 'care_note_saved', properties: { kind: 'incident', offline: true, body: 'Ruth fell', resident_id: 'r1' } }),
    ).toEqual({ name: 'care_note_saved', properties: { kind: 'incident', offline: true } });
  });

  it('UC-16 rejects values outside each propertys allowed set', () => {
    expect(sanitize({ name: 'dose_recorded', properties: { status: 'Ruth refused', minutes_from_schedule: 12.6 } })).toEqual({
      name: 'dose_recorded',
      properties: { minutes_from_schedule: 13 },
    });
  });

  it('UC-16 never lets an analytics failure reach the caller', () => {
    const analytics = new Analytics({
      capture: () => {
        throw new Error('network');
      },
    });
    expect(() => analytics.track({ name: 'signed_in' })).not.toThrow();
  });
});

describe('UC-13 pseudonymized handoff input', () => {
  const notes = [
    { residentId: 'r-ruth', firstName: 'Ruth', lastName: 'Baker', kind: 'incident', body: 'Ruth Baker slipped. Mrs Baker was calm.', occurredAt: '09:00' },
    { residentId: 'r-sam', firstName: 'Sam', lastName: 'Cole', kind: 'observation', body: 'Sam asked about Ruth.', occurredAt: '10:00' },
  ];

  it('UC-13 replaces every resident name, including mentions in other residents notes', () => {
    const { prompt, labels } = pseudonymize(notes);
    expect(prompt).not.toMatch(/Ruth|Baker|Sam|Cole/);
    expect(prompt).toContain('R1 (incident): R1 slipped. Mrs R1 was calm.');
    expect(prompt).toContain('R2 (observation): R2 asked about R1.');
    expect(labels.get('R2')).toEqual({ residentId: 'r-sam', displayName: 'Sam C.' });
  });

  it('UC-13 maps labels back to short names and ids', () => {
    const { labels } = pseudonymize(notes);
    const draft = reidentify({ summary: 'R1 slipped; R2 calm.', followUps: [{ resident: 'R1', action: 'Check R1 at 2pm.' }] }, labels);
    expect(draft.summary).toBe('Ruth B. slipped; Sam C. calm.');
    expect(draft.followUps).toEqual([{ resident: 'Ruth B.', residentId: 'r-ruth', action: 'Check Ruth B. at 2pm.' }]);
  });

  it('UC-13 leaves an unknown label as it is instead of guessing', () => {
    const { labels } = pseudonymize(notes);
    expect(reidentify({ summary: 'R9 unknown', followUps: [] }, labels).summary).toBe('R9 unknown');
  });
});
