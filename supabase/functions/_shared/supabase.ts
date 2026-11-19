import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env, HttpError } from './http.ts';

/** Bypasses row-level security. Only for the dispatcher and other bookkeeping. */
export function serviceClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * The caller's own client. Every query runs with their JWT, so row-level
 * security decides what the function can read, exactly as in the app.
 */
export async function userClient(req: Request): Promise<{ userId: string; client: SupabaseClient }> {
  const authorization = req.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'not_authenticated');

  const client = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new HttpError(401, 'not_authenticated');
  return { userId: data.user.id, client };
}

/** Throws the Postgres error so route() can map its rule name. */
export function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}
