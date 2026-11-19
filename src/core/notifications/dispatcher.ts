import type { PushMessage, PushResult } from '../integrations/expo-push.ts';
import { IntegrationError } from '../integrations/http.ts';
import { render, type Payload, type Template } from './templates.ts';

/** One row from claim_notifications(). */
export type ClaimedNotification = {
  id: number;
  template: Template;
  payload: Payload;
  attempts: number;
  recipient_id: string;
  email: string | null;
  phone_e164: string | null;
  push_enabled: boolean;
  email_enabled: boolean;
  sms_enabled: boolean;
  push_tokens: string[];
};

export type Channels = {
  push: { send(messages: PushMessage[]): Promise<PushResult[]> };
  email: { send(email: { to: string; subject: string; text: string; idempotencyKey: string }): Promise<{ id: string }> };
  sms?: { sendSms(to: string, body: string): Promise<{ sid: string }> };
};

export type Outcome = {
  id: number;
  ok: boolean;
  /** False when trying again would fail the same way. */
  retryable: boolean;
  error?: string;
  sentVia: ('push' | 'email' | 'sms')[];
  deadTokens: string[];
};

/**
 * Sends one notification on every channel the person allows. It counts as
 * delivered when at least one channel accepted it; push tokens that Expo
 * reports as unregistered are returned so the caller can delete them.
 *
 * Only dose_missed goes by SMS: it is the one alert that can't wait for
 * someone to open the app, and SMS costs money per message.
 */
export class NotificationDispatcher {
  constructor(private readonly channels: Channels) {}

  async dispatch(n: ClaimedNotification): Promise<Outcome> {
    const message = render(n.template, n.payload);
    const sentVia: Outcome['sentVia'] = [];
    const errors: { error: string; retryable: boolean }[] = [];
    const deadTokens: string[] = [];

    if (n.push_enabled && n.push_tokens.length > 0) {
      try {
        const results = await this.channels.push.send(
          n.push_tokens.map((to) => ({ to, title: message.title, body: message.body, data: { url: message.url }, sound: 'default' as const })),
        );
        for (const result of results) {
          if (!result.ok && result.unregistered) deadTokens.push(result.token);
        }
        if (results.some((r) => r.ok)) sentVia.push('push');
        else errors.push({ error: 'push_rejected', retryable: deadTokens.length < results.length });
      } catch (error) {
        errors.push(describe(error));
      }
    }

    if (n.email_enabled && n.email) {
      try {
        await this.channels.email.send({
          to: n.email,
          subject: message.emailSubject,
          text: `${message.body}\n\n${message.url}`,
          idempotencyKey: `notification-${n.id}`,
        });
        sentVia.push('email');
      } catch (error) {
        errors.push(describe(error));
      }
    }

    if (n.template === 'dose_missed' && n.sms_enabled && n.phone_e164 && this.channels.sms) {
      try {
        await this.channels.sms.sendSms(n.phone_e164, message.sms);
        sentVia.push('sms');
      } catch (error) {
        errors.push(describe(error));
      }
    }

    if (sentVia.length > 0) return { id: n.id, ok: true, retryable: false, sentVia, deadTokens };
    if (errors.length === 0) {
      // Nothing enabled or no address on file. Retrying won't change that.
      return { id: n.id, ok: false, retryable: false, error: 'no_channel', sentVia, deadTokens };
    }
    return {
      id: n.id,
      ok: false,
      retryable: errors.some((e) => e.retryable),
      error: errors.map((e) => e.error).join(', '),
      sentVia,
      deadTokens,
    };
  }
}

function describe(error: unknown): { error: string; retryable: boolean } {
  if (error instanceof IntegrationError) return { error: `${error.provider}:${error.code}`, retryable: error.retryable };
  return { error: 'unexpected', retryable: true };
}
