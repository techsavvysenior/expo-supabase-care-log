import { toAppError } from '../errors.ts';

/**
 * Care happens in basements and back bedrooms with no signal. Notes and dose
 * records are queued on the device and sent when the connection returns.
 *
 * Each item carries a client_ref generated when the person pressed Save. The
 * database treats a second write with the same client_ref as the first one,
 * so a send that timed out after it reached the server is never duplicated.
 *
 * Items are sent in the order they were made. A rule error (dose already
 * recorded, access removed) won't change on retry, so that item is set aside
 * for the person to see, and the rest of the queue keeps going.
 */

export type QueuedWrite =
  | {
      kind: 'care_note';
      clientRef: string;
      createdAt: string;
      payload: { residentId: string; noteKind: string; body: string; occurredAt: string; amends?: string | null };
    }
  | {
      kind: 'dose';
      clientRef: string;
      createdAt: string;
      payload: { orderId: string; scheduledFor: string; status: 'given' | 'refused' | 'held'; reason?: string | null };
    };

export type FailedWrite = QueuedWrite & { error: string; failedAt: string };

export type QueueState = { pending: QueuedWrite[]; failed: FailedWrite[] };

export type QueueStorage = {
  load(): Promise<QueueState | null>;
  save(state: QueueState): Promise<void>;
};

export type Sender = (item: QueuedWrite) => Promise<void>;

export type FlushResult = { sent: number; failed: number; stoppedOffline: boolean };

export class OfflineQueue {
  private state: QueueState = { pending: [], failed: [] };
  private loaded = false;
  private flushing: Promise<FlushResult> | null = null;
  private listeners = new Set<(state: QueueState) => void>();

  constructor(
    private readonly storage: QueueStorage,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(): Promise<QueueState> {
    if (!this.loaded) {
      this.state = (await this.storage.load()) ?? { pending: [], failed: [] };
      this.loaded = true;
    }
    return this.state;
  }

  subscribe(listener: (state: QueueState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async enqueue(item: QueuedWrite): Promise<void> {
    await this.load();
    if (this.state.pending.some((p) => p.clientRef === item.clientRef)) return;
    await this.update({ ...this.state, pending: [...this.state.pending, item] });
  }

  async dismissFailed(clientRef: string): Promise<void> {
    await this.load();
    await this.update({ ...this.state, failed: this.state.failed.filter((f) => f.clientRef !== clientRef) });
  }

  /** Sends pending items in order. Concurrent calls share one run. */
  flush(send: Sender): Promise<FlushResult> {
    this.flushing ??= this.run(send).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async run(send: Sender): Promise<FlushResult> {
    await this.load();
    let sent = 0;
    let failed = 0;
    while (this.state.pending.length > 0) {
      const [item, ...rest] = this.state.pending;
      try {
        await send(item);
        sent++;
        await this.update({ ...this.state, pending: rest });
      } catch (error) {
        const appError = toAppError(error);
        if (appError.retryable) {
          return { sent, failed, stoppedOffline: true };
        }
        failed++;
        await this.update({
          pending: rest,
          failed: [...this.state.failed, { ...item, error: appError.userMessage, failedAt: this.now().toISOString() }],
        });
      }
    }
    return { sent, failed, stoppedOffline: false };
  }

  private async update(state: QueueState): Promise<void> {
    this.state = state;
    await this.storage.save(state);
    for (const listener of this.listeners) listener(state);
  }
}
