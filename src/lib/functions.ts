import { FunctionsHttpError } from '@supabase/supabase-js';

import { RuleViolationError, ruleFromMessage, ServiceUnavailableError, toAppError } from '@/core/errors';
import { supabase } from '@/lib/supabase';

/**
 * Calls an Edge Function with the signed-in user's token and turns its JSON
 * error codes into the same AppErrors the database rules produce.
 */
export async function invokeFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, { body });
  if (!error) return data as T;

  if (error instanceof FunctionsHttpError) {
    const payload = (await error.context.json().catch(() => ({}))) as { error?: string };
    const rule = ruleFromMessage(payload.error);
    if (rule) throw new RuleViolationError(rule);
    if (error.context.status >= 500) throw new ServiceUnavailableError(payload.error ?? name);
  }
  throw toAppError(error);
}

/** Runs a Postgres function and throws its error as an AppError. */
export async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw toAppError(error);
  return data as T;
}
