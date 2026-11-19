import { IntegrationError, readJson, send, type HttpOptions } from './http.ts';

/**
 * Expo push service (checked Nov 2026):
 *   POST https://exp.host/--/api/v2/push/send, up to 100 messages per request.
 *   Each message gets a ticket: { status: 'ok', id } or
 *   { status: 'error', message, details: { error: 'DeviceNotRegistered' | ... } }.
 *   An access token is needed only when "enhanced push security" is on.
 * https://docs.expo.dev/push-notifications/sending-notifications/
 */
export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_PUSH_BATCH = 100;

export type PushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  sound?: 'default';
};

export type PushResult =
  | { token: string; ok: true; ticketId: string }
  | { token: string; ok: false; error: string; unregistered: boolean };

type Ticket = { status: 'ok'; id: string } | { status: 'error'; message?: string; details?: { error?: string } };

export class ExpoPushClient {
  constructor(private readonly options: HttpOptions & { accessToken?: string } = {}) {}

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    const results: PushResult[] = [];
    for (let start = 0; start < messages.length; start += EXPO_PUSH_BATCH) {
      results.push(...(await this.sendBatch(messages.slice(start, start + EXPO_PUSH_BATCH))));
    }
    return results;
  }

  private async sendBatch(batch: PushMessage[]): Promise<PushResult[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (this.options.accessToken) headers.Authorization = `Bearer ${this.options.accessToken}`;

    const response = await send('expo-push', EXPO_PUSH_URL, { method: 'POST', headers, body: JSON.stringify(batch) }, {
      ...this.options,
      onError: async (res) => {
        const body = await readJson<{ errors?: { code?: string }[] }>(res);
        return new IntegrationError('expo-push', body?.errors?.[0]?.code ?? 'request_failed', res.status >= 500 || res.status === 429, res.status);
      },
    });

    const body = await readJson<{ data?: Ticket[] }>(response);
    const tickets = body?.data ?? [];
    if (tickets.length !== batch.length) {
      throw new IntegrationError('expo-push', 'ticket_count_mismatch', true);
    }
    return tickets.map((ticket, index): PushResult => {
      const token = batch[index].to;
      if (ticket.status === 'ok') return { token, ok: true, ticketId: ticket.id };
      const error = ticket.details?.error ?? ticket.message ?? 'unknown';
      return { token, ok: false, error, unregistered: error === 'DeviceNotRegistered' };
    });
  }
}
