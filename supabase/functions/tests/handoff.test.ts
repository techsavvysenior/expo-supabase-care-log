import type { HandoffNote } from '../../../src/core/handoff/pseudonymize.ts';
import type { HandoffDraft } from '../../../src/core/integrations/openai.ts';
import { HttpError } from '../_shared/http.ts';
import { createHandoffHandler, type HandoffRepo } from '../summarize-handoff/handler.ts';
import { RESIDENT, SITE, assertEquals, assertStringIncludes, post, read } from './helpers.ts';

const FROM = '2026-11-19T07:00:00Z';
const TO = '2026-11-19T19:00:00Z';

const notes: HandoffNote[] = [
  {
    residentId: RESIDENT,
    firstName: 'Ruth',
    lastName: 'Baker',
    kind: 'incident',
    body: 'Ruth Baker slipped in the bathroom, no injury. Ruth asked for her daughter.',
    occurredAt: '2026-11-19T09:00:00Z',
  },
];

function setup(options: { enabled?: boolean | undefined; notes?: HandoffNote[]; authFails?: boolean } = {}) {
  const prompts: string[] = [];
  const audited: number[] = [];
  const repo: HandoffRepo = {
    aiEnabledForSite: () => Promise.resolve('enabled' in options ? options.enabled : true),
    notes: () => Promise.resolve(options.notes ?? notes),
    recordRequest: (_site, count) => {
      audited.push(count);
      return Promise.resolve();
    },
  };
  const handler = createHandoffHandler({
    repoFor: () => (options.authFails ? Promise.reject(new HttpError(401, 'not_authenticated')) : Promise.resolve(repo)),
    ai: {
      draftHandoff: (input): Promise<HandoffDraft> => {
        prompts.push(input);
        return Promise.resolve({ summary: 'R1 had a minor slip, no injury.', followUps: [{ resident: 'R1', action: 'Call R1 daughter.' }] });
      },
    },
  });
  return { handler, prompts, audited };
}

Deno.test('UC-13 handoff sends labels to the AI, never names', async () => {
  const { handler, prompts } = setup();
  await read(await handler(post({ site_id: SITE, from: FROM, to: TO })));
  assertEquals(prompts.length, 1);
  assertEquals(/Ruth|Baker/.test(prompts[0]), false);
  assertStringIncludes(prompts[0], 'R1 slipped in the bathroom');
});

Deno.test('UC-13 handoff puts names back in the draft for the staff member', async () => {
  const { handler } = setup();
  const { status, body } = await read(await handler(post({ site_id: SITE, from: FROM, to: TO })));
  assertEquals(status, 200);
  assertEquals(body.summary, 'Ruth B. had a minor slip, no injury.');
  assertEquals(body.follow_ups, [{ resident: 'Ruth B.', resident_id: RESIDENT, action: 'Call Ruth B. daughter.' }]);
});

Deno.test('UC-13 handoff audits the request with the note count', async () => {
  const { handler, audited } = setup();
  await read(await handler(post({ site_id: SITE, from: FROM, to: TO })));
  assertEquals(audited, [1]);
});

Deno.test('UC-13 handoff refuses when the provider has not enabled AI', async () => {
  const { handler, prompts } = setup({ enabled: false });
  const { status, body } = await read(await handler(post({ site_id: SITE, from: FROM, to: TO })));
  assertEquals([status, body.error], [403, 'AI_NOT_ENABLED']);
  assertEquals(prompts.length, 0);
});

Deno.test('UC-13 handoff returns 404 for a site the caller cannot see', async () => {
  const { handler } = setup({ enabled: undefined });
  const { status } = await read(await handler(post({ site_id: SITE, from: FROM, to: TO })));
  assertEquals(status, 404);
});

Deno.test('UC-13 handoff skips the AI when there are no notes', async () => {
  const { handler, prompts, audited } = setup({ notes: [] });
  const { body } = await read(await handler(post({ site_id: SITE, from: FROM, to: TO })));
  assertEquals(body.note_count, 0);
  assertEquals([prompts.length, audited.length], [0, 0]);
});

Deno.test('UC-13 handoff validates the request', async () => {
  const { handler } = setup();
  assertEquals((await read(await handler(post({ site_id: 'nope', from: FROM, to: TO })))).body.error, 'invalid_site_id');
  assertEquals((await read(await handler(post({ site_id: SITE, from: TO, to: FROM })))).body.error, 'invalid_window');
  assertEquals(
    (await read(await handler(post({ site_id: SITE, from: '2026-11-18T00:00:00Z', to: TO })))).body.error,
    'invalid_window',
  );
});

Deno.test('UC-13 handoff requires a signed-in user', async () => {
  const { handler } = setup({ authFails: true });
  const { status } = await read(await handler(post({ site_id: SITE, from: FROM, to: TO })));
  assertEquals(status, 401);
});
