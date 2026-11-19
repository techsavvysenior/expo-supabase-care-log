# Use cases

Each use case has an id. Every automated test that proves part of it carries the id in its name, and `npm run check:traceability` fails if any use case below has no test. The generated matrix is in [traceability.md](traceability.md).

Actors: **Admin**, **Nurse**, **Caregiver** (assigned to specific sites), **Auditor** (read-only), **System** (scheduled jobs and Edge Functions).

---

### UC-01 Create a care organization
**Actor:** any signed-in person. **Result:** a new organization with the creator as its first admin.
- Organizations are created only through `create_organization()`; direct inserts are refused.
- AI handoff drafts cannot be turned on until an admin records the date the provider's BAA was signed.
- Only admins change organization settings.

### UC-02 Invite staff and accept the invitation
**Actor:** Admin, then the invitee. **Result:** the invitee joins with the chosen role and sites.
- The `invite-staff` function emails a one-time link through Resend. The database stores only a SHA-256 hash of the token, and the function never returns the token to the admin.
- The invitee must be signed in with the invited email address. Expired or used links are refused.
- Caregivers must be invited to at least one site. Sites must belong to the inviting organization.

### UC-03 Keep each provider's data separate
**Actor:** everyone. **Result:** no read or write ever crosses organizations.
- Row-level security on every table; composite foreign keys `(id, org_id)` stop a row being attached to another provider's site or resident.
- Staff see each other's names, but email and phone are only readable by their owner and the service role.

### UC-04 Limit caregivers to their assigned sites
**Actor:** Caregiver. **Result:** a caregiver sees and writes only for residents at sites they are assigned to.
- Admins, nurses and auditors see every site in their organization. Access changes take effect on the next query.
- The app's role model mirrors the database enum (a unit test reads the migration).

### UC-05 Admit a resident
**Actor:** Admin or Nurse. **Result:** a resident record at one site, logged in the audit trail without the resident's name.

### UC-06 Open a resident's record
**Actor:** any staff member with access. **Result:** the chart opens and a `resident.viewed` audit entry is written.
- The app opens charts only through `open_resident()`, so every view is logged.

### UC-07 Write a care note, including offline
**Actor:** Admin, Nurse or assigned Caregiver. **Result:** an append-only note.
- Notes are written through `add_care_note()` with a `client_ref` fixed when Save was pressed; an offline retry returns the existing note instead of creating a duplicate.
- Offline, the note is queued in the Keychain/Keystore and sent in order when the connection returns.
- Late entries are accepted and shown as late; notes about the future are refused. Auditors cannot write notes.

### UC-08 Correct a note without editing it
**Actor:** anyone who can write notes. **Result:** a `correction` note pointing at the original. The original never changes.
- UPDATE and DELETE are refused for everyone, including the service role (trigger, not just grants).

### UC-09 See the doses due at a site
**Actor:** staff who record doses. **Result:** each scheduled dose in a window, in the site's time zone, with what was recorded.

### UC-10 Record a dose
**Actor:** Admin, Nurse or assigned Caregiver. **Result:** one `given`, `refused` or `held` record per scheduled dose.
- Refused and held need a reason. Nothing is recorded more than 60 minutes early. The time must be on the order, and the order must be active that day.
- A second record for the same dose is refused; an offline retry with the same `client_ref` is a no-op.
- Errors the database raises reach the person as plain sentences.

### UC-11 Mark missed doses automatically
**Actor:** System (pg_cron). **Result:** a `missed` record for any dose 60 minutes past due with nothing recorded, and an alert to the site's nurses and admins. Safe to run repeatedly.

### UC-12 Notify staff without sending health information
**Actor:** System. **Result:** push (Expo), email (Resend) and, for missed doses only, SMS (Twilio).
- Triggers write identifiers only to an outbox; the payload is checked against an allow-list and any other key is refused by a constraint.
- Messages say only that something needs a look; the link opens the app, where access rules apply.
- At-least-once delivery with backoff, dead-lettering after five attempts, email idempotency keys, clean-up of unregistered push tokens.

### UC-13 Draft a shift handoff with AI, reviewed by a person
**Actor:** staff with access, when the organization has enabled AI and the feature flag is on. **Result:** a draft summary and per-resident follow-ups that a person edits and posts under their own name.
- The function reads notes with the caller's own permissions. Residents are sent to OpenAI as labels (R1, R2) with names masked in the text; `store: false` on every request; strict JSON schema output.
- Each request is audited with the note count, never the content.

### UC-14 Geocode a site for the map
**Actor:** Admin. **Result:** the site's coordinates from Google's Geocoding API.
- Only facility addresses are geocoded. Approximate matches need confirmation. Only the service role writes coordinates.

### UC-15 Review the audit trail
**Actor:** Admin or Auditor. **Result:** a read-only list of views, notes, doses and AI requests. Entries carry identifiers only and cannot be changed or deleted.

### UC-16 Crash reports and analytics without health information
**Actor:** System (on the device). **Result:** Sentry events keep only the user id and stack; request bodies, query strings, console and UI breadcrumbs are removed, and emails, phone numbers and dates are masked. PostHog events pass an allow-list of event names, property names and values.

### UC-17 Manage roles safely
**Actor:** Admin. **Result:** role changes and removals that never leave an organization without an admin, and that cut access immediately.
