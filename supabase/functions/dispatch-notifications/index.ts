import { ExpoPushClient } from '../../../src/core/integrations/expo-push.ts';
import { ResendClient } from '../../../src/core/integrations/resend.ts';
import { TwilioClient } from '../../../src/core/integrations/twilio.ts';
import { NotificationDispatcher, type ClaimedNotification } from '../../../src/core/notifications/dispatcher.ts';
import { env, optionalEnv } from '../_shared/http.ts';
import { serviceClient, unwrap } from '../_shared/supabase.ts';
import { createDispatchHandler } from './handler.ts';

const db = serviceClient();

const twilioSid = optionalEnv('TWILIO_ACCOUNT_SID');
const sms = twilioSid
  ? new TwilioClient({
      accountSid: twilioSid,
      auth: {
        username: optionalEnv('TWILIO_API_KEY_SID') ?? twilioSid,
        password: optionalEnv('TWILIO_API_KEY_SECRET') ?? env('TWILIO_AUTH_TOKEN'),
      },
      messagingServiceSid: optionalEnv('TWILIO_MESSAGING_SERVICE_SID'),
      from: optionalEnv('TWILIO_FROM_NUMBER'),
    })
  : undefined;

const dispatcher = new NotificationDispatcher({
  push: new ExpoPushClient({ accessToken: optionalEnv('EXPO_ACCESS_TOKEN') }),
  email: new ResendClient({ apiKey: env('RESEND_API_KEY'), from: env('RESEND_FROM') }),
  sms,
});

Deno.serve(
  createDispatchHandler({
    cronSecret: env('CRON_SECRET'),
    dispatcher,
    claim: async (limit) => unwrap(await db.rpc('claim_notifications', { p_limit: limit })) as ClaimedNotification[],
    complete: async (o) => {
      unwrap(await db.rpc('complete_notification', { p_id: o.id, p_ok: o.ok, p_error: o.error ?? null, p_retryable: o.retryable }));
    },
    forgetToken: async (token) => {
      unwrap(await db.rpc('forget_device_token', { p_token: token }));
    },
  }),
);
