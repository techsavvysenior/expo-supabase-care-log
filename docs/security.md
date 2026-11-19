# Security and privacy notes

This is a sample, not a certified system. It shows how the technical safeguards in the HIPAA Security Rule (45 CFR 164.312) can be built into a Supabase and React Native app. Compliance also needs administrative and physical safeguards, signed Business Associate Agreements, policies and training, none of which a code repository can provide.

## Technical safeguards, mapped

| Safeguard | Where it lives |
|---|---|
| Access control: unique user identification | Supabase Auth; every row written records `auth.uid()` (`author_id`, `recorded_by`, `actor_id`). |
| Access control: least privilege | Row-level security on every table, scoped by organization and, for caregivers, by assigned site. Writes go through `SECURITY DEFINER` functions with explicit checks; direct inserts are not granted. |
| Access control: automatic logoff | Sessions are refreshed only while the app is in the foreground. Sign-out clears the offline queue and the query cache. |
| Audit controls | `audit_events` records chart views (`open_resident()`), note and dose writes, admissions and AI requests. Append-only by trigger. Readable by admins and auditors only. |
| Integrity | Care notes, dose records and audit events cannot be updated or deleted by anyone, including the service role. Corrections are new rows that reference the original. |
| Person or entity authentication | Supabase Auth (email and password in the sample; SSO or MFA are configuration). Invitations are bound to the invited email address. |
| Transmission security | HTTPS to Supabase and every vendor. |
| Storage on the device | The session and the offline queue are kept in the iOS Keychain / Android Keystore through `expo-secure-store`. Android cloud backup is off. |

## What each vendor receives

| Vendor | Purpose | Receives health information? |
|---|---|---|
| Supabase | Database, auth, functions | Yes. Requires the HIPAA add-on (Team or Enterprise plan) and a signed BAA, with the project set to High Compliance. |
| OpenAI | Handoff drafts | Yes, pseudonymized (residents as R1, R2). Off unless the organization records a BAA date, and gated by a feature flag. Requests always send `store: false`. OpenAI's API is HIPAA-eligible only under its Business Associate Addendum with the account provisioned for it. |
| Expo push service | Push notifications | No. Payloads are generic text and a deep link with ids. |
| Resend | Email | No for notifications (generic text). Invitation emails contain the organization name and the invite link. |
| Twilio | SMS for missed doses | No. Generic text only. |
| Google Geocoding | Site map | No. Only facility addresses, never a resident's. |
| Sentry | Crash reports | No by design: `beforeSend` and `beforeBreadcrumb` strip bodies, query strings, console and UI breadcrumbs, and mask emails, phone numbers and dates. No screenshots, view hierarchy or session replay. |
| PostHog | Product analytics, feature flags | No by design: an allow-list of event names, property names and values. Autocapture and session replay are off. |

"No by design" means the code is built so this data never reaches the vendor, and tests check it. It is not a substitute for a review of what each vendor is sent in your deployment.

## Threats considered

| Threat | Mitigation |
|---|---|
| A caregiver reads residents at a house they don't work at | Site-scoped RLS; tests for every role. |
| One provider sees another's data | Organization-scoped RLS plus composite foreign keys; tests in both directions. |
| A crafted request writes a note as someone else | `add_care_note()` sets `author_id` from the JWT; direct inserts are not granted. |
| An offline retry creates duplicate records | `client_ref` unique per author; functions return the existing row. |
| A record is altered after an incident | Append-only triggers that also apply to the service role. |
| A push message on a lock screen discloses a resident's condition | Outbox payload allow-list enforced by a CHECK constraint; generic templates tested against a blocklist. |
| The invite link is reused or forwarded | One-time token, hashed at rest, expiring after 7 days, bound to the invited email. |
| A leaked dispatcher URL is used to spam notifications | The function requires a secret header compared in constant time; it only sends what the outbox already holds. |
| The AI invents clinical facts | Strict JSON schema, instructions to use only the notes, and a person must edit and post each follow-up under their own name. |
| Crash reports collect PHI | Scrubbers run on the device before sending; tests cover each field. |

## Known gaps

- No MFA enforcement in the sample.
- No break-glass access flow for emergencies.
- No data retention or export tooling.
- Screenshots of the app are not blocked.
- The service role key in Edge Functions has full access; a compromised function is a full compromise.
