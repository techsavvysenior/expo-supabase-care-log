import type { ClaimedNotification, NotificationDispatcher, Outcome } from '../../../src/core/notifications/dispatcher.ts';
import { HttpError, json, route, timingSafeEqual } from '../_shared/http.ts';

export type DispatchDeps = {
  cronSecret: string;
  claim(limit: number): Promise<ClaimedNotification[]>;
  complete(outcome: Outcome): Promise<void>;
  forgetToken(token: string): Promise<void>;
  dispatcher: Pick<NotificationDispatcher, 'dispatch'>;
  batchSize?: number;
};

/**
 * Called every minute by pg_cron (supabase/schedules.sql) with a shared
 * secret header. Claims a batch from the outbox, sends each message, reports
 * every result back, and deletes push tokens Expo says are dead.
 */
export function createDispatchHandler(deps: DispatchDeps): (req: Request) => Promise<Response> {
  return route(async (req) => {
    const secret = req.headers.get('x-cron-secret') ?? '';
    if (!deps.cronSecret || !timingSafeEqual(secret, deps.cronSecret)) throw new HttpError(401, 'not_authorized');

    const batch = await deps.claim(deps.batchSize ?? 50);
    let sent = 0;
    let failed = 0;
    const forgotten = new Set<string>();

    for (const notification of batch) {
      let outcome: Outcome;
      try {
        outcome = await deps.dispatcher.dispatch(notification);
      } catch {
        outcome = { id: notification.id, ok: false, retryable: true, error: 'dispatch_crashed', sentVia: [], deadTokens: [] };
      }
      await deps.complete(outcome);
      if (outcome.ok) sent++;
      else failed++;
      for (const token of outcome.deadTokens) {
        if (forgotten.has(token)) continue;
        forgotten.add(token);
        await deps.forgetToken(token);
      }
    }

    return json({ claimed: batch.length, sent, failed, tokens_removed: forgotten.size });
  });
}
