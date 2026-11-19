/**
 * Crash reports and analytics are useful only if they never carry health
 * information. These functions run on every Sentry event and breadcrumb and
 * on every analytics event, before anything leaves the device.
 */

// Loose shapes so this file has no Sentry dependency and runs in Deno and Node.
type SentryLikeEvent = {
  user?: Record<string, unknown> | null;
  request?: { data?: unknown; query_string?: unknown; cookies?: unknown; headers?: Record<string, string>; url?: string } | null;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  breadcrumbs?: SentryLikeBreadcrumb[];
  exception?: { values?: { value?: string }[] };
  message?: string;
};

type SentryLikeBreadcrumb = { category?: string; message?: string; data?: Record<string, unknown> } | null;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;
const DATE = /\b(19|20)\d{2}-\d{2}-\d{2}\b/g;

/** Masks emails, phone numbers and dates (dates of birth are identifiers). */
export function redactText(text: string): string {
  return text.replace(EMAIL, '[email]').replace(DATE, '[date]').replace(PHONE, '[phone]');
}

/** Keeps the path of a URL and drops the query string, which can carry search terms. */
export function stripQuery(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : `${url.slice(0, index)}?[redacted]`;
}

export function scrubEvent<T extends SentryLikeEvent>(event: T): T {
  const scrubbed: T = { ...event };
  // Only the opaque user id, never email or name.
  if (scrubbed.user) scrubbed.user = typeof scrubbed.user.id === 'string' ? { id: scrubbed.user.id } : null;
  if (scrubbed.request) {
    scrubbed.request = {
      url: scrubbed.request.url ? stripQuery(scrubbed.request.url) : undefined,
    };
  }
  // Request and response bodies (a care note being saved) never go to Sentry.
  delete scrubbed.extra;
  if (scrubbed.contexts) {
    const { app, device, os, runtime, trace } = scrubbed.contexts;
    scrubbed.contexts = { app, device, os, runtime, trace };
  }
  if (scrubbed.message) scrubbed.message = redactText(scrubbed.message);
  if (scrubbed.exception?.values) {
    scrubbed.exception = {
      ...scrubbed.exception,
      values: scrubbed.exception.values.map((v) => ({ ...v, value: v.value ? redactText(v.value) : v.value })),
    };
  }
  if (scrubbed.breadcrumbs) {
    scrubbed.breadcrumbs = scrubbed.breadcrumbs.map(scrubBreadcrumb).filter((b): b is NonNullable<typeof b> => b !== null);
  }
  return scrubbed;
}

/**
 * Network breadcrumbs keep method, status and the URL path. Console and UI
 * breadcrumbs are dropped: console logs and tapped labels can contain names.
 */
export function scrubBreadcrumb<T extends SentryLikeBreadcrumb>(crumb: T): T | null {
  if (!crumb) return null;
  if (crumb.category === 'console' || crumb.category?.startsWith('ui.')) return null;
  if (crumb.category === 'xhr' || crumb.category === 'fetch') {
    const data = crumb.data ?? {};
    return {
      ...crumb,
      data: {
        method: data.method,
        status_code: data.status_code,
        url: typeof data.url === 'string' ? stripQuery(data.url) : undefined,
      },
    };
  }
  return { ...crumb, message: crumb.message ? redactText(crumb.message) : crumb.message, data: undefined };
}
