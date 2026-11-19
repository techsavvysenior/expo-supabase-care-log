import { IntegrationError, isRetryableStatus, readJson, send, type HttpOptions } from './http.ts';

/**
 * Resend (checked Nov 2026): POST https://api.resend.com/emails with
 * `Authorization: Bearer <key>`, body { from, to, subject, html?, text? },
 * response { id }. An `Idempotency-Key` header (up to 256 characters, kept
 * 24 hours) makes a retried send safe.
 * https://resend.com/docs/api-reference/emails/send-email
 */
export const RESEND_URL = 'https://api.resend.com/emails';

export type Email = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Same key, same email: a retry after a timeout won't send it twice. */
  idempotencyKey: string;
};

export class ResendClient {
  constructor(private readonly config: HttpOptions & { apiKey: string; from: string }) {}

  async send(email: Email): Promise<{ id: string }> {
    const response = await send(
      'resend',
      RESEND_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': email.idempotencyKey.slice(0, 256),
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          ...(email.html ? { html: email.html } : {}),
        }),
      },
      {
        ...this.config,
        onError: async (res) => {
          const body = await readJson<{ name?: string; message?: string }>(res);
          return new IntegrationError('resend', body?.name ?? 'request_failed', isRetryableStatus(res.status), res.status);
        },
      },
    );
    const body = await readJson<{ id?: string }>(response);
    if (!body?.id) throw new IntegrationError('resend', 'missing_id', false);
    return { id: body.id };
  }
}
