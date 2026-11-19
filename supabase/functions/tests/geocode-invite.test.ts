import type { GeocodeResult } from '../../../src/core/integrations/geocoding.ts';
import { createGeocodeHandler } from '../geocode-site/handler.ts';
import { createInviteHandler } from '../invite-staff/handler.ts';
import { ORG, SITE, assertEquals, assertStringIncludes, post, read } from './helpers.ts';

const exact: GeocodeResult = {
  latitude: 38.98,
  longitude: -77.61,
  placeId: 'place-1',
  formattedAddress: '1 Main St, Aldie, VA 20105, USA',
  partialMatch: false,
};

function geocodeSetup(result: GeocodeResult | undefined, isAdmin = true) {
  const saved: string[] = [];
  const handler = createGeocodeHandler({
    siteFor: () => Promise.resolve({ address: '1 Main St, Aldie, VA', isAdmin }),
    geocoder: { geocode: () => Promise.resolve(result) },
    saveLocation: (siteId) => {
      saved.push(siteId);
      return Promise.resolve();
    },
  });
  return { handler, saved };
}

Deno.test('UC-14 geocode saves an exact match', async () => {
  const { handler, saved } = geocodeSetup(exact);
  const { status, body } = await read(await handler(post({ site_id: SITE })));
  assertEquals(status, 200);
  assertEquals(body.saved, true);
  assertEquals(saved, [SITE]);
});

Deno.test('UC-14 geocode asks before saving an approximate match', async () => {
  const { handler, saved } = geocodeSetup({ ...exact, partialMatch: true });
  const first = await read(await handler(post({ site_id: SITE })));
  assertEquals(first.body.needs_confirmation, true);
  assertEquals(saved.length, 0);
  const confirmed = await read(await handler(post({ site_id: SITE, accept_partial: true })));
  assertEquals(confirmed.body.saved, true);
});

Deno.test('UC-14 geocode refuses non-admins and unknown addresses', async () => {
  assertEquals((await read(await geocodeSetup(exact, false).handler(post({ site_id: SITE })))).status, 403);
  const missing = await read(await geocodeSetup(undefined).handler(post({ site_id: SITE })));
  assertEquals([missing.status, missing.body.error], [422, 'ADDRESS_NOT_FOUND']);
});

function inviteSetup(fail?: Error) {
  const emails: { to: string; text: string; idempotencyKey: string }[] = [];
  const handler = createInviteHandler({
    linkBase: 'carelog://invite?token=',
    createInvitation: () =>
      fail ? Promise.reject(fail) : Promise.resolve({ invitationId: 'inv-1', token: 'tok123', organizationName: 'Provider A' }),
    email: {
      send: (e) => {
        emails.push(e);
        return Promise.resolve({ id: 'em-1' });
      },
    },
  });
  return { handler, emails };
}

Deno.test('UC-02 invite emails the link and does not return the token', async () => {
  const { handler, emails } = inviteSetup();
  const { status, body } = await read(await handler(post({ org_id: ORG, email: ' New@Example.com ', role: 'nurse' })));
  assertEquals(status, 201);
  assertEquals(body, { invitation_id: 'inv-1', emailed: true });
  assertEquals(emails[0].to, 'new@example.com');
  assertStringIncludes(emails[0].text, 'carelog://invite?token=tok123');
  assertEquals(emails[0].idempotencyKey, 'invitation-inv-1');
});

Deno.test('UC-02 invite requires a site for caregivers and a valid role and email', async () => {
  const { handler } = inviteSetup();
  assertEquals((await read(await handler(post({ org_id: ORG, email: 'a@b.co', role: 'caregiver' })))).body.error, 'caregiver_needs_a_site');
  assertEquals((await read(await handler(post({ org_id: ORG, email: 'a@b.co', role: 'owner' })))).body.error, 'invalid_role');
  assertEquals((await read(await handler(post({ org_id: ORG, email: 'nope', role: 'nurse' })))).body.error, 'invalid_email');
});

Deno.test('UC-02 invite passes database rules through as errors', async () => {
  const { handler, emails } = inviteSetup(new Error('FORBIDDEN'));
  const { status, body } = await read(await handler(post({ org_id: ORG, email: 'a@b.co', role: 'nurse' })));
  assertEquals([status, body.error], [403, 'FORBIDDEN']);
  assertEquals(emails.length, 0);
});
