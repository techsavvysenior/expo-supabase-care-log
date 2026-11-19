import { ServiceUnavailableError, toAppError, UnexpectedError } from '../errors';
import { ExpoPushClient } from '../integrations/expo-push';
import { OpenAIClient } from '../integrations/openai';
import { ResendClient } from '../integrations/resend';
import { TwilioClient } from '../integrations/twilio';
import { OfflineQueue, type QueueState } from '../offline/queue';
import { isStaffRole } from '../roles';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const once = (response: Response) => jest.fn(async () => response) as unknown as typeof fetch;
const noSleep = { sleep: () => Promise.resolve(), retries: 0 };

describe('edge cases worth pinning down', () => {
  it('maps gateway timeouts to a retryable error and unknown failures to a reported one', () => {
    expect(toAppError(new Error('upstream 503'))).toBeInstanceOf(ServiceUnavailableError);
    const unexpected = toAppError('something odd');
    expect(unexpected).toBeInstanceOf(UnexpectedError);
    expect(unexpected.retryable).toBe(false);
  });

  it('recognizes only real staff roles', () => {
    expect(isStaffRole('nurse')).toBe(true);
    expect(isStaffRole('owner')).toBe(false);
    expect(isStaffRole(undefined)).toBe(false);
  });

  it('UC-12 surfaces an Expo request-level error with its code', async () => {
    const client = new ExpoPushClient({ fetch: once(json({ errors: [{ code: 'PUSH_TOO_MANY_EXPERIENCE_IDS' }] }, 400)), ...noSleep });
    await expect(client.send([{ to: 'ExponentPushToken[x]', title: 't', body: 'b' }])).rejects.toMatchObject({
      code: 'PUSH_TOO_MANY_EXPERIENCE_IDS',
      retryable: false,
    });
  });

  it('UC-12 refuses an Expo reply whose tickets do not match the messages', async () => {
    const client = new ExpoPushClient({ fetch: once(json({ data: [] })), ...noSleep });
    await expect(client.send([{ to: 'ExponentPushToken[x]', title: 't', body: 'b' }])).rejects.toMatchObject({ code: 'ticket_count_mismatch' });
  });

  it('UC-12 treats a Resend reply without an id as a failure', async () => {
    const client = new ResendClient({ fetch: once(json({})), apiKey: 'k', from: 'f@e.com' });
    await expect(client.send({ to: 'a@b.co', subject: 's', text: 't', idempotencyKey: 'k' })).rejects.toMatchObject({ code: 'missing_id' });
  });

  it('UC-12 needs a sender for Twilio and accepts a plain From number', async () => {
    expect(() => new TwilioClient({ accountSid: 'AC', auth: { username: 'u', password: 'p' } })).toThrow(/messagingServiceSid/);
    const fetch = once(json({ sid: 'SM9' }, 201));
    const result = await new TwilioClient({ accountSid: 'AC', auth: { username: 'u', password: 'p' }, from: '+15405550199', fetch }).sendSms(
      '+15405550100',
      'x',
    );
    expect(result).toEqual({ sid: 'SM9', status: 'queued' });
  });

  it('UC-13 rejects model output that is not valid JSON or misses fields', async () => {
    const reply = (text: string) => json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
    const bad = new OpenAIClient({ fetch: once(reply('not json')), apiKey: 'k', model: 'm', ...noSleep });
    await expect(bad.draftHandoff('x')).rejects.toMatchObject({ code: 'invalid_json' });
    const partial = new OpenAIClient({ fetch: once(reply('{"summary": 3}')), apiKey: 'k', model: 'm', ...noSleep });
    await expect(partial.draftHandoff('x')).rejects.toMatchObject({ code: 'schema_mismatch' });
    const rateLimited = new OpenAIClient({ fetch: once(json({ error: { code: 'rate_limit_exceeded' } }, 429)), apiKey: 'k', model: 'm', ...noSleep });
    await expect(rateLimited.draftHandoff('x')).rejects.toMatchObject({ code: 'rate_limit_exceeded', retryable: true });
  });

  it('UC-07 tells subscribers about changes and lets a person dismiss a failed entry', async () => {
    let saved: QueueState | null = { pending: [], failed: [] };
    const queue = new OfflineQueue({ load: async () => saved, save: async (s) => void (saved = s) });
    const seen: number[] = [];
    const unsubscribe = queue.subscribe((s) => seen.push(s.pending.length));
    await queue.enqueue({
      kind: 'dose',
      clientRef: 'd1',
      createdAt: '2026-11-19T10:00:00Z',
      payload: { orderId: 'o', scheduledFor: '2026-11-19T10:00:00Z', status: 'given' },
    });
    await queue.flush(async () => {
      throw new Error('ORDER_NOT_ACTIVE');
    });
    unsubscribe();
    expect(seen).toEqual([1, 0]);
    await queue.dismissFailed('d1');
    expect(saved?.failed).toEqual([]);
  });
});
