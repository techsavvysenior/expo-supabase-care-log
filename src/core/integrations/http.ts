/**
 * One way to call a third-party HTTP API: timeouts, retries for failures that
 * can clear up on their own, and errors that say which provider failed and
 * whether trying again could help.
 *
 * Plain TypeScript with an injected fetch, so the same code runs in the
 * Edge Functions (Deno) and in the unit tests (Node) without a network.
 */

export type Provider = 'expo-push' | 'resend' | 'twilio' | 'openai' | 'google-geocoding';

export class IntegrationError extends Error {
  constructor(
    readonly provider: Provider,
    readonly code: string,
    readonly retryable: boolean,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(`${provider}: ${code}${status ? ` (HTTP ${status})` : ''}`, options);
    this.name = 'IntegrationError';
  }
}

export type HttpOptions = {
  fetch?: typeof fetch;
  /** Per attempt. */
  timeoutMs?: number;
  /** Extra attempts after the first, for 429, 5xx and network errors. */
  retries?: number;
  /** Injected so tests don't wait. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Retry when the request may never have arrived (timeout, connection
   * reset). Off for calls that are not idempotent at the provider, where the
   * first request might have been accepted after all.
   */
  retryNetworkErrors?: boolean;
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** Exponential backoff with full jitter, capped. attempt starts at 1. */
export function backoffMs(attempt: number, random: () => number = Math.random, baseMs = 250, capMs = 4000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

/** Honors Retry-After (seconds or an HTTP date) when the provider sends one. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sends a request and returns the response once it is 2xx. Retries 429, 5xx,
 * timeouts and network failures. Any other status is returned to the caller
 * through `onError`, which turns the provider's error body into an
 * IntegrationError.
 */
export async function send(
  provider: Provider,
  url: string,
  init: RequestInit,
  options: HttpOptions & { onError: (response: Response) => Promise<IntegrationError> },
): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const attempts = 1 + (options.retries ?? 2);
  let lastError: IntegrationError | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response;
    try {
      response = await doFetch(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      lastError = new IntegrationError(provider, timedOut ? 'timeout' : 'network_error', true, undefined, { cause: error });
      if (options.retryNetworkErrors === false) throw lastError;
      if (attempt < attempts) await sleep(backoffMs(attempt));
      continue;
    }

    if (response.ok) return response;

    lastError = await options.onError(response);
    if (!lastError.retryable || attempt === attempts) throw lastError;
    await sleep(retryAfterMs(response.headers.get('retry-after')) ?? backoffMs(attempt));
  }
  throw lastError ?? new IntegrationError(provider, 'unknown', false);
}

/** Reads a JSON body without throwing on an empty or malformed one. */
export async function readJson<T>(response: Response): Promise<T | undefined> {
  try {
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}
