# Contributing

## Workflow

1. Branch from `main`: `feat/<short-name>`, `fix/<short-name>`.
2. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org): `feat(mar): block recording more than an hour early`.
3. Open a pull request using the template. CI must be green; database and function changes need a review from a code owner.
4. Squash-merge.

## Definition of done

- The behavior is described in [docs/use-cases.md](docs/use-cases.md), new or updated.
- Each new rule has a test named with its use case id, at the lowest level that can prove it: a database test for anything about who can see or change what, a function test for request handling, a unit test for logic.
- `npm run check`, `npm run test:functions` and `npm run check:functions` pass.
- `node scripts/traceability.mjs --write` has been run and the matrix is committed.
- If something new is sent to a third party, [docs/security.md](docs/security.md) says what and why.

## Database changes

- Migrations are additive. Never edit a migration that has been applied anywhere; add a new one.
- Every new table: `enable row level security`, `revoke all ... from anon, authenticated`, then grant only what is needed, column by column for updates.
- Every new function: `set search_path = ''`, and re-run the `revoke execute ... / grant execute ...` block at the end of the migration (Supabase grants execute on new functions to everyone by default).
- Writes to care records go through a `SECURITY DEFINER` function that checks access, sets the actor from `auth.uid()`, and calls `log_event()`.
- Raise errors as an upper-case rule name (`raise exception 'REASON_REQUIRED'`) and add a sentence for it to `RULE_MESSAGES` in `src/core/errors.ts`. A test fails if one is missing.

## Code review checklist

- Can a caregiver at another site, or anyone at another provider, reach this data? Is there a test that says no?
- Does anything new end up in a log, a crash report, an analytics event or a notification? Would it be acceptable on a lock screen?
- What happens offline, and what happens when the same request arrives twice?
- Does the error the person sees tell them what to do next?

## Project layout

```
src/core/        Plain TypeScript shared by the app and the Edge Functions. No React Native imports.
src/platform/    Sentry, PostHog, push notifications and the offline queue's storage.
src/features/    Session, site selection, queries.
src/app/         Screens (expo-router).
supabase/        Migrations, Edge Functions, database tests.
docs/            Use cases, test plan, traceability, security notes, decision records.
.maestro/        End-to-end flows run before a release.
```
