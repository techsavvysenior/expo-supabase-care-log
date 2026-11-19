import { ExpoPushClient } from '../integrations/expo-push';
import { GoogleGeocoder } from '../integrations/geocoding';
import { backoffMs, IntegrationError, retryAfterMs, send } from '../integrations/http';
import { OpenAIClient } from '../integrations/openai';
import { ResendClient } from '../integrations/resend';
import { TwilioClient } from '../integrations/twilio';

type Call = { url: string; init: RequestInit };

/** A fetch that replays canned responses in order and records each call. */
function fakeFetch(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const noSleep = { sleep: () => Promise.resolve() };

describe('http retries', () => {
  const onError = async (res: Response) => new IntegrationError('resend', 'http', res.status >= 500, res.status);

  it('retries a 503 and returns the later success', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({}, 503), jsonResponse({ ok: true }));
    const res = await send('resend', 'https://x', { method: 'POST' }, { fetch, onError, ...noSleep });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('does not retry a 400', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({}, 400));
    await expect(send('resend', 'https://x', {}, { fetch, onError, ...noSleep })).rejects.toMatchObject({ retryable: false, status: 400 });
    expect(calls).toHaveLength(1);
  });

  it('turns repeated network failures into a retryable error', async () => {
    const { fetch, calls } = fakeFetch(new TypeError('Network request failed'), new TypeError('x'), new TypeError('x'));
    await expect(send('resend', 'https://x', {}, { fetch, onError, ...noSleep })).rejects.toMatchObject({
      code: 'network_error',
      retryable: true,
    });
    expect(calls).toHaveLength(3);
  });

  it('caps backoff and reads Retry-After', () => {
    expect(backoffMs(10, () => 0.999)).toBeLessThan(4000);
    expect(retryAfterMs('2')).toBe(2000);
    expect(retryAfterMs('Thu, 19 Nov 2026 12:00:10 GMT', Date.parse('Thu, 19 Nov 2026 12:00:00 GMT'))).toBe(10_000);
    expect(retryAfterMs(null)).toBeUndefined();
  });
});

describe('UC-12 Expo push client', () => {
  it('UC-12 sends batches of 100 and maps each ticket to its token', async () => {
    const messages = Array.from({ length: 150 }, (_, i) => ({ to: `ExponentPushToken[${i}]`, title: 't', body: 'b' }));
    const tickets = (n: number) => Array.from({ length: n }, (_, i) => ({ status: 'ok', id: `ticket-${i}` }));
    const { fetch, calls } = fakeFetch(jsonResponse({ data: tickets(100) }), jsonResponse({ data: tickets(50) }));
    const results = await new ExpoPushClient({ fetch }).send(messages);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1].init.body))).toHaveLength(50);
    expect(results).toHaveLength(150);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('UC-12 flags DeviceNotRegistered so the token can be deleted', async () => {
    const { fetch } = fakeFetch(
      jsonResponse({ data: [{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }] }),
    );
    const [result] = await new ExpoPushClient({ fetch }).send([{ to: 'ExponentPushToken[x]', title: 't', body: 'b' }]);
    expect(result).toEqual({ token: 'ExponentPushToken[x]', ok: false, error: 'DeviceNotRegistered', unregistered: true });
  });

  it('UC-12 sends the access token only when configured', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ data: [{ status: 'ok', id: '1' }] }));
    await new ExpoPushClient({ fetch, accessToken: 'tok' }).send([{ to: 'ExponentPushToken[x]', title: 't', body: 'b' }]);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
});

describe('UC-12 Resend client', () => {
  it('UC-12 sends with an idempotency key so a retry never emails twice', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ id: 'em_1' }));
    const result = await new ResendClient({ fetch, apiKey: 're_test', from: 'Care Log <alerts@example.com>' }).send({
      to: 'nurse@example.com',
      subject: 'Care Log: Incident reported',
      text: 'Open Care Log.',
      idempotencyKey: 'notification-7',
    });
    expect(result).toEqual({ id: 'em_1' });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('notification-7');
    expect(headers.Authorization).toBe('Bearer re_test');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ to: ['nurse@example.com'], from: 'Care Log <alerts@example.com>' });
  });

  it('UC-12 reports a validation error as permanent', async () => {
    const { fetch } = fakeFetch(jsonResponse({ name: 'validation_error', message: 'bad' }, 422));
    await expect(
      new ResendClient({ fetch, apiKey: 'k', from: 'f@e.com', ...noSleep }).send({ to: 'x', subject: 's', text: 't', idempotencyKey: 'k' }),
    ).rejects.toMatchObject({ code: 'validation_error', retryable: false });
  });
});

describe('UC-12 Twilio client', () => {
  const config = { accountSid: 'AC123', auth: { username: 'SK1', password: 'secret' }, messagingServiceSid: 'MG1' };

  it('UC-12 posts a form with Basic auth and the messaging service', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ sid: 'SM1', status: 'accepted' }, 201));
    const result = await new TwilioClient({ ...config, fetch }).sendSms('+15405550100', 'Care Log: check the app.');
    expect(result).toEqual({ sid: 'SM1', status: 'accepted' });
    expect(calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    const form = new URLSearchParams(String(calls[0].init.body));
    expect(form.get('To')).toBe('+15405550100');
    expect(form.get('MessagingServiceSid')).toBe('MG1');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('SK1:secret')}`);
  });

  it('UC-12 does not retry an opted-out recipient', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ code: 21610, message: 'unsubscribed' }, 400));
    await expect(new TwilioClient({ ...config, fetch, ...noSleep }).sendSms('+15405550100', 'x')).rejects.toMatchObject({
      code: 'twilio_21610',
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it('UC-12 does not resend an SMS after a timeout, since Twilio may have accepted it', async () => {
    const { fetch, calls } = fakeFetch(new DOMException('timed out', 'TimeoutError'), jsonResponse({ sid: 'SM2' }, 201));
    await expect(new TwilioClient({ ...config, fetch, ...noSleep }).sendSms('+15405550100', 'x')).rejects.toMatchObject({ code: 'timeout' });
    expect(calls).toHaveLength(1);
  });

  it('UC-12 refuses a number that is not E.164 before calling Twilio', async () => {
    const { fetch, calls } = fakeFetch();
    await expect(new TwilioClient({ ...config, fetch }).sendSms('540-555-0100', 'x')).rejects.toMatchObject({ code: 'invalid_number' });
    expect(calls).toHaveLength(0);
  });
});

describe('UC-14 Google geocoder', () => {
  const ok = {
    status: 'OK',
    results: [{ formatted_address: '1 Main St', place_id: 'p1', partial_match: true, geometry: { location: { lat: 38.9, lng: -77.6 } } }],
  };

  it('UC-14 returns coordinates and flags a partial match', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(ok));
    const result = await new GoogleGeocoder({ fetch, apiKey: 'k', region: 'us' }).geocode('1 Main St, Aldie VA');
    expect(result).toEqual({ latitude: 38.9, longitude: -77.6, placeId: 'p1', formattedAddress: '1 Main St', partialMatch: true });
    expect(calls[0].url).toContain('address=1+Main+St%2C+Aldie+VA');
    expect(calls[0].url).toContain('region=us');
  });

  it('UC-14 returns undefined for ZERO_RESULTS and errors for a denied key', async () => {
    const { fetch } = fakeFetch(jsonResponse({ status: 'ZERO_RESULTS', results: [] }), jsonResponse({ status: 'REQUEST_DENIED' }));
    const geocoder = new GoogleGeocoder({ fetch, apiKey: 'k' });
    await expect(geocoder.geocode('nowhere')).resolves.toBeUndefined();
    await expect(geocoder.geocode('x')).rejects.toMatchObject({ code: 'request_denied', retryable: false });
  });
});

describe('UC-13 OpenAI client', () => {
  const output = (text: string) => ({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  });

  it('UC-13 never stores the request at OpenAI and asks for strict JSON', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(output(JSON.stringify({ summary: 'Quiet shift.', follow_ups: [] }))));
    const draft = await new OpenAIClient({ fetch, apiKey: 'sk', model: 'test-model' }).draftHandoff('notes');
    expect(draft).toEqual({ summary: 'Quiet shift.', followUps: [] });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.store).toBe(false);
    expect(body.model).toBe('test-model');
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'handoff_draft', strict: true });
  });

  it('UC-13 treats a refusal or a cut-off answer as a failure, not a draft', async () => {
    const { fetch } = fakeFetch(
      jsonResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }),
      jsonResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }),
    );
    const client = new OpenAIClient({ fetch, apiKey: 'sk', model: 'm' });
    await expect(client.draftHandoff('x')).rejects.toMatchObject({ code: 'refused' });
    await expect(client.draftHandoff('x')).rejects.toMatchObject({ code: 'incomplete_max_output_tokens' });
  });

  it('UC-13 requires the model to be configured', () => {
    expect(() => new OpenAIClient({ apiKey: 'sk', model: '' })).toThrow(/OPENAI_MODEL/);
  });
});
