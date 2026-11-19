/** Request plumbing shared by every function. No Supabase import, so handlers stay unit-testable. */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

/**
 * Wraps a handler: answers CORS preflight, allows POST only, and turns errors
 * into JSON. Database rule names (REASON_REQUIRED, FORBIDDEN...) pass through
 * as the error code. Anything else is logged and returned as a bare 500, so
 * no stack trace or record content reaches the caller.
 */
export function route(handler: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    try {
      return await handler(req);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.code }, error.status);
      const rule = ruleName(error);
      if (rule) return json({ error: rule }, rule === 'FORBIDDEN' ? 403 : 422);
      console.error(JSON.stringify({ level: 'error', message: error instanceof Error ? error.message : String(error) }));
      return json({ error: 'internal_error' }, 500);
    }
  };
}

export function ruleName(error: unknown): string | undefined {
  const message = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : '';
  return message.match(/\b[A-Z][A-Z_]{4,}\b/)?.[0];
}

export async function readBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, `invalid_${field}`);
  return value;
}

export function requireIsoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new HttpError(400, `invalid_${field}`);
  return new Date(value).toISOString();
}

/** Compares secrets without leaking their length or content through timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export function optionalEnv(name: string): string | undefined {
  return Deno.env.get(name) || undefined;
}
