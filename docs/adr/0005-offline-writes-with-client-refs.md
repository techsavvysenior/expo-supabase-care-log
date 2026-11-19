# 5. Offline writes with client-generated references

**Status:** accepted

## Context

Care happens in rooms with poor signal. A note written there must not be lost, and a request that timed out after reaching the server must not create a second record.

## Decision

- Each write gets a `client_ref` (UUID) when the person presses Save. `add_care_note()` and `record_dose()` return the existing row when the same author sends the same `client_ref` again.
- If the online attempt fails with a retryable error, the write goes into a queue stored in the Keychain/Keystore and is flushed in order when NetInfo reports a connection.
- A rule error (dose already recorded, access removed) is not retried; the item is set aside and shown to the person.

## Consequences

- The queue holds health information on the device, which is why it is in secure storage and cleared at sign-out.
- Ordering is per device. Two devices recording the same dose resolve by the unique constraint: the second gets `DOSE_ALREADY_RECORDED`.
