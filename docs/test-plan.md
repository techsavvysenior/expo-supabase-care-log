# Test plan

## What is tested where

| Level | Tool | What it proves | Runs |
|---|---|---|---|
| Database | `node --test` with [PGlite](https://pglite.dev) (real Postgres in process) | Row-level security, grants, triggers and every database function, as SQL, against the real migrations. Each test signs in as a specific role. | Every push (CI job `database`) |
| Edge Functions | `deno test` | Each function's handler with its dependencies injected: auth, validation, error mapping, and that names never reach OpenAI. | Every push (CI job `functions`) |
| Unit | Jest (`jest-expo`) | The third-party clients against recorded API shapes (no network), notification wording, privacy scrubbing, the offline queue, dose-window rules, role model drift. Coverage gate: 90% lines, 75% branches on `src/core`. | Every push (CI job `app`) |
| Static | `tsc`, ESLint, `deno check` | Types across app, shared core and functions. | Every push |
| Build | `expo export` for iOS and Android | The app bundles for both platforms. | Every push |
| End to end | [Maestro](https://maestro.dev) flows in `.maestro/` | Sign in, write a note offline, record a dose, on a real build against a staging Supabase project. | Before each release, by hand (see below) |
| Traceability | `scripts/traceability.mjs` | Every use case in [use-cases.md](use-cases.md) has at least one test; the matrix is current. | Every push |

## Test data

Database tests build the same world each time (`supabase/tests/harness.mts`): two providers; provider A has two houses (Maple, Cedar) and one person in each role, with the caregiver assigned to Maple only; provider B has one house and an admin. Isolation tests check every role against the other provider and the other house.

Dose tests compute times relative to the transaction's `now()` in the site's time zone, so they pass at any hour, including across midnight.

## Risk-based priorities

Highest risk first; these get the most cases.

1. **Cross-tenant or cross-site disclosure** (UC-03, UC-04). Every table, every role, both directions.
2. **Wrong medication record** (UC-10, UC-11). Duplicates, wrong time, early recording, missing reasons, ended orders, offline retries.
3. **Health information leaving the system** (UC-12, UC-13, UC-16). Notification payloads, message wording, AI prompts, crash reports, analytics.
4. **Altered clinical history** (UC-08, UC-15). Append-only for every role including the service role.

## Entry and exit criteria for a release

Entry: all CI jobs green on `main`, traceability current, no open bug labelled `severity: high`.

Exit: the Maestro flows pass on one iOS and one Android device against staging; a sample of push, email and SMS received on test devices shows no resident names; the audit trail shows the views and writes made during the run.

## Running the end-to-end flows

```bash
# Build a development client and install it on a simulator or device first.
export MAESTRO_EMAIL=caregiver@staging.example
export MAESTRO_PASSWORD=...
maestro test .maestro/
```

The flows use `testID`s set in the screens (`email`, `password`, `submit`, `note-body`, `save-note`, `record-dose`). The offline flow turns on airplane mode, so run it on a device or an emulator that supports it.

## Not covered by automation

- Real delivery through Expo, Resend, Twilio, OpenAI and Google. Clients are tested against the documented request and response shapes with a fake fetch, not against the live services.
- pg_cron scheduling (`supabase/schedules.sql`) runs only in a hosted project.
- Advisory concurrency between two dispatcher runs is handled by `FOR UPDATE SKIP LOCKED` but is not load-tested.
- Accessibility beyond labels and roles on interactive elements.
