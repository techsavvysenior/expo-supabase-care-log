import assert from 'node:assert/strict';

/** node:assert works in Deno and needs no registry download. */
export const assertEquals = (actual: unknown, expected: unknown) => assert.deepStrictEqual(actual, expected);
export const assertStringIncludes = (actual: string, expected: string) => assert.ok(actual.includes(expected), `expected "${actual}" to include "${expected}"`);

/** Builds requests for handler tests. No network, no Supabase. */
export function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/fn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt', ...headers },
    body: JSON.stringify(body),
  });
}

export async function read(response: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: response.status, body: await response.json() };
}

export const SITE = '11111111-1111-4111-8111-111111111111';
export const ORG = '22222222-2222-4222-8222-222222222222';
export const RESIDENT = '33333333-3333-4333-8333-333333333333';
export const NOTE = '44444444-4444-4444-8444-444444444444';
