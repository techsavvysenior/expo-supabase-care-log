import NetInfo from '@react-native-community/netinfo';
import * as SecureStore from 'expo-secure-store';

import { OfflineQueue, type QueuedWrite, type QueueState } from '@/core/offline/queue';
import { createChunkedStorage } from '@/lib/chunked-storage';
import { rpc } from '@/lib/functions';

/**
 * Queued notes contain care information, so the queue is kept in the
 * Keychain / Keystore (encrypted at rest), not in plain AsyncStorage.
 */
const QUEUE_KEY = 'carelog.offline-queue.v1';
const store = createChunkedStorage(SecureStore);

const storage = {
  load: async (): Promise<QueueState | null> => {
    const raw = await store.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueueState) : null;
  },
  save: (state: QueueState) => store.setItem(QUEUE_KEY, JSON.stringify(state)),
};

export const offlineQueue = new OfflineQueue(storage);

/** Sends one queued write through the same database functions the app uses online. */
export async function sendQueued(item: QueuedWrite): Promise<void> {
  if (item.kind === 'care_note') {
    await rpc('add_care_note', {
      p_resident: item.payload.residentId,
      p_kind: item.payload.noteKind,
      p_body: item.payload.body,
      p_occurred_at: item.payload.occurredAt,
      p_client_ref: item.clientRef,
      p_amends: item.payload.amends ?? null,
    });
  } else {
    await rpc('record_dose', {
      p_order: item.payload.orderId,
      p_scheduled_for: item.payload.scheduledFor,
      p_status: item.payload.status,
      p_reason: item.payload.reason ?? null,
      p_client_ref: item.clientRef,
    });
  }
}

/** Flushes whenever the device comes back online. Returns the unsubscribe. */
export function flushWhenOnline(onFlushed: (sent: number, failed: number) => void): () => void {
  return NetInfo.addEventListener((state) => {
    if (state.isConnected && state.isInternetReachable !== false) {
      void offlineQueue.flush(sendQueued).then((r) => {
        if (r.sent || r.failed) onFlushed(r.sent, r.failed);
      });
    }
  });
}

/** Clears the queue on sign-out so one person's drafts never reach another. */
export async function clearOfflineQueue(): Promise<void> {
  await store.removeItem(QUEUE_KEY);
}
