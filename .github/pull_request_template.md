## What changed

<!-- One or two sentences. Link the issue. -->

## Use cases

<!-- Which UC ids from docs/use-cases.md does this touch? New behavior needs a test named with its UC id. -->

## Checklist

- [ ] Tests added or updated, named with the UC id (`npm run check:traceability` passes)
- [ ] `npm run check` passes locally
- [ ] New table: row-level security on, grants narrowed, isolation tests for every role
- [ ] New write path: goes through a function, records the actor, audited if it touches care records
- [ ] Nothing new is sent to a third party; if it is, docs/security.md is updated
- [ ] No resident names or care details in logs, analytics, crash reports or notifications
- [ ] Migration is additive, or the PR explains the rollout
