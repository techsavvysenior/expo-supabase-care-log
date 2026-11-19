import PostHog from 'posthog-react-native';

import { Analytics } from '@/core/analytics/events';

/**
 * PostHog for product analytics and feature flags. Autocapture of screens and
 * taps is off: screen names include resident ids and tapped labels include
 * names. Every event goes through Analytics.track(), which drops anything not
 * on the allow-list.
 */
export const FLAGS = {
  aiHandoff: 'ai-handoff-drafts',
} as const;

export function createPostHog(): PostHog | undefined {
  const key = process.env.EXPO_PUBLIC_POSTHOG_KEY;
  if (!key) return undefined;
  return new PostHog(key, {
    host: process.env.EXPO_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
    captureAppLifecycleEvents: true,
    enableSessionReplay: false,
    disabled: process.env.EXPO_PUBLIC_APP_ENV === 'development',
  });
}

export function createAnalytics(posthog: PostHog | undefined): Analytics {
  return new Analytics(posthog ? { capture: (name, properties) => posthog.capture(name, properties) } : undefined);
}

/** A flag that is off until PostHog has loaded and says otherwise. */
export function isFlagOn(posthog: PostHog | undefined, flag: string): boolean {
  return posthog?.isFeatureEnabled(flag) === true;
}
