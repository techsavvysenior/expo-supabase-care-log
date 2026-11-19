import * as Sentry from '@sentry/react-native';

import { scrubBreadcrumb, scrubEvent } from '@/core/privacy/scrub';

/**
 * Crash reporting with health information stripped on the device, before
 * anything is sent. Session replay is never enabled: a screen recording of a
 * care app is a recording of patient records.
 */
export function initSentry(): void {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.EXPO_PUBLIC_APP_ENV ?? 'development',
    sendDefaultPii: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    tracesSampleRate: 0.1,
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  });
}

/** Tags errors with the user's opaque id only. */
export function identifyForCrashes(userId: string | null): void {
  Sentry.setUser(userId ? { id: userId } : null);
}

export const wrapRoot = Sentry.wrap;
export const captureException = Sentry.captureException;
