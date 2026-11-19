import type { ClaimedNotification, Outcome } from '../../../src/core/notifications/dispatcher.ts';
import { createDispatchHandler } from '../dispatch-notifications/handler.ts';
import { NOTE, RESIDENT, SITE, assertEquals, post, read } from './helpers.ts';

const claimed = (id: number): ClaimedNotification => ({
  id,
  template: 'incident_reported',
  payload: { site_id: SITE, resident_id: RESIDENT, note_id: NOTE },
  attempts: 1,
  recipient_id: 'u',
  email: 'nurse@example.com',
  phone_e164: null,
  push_enabled: true,
  email_enabled: true,
  sms_enabled: false,
  push_tokens: ['ExponentPushToken[a]'],
});

function setup(outcomes: Record<number, Outcome | Error>) {
  const completed: Outcome[] = [];
  const forgotten: string[] = [];
  const handler = createDispatchHandler({
    cronSecret: 's3cret',
    claim: () => Promise.resolve(Object.keys(outcomes).map((id) => claimed(Number(id)))),
    complete: (o) => {
      completed.push(o);
      return Promise.resolve();
    },
    forgetToken: (t) => {
      forgotten.push(t);
      return Promise.resolve();
    },
    dispatcher: {
      dispatch: (n) => {
        const outcome = outcomes[n.id];
        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
      },
    },
  });
  return { handler, completed, forgotten };
}

const ok = (id: number, deadTokens: string[] = []): Outcome => ({ id, ok: true, retryable: false, sentVia: ['email'], deadTokens });

Deno.test('UC-12 dispatcher rejects calls without the cron secret', async () => {
  const { handler, completed } = setup({ 1: ok(1) });
  const { status } = await read(await handler(post({}, { 'x-cron-secret': 'wrong' })));
  assertEquals(status, 401);
  assertEquals(completed.length, 0);
});

Deno.test('UC-12 dispatcher reports every result back to the outbox', async () => {
  const { handler, completed } = setup({
    1: ok(1),
    2: { id: 2, ok: false, retryable: true, error: 'resend:timeout', sentVia: [], deadTokens: [] },
  });
  const { status, body } = await read(await handler(post({}, { 'x-cron-secret': 's3cret' })));
  assertEquals(status, 200);
  assertEquals(body, { claimed: 2, sent: 1, failed: 1, tokens_removed: 0 });
  assertEquals(completed.map((c) => [c.id, c.ok]), [
    [1, true],
    [2, false],
  ]);
});

Deno.test('UC-12 dispatcher keeps going when one message crashes, and retries it', async () => {
  const { handler, completed } = setup({ 1: new Error('boom'), 2: ok(2) });
  const { body } = await read(await handler(post({}, { 'x-cron-secret': 's3cret' })));
  assertEquals(body.sent, 1);
  assertEquals(completed[0], { id: 1, ok: false, retryable: true, error: 'dispatch_crashed', sentVia: [], deadTokens: [] });
});

Deno.test('UC-12 dispatcher forgets each dead push token once', async () => {
  const { handler, forgotten } = setup({ 1: ok(1, ['ExponentPushToken[dead]']), 2: ok(2, ['ExponentPushToken[dead]']) });
  const { body } = await read(await handler(post({}, { 'x-cron-secret': 's3cret' })));
  assertEquals(forgotten, ['ExponentPushToken[dead]']);
  assertEquals(body.tokens_removed, 1);
});

Deno.test('UC-12 dispatcher answers only POST', async () => {
  const { handler } = setup({});
  const response = await handler(new Request('http://localhost/fn', { method: 'GET' }));
  assertEquals(response.status, 405);
  await response.body?.cancel();
});
