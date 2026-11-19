# 1. Tenant isolation in Postgres, not in the app

**Status:** accepted

## Context

One Supabase project serves many care providers. The app talks to the database directly with the publishable key, so anything the app filters could be bypassed by a modified client.

## Decision

- Every provider-owned table carries `org_id`, and row-level security on every table decides what a caller sees.
- Composite foreign keys (`(site_id, org_id)`, `(resident_id, org_id)`, `(order_id, org_id)`) make it impossible to attach a row to another provider's parent row, even for code that bypasses RLS.
- Access checks are small `SECURITY DEFINER` functions (`has_role`, `can_see_site_in`, `can_write_site`) with `search_path = ''`, so policies don't recurse and can't be hijacked by a schema on the search path.
- Caregivers are scoped to assigned sites; other roles see the whole organization.

## Consequences

- The app's role model (`src/core/roles.ts`) is a convenience for showing buttons. A test fails if it drifts from the SQL enum.
- Every isolation rule is tested as SQL against real Postgres (PGlite), per role, in both directions.
- Separate databases per tenant were rejected: higher cost and slower onboarding for small providers, which is the market this targets.
