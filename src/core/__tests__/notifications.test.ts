import { IntegrationError } from '../integrations/http';
import { NotificationDispatcher, type Channels, type ClaimedNotification } from '../notifications/dispatcher';
import { FORBIDDEN_IN_MESSAGES, render, TEMPLATES } from '../notifications/templates';

const ids = {
  site_id: '11111111-1111-4111-8111-111111111111',
  resident_id: '33333333-3333-4333-8333-333333333333',
  note_id: '44444444-4444-4444-8444-444444444444',
};

describe('UC-12 notification wording', () => {
  it.each(TEMPLATES)('UC-12 %s says nothing clinical and fits one SMS', (template) => {
    const message = render(template, ids);
    for (const text of [message.title, message.body, message.emailSubject, message.sms]) {
      expect(text).not.toMatch(FORBIDDEN_IN_MESSAGES);
    }
    expect(message.sms.length).toBeLessThanOrEqual(160);
    expect(message.url).toMatch(/^carelog:\/\//);
  });
});

function notification(overrides: Partial<ClaimedNotification> = {}): ClaimedNotification {
  return {
    id: 7,
    template: 'incident_reported',
    payload: ids,
    attempts: 1,
    recipient_id: 'u1',
    email: 'nurse@example.com',
    phone_e164: '+15405550100',
    push_enabled: true,
    email_enabled: true,
    sms_enabled: true,
    push_tokens: ['ExponentPushToken[a]'],
    ...overrides,
  };
}

function channels(overrides: Partial<Channels> = {}) {
  const push = { send: jest.fn(async (msgs: { to: string }[]) => msgs.map((m) => ({ token: m.to, ok: true as const, ticketId: 't' }))) };
  const email = { send: jest.fn(async () => ({ id: 'em' })) };
  const sms = { sendSms: jest.fn(async () => ({ sid: 'SM' })) };
  return { push, email, sms, ...overrides };
}

describe('UC-12 dispatcher', () => {
  it('UC-12 sends push and email, and keeps SMS for missed doses only', async () => {
    const c = channels();
    const outcome = await new NotificationDispatcher(c).dispatch(notification());
    expect(outcome).toMatchObject({ ok: true, sentVia: ['push', 'email'] });
    expect(c.sms.sendSms).not.toHaveBeenCalled();

    const missed = await new NotificationDispatcher(c).dispatch(notification({ template: 'dose_missed' }));
    expect(missed.sentVia).toEqual(['push', 'email', 'sms']);
  });

  it('UC-12 respects each persons channel settings', async () => {
    const c = channels();
    const outcome = await new NotificationDispatcher(c).dispatch(
      notification({ template: 'dose_missed', push_enabled: false, email_enabled: false, sms_enabled: false }),
    );
    expect(outcome).toMatchObject({ ok: false, retryable: false, error: 'no_channel' });
    expect(c.push.send).not.toHaveBeenCalled();
  });

  it('UC-12 counts a message delivered when any channel accepts it', async () => {
    const c = channels({ email: { send: jest.fn(async () => Promise.reject(new IntegrationError('resend', 'timeout', true))) } });
    const outcome = await new NotificationDispatcher(c).dispatch(notification());
    expect(outcome).toMatchObject({ ok: true, sentVia: ['push'] });
  });

  it('UC-12 asks for a retry when every channel failed for a temporary reason', async () => {
    const c = channels({
      push: { send: jest.fn(async () => Promise.reject(new IntegrationError('expo-push', 'timeout', true))) },
      email: { send: jest.fn(async () => Promise.reject(new IntegrationError('resend', 'validation_error', false))) },
    });
    const outcome = await new NotificationDispatcher(c).dispatch(notification());
    expect(outcome).toMatchObject({ ok: false, retryable: true, error: 'expo-push:timeout, resend:validation_error' });
  });

  it('UC-12 returns dead push tokens for clean-up', async () => {
    const c = channels({
      push: {
        send: jest.fn(async () => [{ token: 'ExponentPushToken[a]', ok: false as const, error: 'DeviceNotRegistered', unregistered: true }]),
      },
    });
    const outcome = await new NotificationDispatcher(c).dispatch(notification());
    expect(outcome.deadTokens).toEqual(['ExponentPushToken[a]']);
    expect(outcome.sentVia).toEqual(['email']);
  });

  it('UC-12 uses the outbox id as the email idempotency key', async () => {
    const c = channels();
    await new NotificationDispatcher(c).dispatch(notification({ id: 42 }));
    expect(c.email.send).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'notification-42' }));
  });
});
