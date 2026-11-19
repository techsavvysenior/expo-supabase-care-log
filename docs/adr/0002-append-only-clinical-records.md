# 2. Clinical records are append-only

**Status:** accepted

## Context

Care notes and medication records are evidence in inspections and incident reviews. An edit that overwrites the original destroys that evidence.

## Decision

- `care_notes`, `med_administrations` and `audit_events` have `BEFORE UPDATE OR DELETE` triggers that always raise `RECORDS_ARE_APPEND_ONLY`. A trigger, not only missing grants, so it also holds for the service role and the table owner.
- A mistake is fixed with a `correction` note that references the original (`amends_note_id`), and the UI shows both.
- Writes go through functions (`add_care_note`, `record_dose`) rather than direct inserts, so the author is always the caller.

## Consequences

- No "edit" button anywhere in the app. Training material needs to explain corrections.
- Data deletion for retention limits would need a separate, audited process that disables the trigger in a migration. Not built.
