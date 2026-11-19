import { IntegrationError, isRetryableStatus, readJson, send, type HttpOptions } from './http.ts';

/**
 * Twilio Programmable Messaging (checked Nov 2026):
 *   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
 *   form-encoded To, Body, and From or MessagingServiceSid; HTTP Basic auth.
 *   Response { sid, status }.
 * https://www.twilio.com/docs/messaging/api/message-resource
 *
 * Basic auth uses an API key SID and secret when given (Twilio's
 * recommendation for production), otherwise the Account SID and Auth Token.
 */
export type TwilioConfig = HttpOptions & {
  accountSid: string;
  auth: { username: string; password: string };
  /** A Messaging Service is preferred; a single From number also works. */
  messagingServiceSid?: string;
  from?: string;
};

// Errors that will fail the same way every time, so retrying only costs money.
// 21211 invalid To number, 21610 recipient opted out (STOP), 21614 not a mobile number.
const PERMANENT_CODES = new Set([21211, 21610, 21614]);

export class TwilioClient {
  constructor(private readonly config: TwilioConfig) {
    if (!config.messagingServiceSid && !config.from) {
      throw new Error('Twilio needs a messagingServiceSid or a from number.');
    }
  }

  async sendSms(to: string, body: string): Promise<{ sid: string; status: string }> {
    if (!/^\+[1-9]\d{7,14}$/.test(to)) {
      throw new IntegrationError('twilio', 'invalid_number', false);
    }
    const form = new URLSearchParams({ To: to, Body: body });
    if (this.config.messagingServiceSid) form.set('MessagingServiceSid', this.config.messagingServiceSid);
    else form.set('From', this.config.from as string);

    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/Messages.json`;
    const response = await send(
      'twilio',
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${this.config.auth.username}:${this.config.auth.password}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      },
      {
        ...this.config,
        // A message POST is not idempotent at Twilio, so a timeout after the
        // request left could mean it was sent. Retry only what Twilio refused.
        retries: this.config.retries ?? 1,
        retryNetworkErrors: false,
        onError: async (res) => {
          const err = await readJson<{ code?: number; message?: string }>(res);
          const permanent = err?.code !== undefined && PERMANENT_CODES.has(err.code);
          return new IntegrationError(
            'twilio',
            err?.code ? `twilio_${err.code}` : 'request_failed',
            !permanent && isRetryableStatus(res.status),
            res.status,
          );
        },
      },
    );
    const message = await readJson<{ sid?: string; status?: string }>(response);
    if (!message?.sid) throw new IntegrationError('twilio', 'missing_sid', false);
    return { sid: message.sid, status: message.status ?? 'queued' };
  }
}
