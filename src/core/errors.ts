/**
 * Errors the UI knows how to explain. Database rules raise their name in
 * capitals (e.g. REASON_REQUIRED); this maps them to plain sentences so the
 * same rule reads the same way on every screen.
 */

export const RULE_MESSAGES = {
  FORBIDDEN: "You don't have access to do that here.",
  NOT_AUTHENTICATED: 'Please sign in again.',
  LAST_ADMIN: 'Every organization needs at least one admin. Make someone else an admin first.',
  NOT_A_MEMBER: 'That person is not part of this organization.',
  SITE_NOT_IN_ORGANIZATION: 'One of the chosen sites belongs to a different organization.',
  INVITATION_NOT_FOUND: "That invitation link isn't valid.",
  INVITATION_ALREADY_USED: 'That invitation has already been used.',
  INVITATION_EXPIRED: 'That invitation has expired. Ask your admin for a new one.',
  INVITATION_EMAIL_MISMATCH: 'Sign in with the email address the invitation was sent to.',
  AMENDED_NOTE_NOT_FOUND: 'The note you are correcting was not found for this resident.',
  RECORDS_ARE_APPEND_ONLY: 'Care records cannot be changed. Add a correction instead.',
  MISSED_IS_SYSTEM_RECORDED: 'Missed doses are recorded automatically.',
  REASON_REQUIRED: 'Add a reason when a dose is refused or held.',
  ORDER_NOT_ACTIVE: 'This medication order is not active on that date.',
  NOT_A_SCHEDULED_TIME: 'That time is not on the medication order.',
  TOO_EARLY: 'Doses can be recorded from one hour before their scheduled time.',
  DOSE_ALREADY_RECORDED: 'Someone already recorded this dose. Refresh to see it.',
  UNKNOWN_TIMEZONE: 'That time zone is not recognized.',
  AI_NOT_ENABLED: 'AI handoff drafts are turned off for your organization.',
  ADDRESS_NOT_FOUND: "Google couldn't find that address. Check it and try again.",
} as const;

export type Rule = keyof typeof RULE_MESSAGES;

export function ruleFromMessage(message: string | undefined | null): Rule | undefined {
  if (!message) return undefined;
  const match = message.match(/\b[A-Z][A-Z_]{4,}\b/g)?.find((word): word is Rule => word in RULE_MESSAGES);
  return match;
}

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly retryable: boolean;
  /** Safe to show a user. */
  abstract readonly userMessage: string;
}

export class RuleViolationError extends AppError {
  readonly code: Rule;
  readonly retryable = false;
  readonly userMessage: string;
  constructor(rule: Rule) {
    super(rule);
    this.code = rule;
    this.userMessage = RULE_MESSAGES[rule];
  }
}

export class OfflineError extends AppError {
  readonly code = 'offline';
  readonly retryable = true;
  readonly userMessage = "You're offline. This will be saved and sent when you reconnect.";
}

export class ServiceUnavailableError extends AppError {
  readonly code = 'service_unavailable';
  readonly retryable = true;
  readonly userMessage = 'The service is not responding. Please try again in a moment.';
}

export class UnexpectedError extends AppError {
  readonly code = 'unexpected';
  readonly retryable = false;
  readonly userMessage = 'Something went wrong. It has been reported.';
}

/** Anything Supabase, fetch or our functions can throw, as an AppError. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;

  const rule = ruleFromMessage(message);
  if (rule) return new RuleViolationError(rule);
  if (code === '42501' || /permission denied|row-level security/i.test(message)) return new RuleViolationError('FORBIDDEN');
  if (/network request failed|failed to fetch|network error|offline/i.test(message)) return new OfflineError(message);
  if (/timeout|503|502|504/i.test(message)) return new ServiceUnavailableError(message);
  return new UnexpectedError(message, { cause: error });
}
