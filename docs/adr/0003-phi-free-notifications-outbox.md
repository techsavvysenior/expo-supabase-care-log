# 3. Notifications through a PHI-free outbox

**Status:** accepted

## Context

Push banners show on lock screens, SMS is stored by carriers, and email passes through third parties that have not signed a BAA with the provider. Sending from triggers directly would couple the database transaction to network calls.

## Decision

- Triggers insert into `notification_outbox` with identifiers only. A CHECK constraint (`is_phi_free`) refuses any payload key outside an allow-list or any value that is not a UUID.
- `dispatch-notifications`, run every minute by pg_cron, claims a batch with `FOR UPDATE SKIP LOCKED`, renders generic text, sends, and reports each result. Five attempts with exponential backoff, then dead-letter. Email uses an idempotency key derived from the outbox id.
- Message text never names a resident or a condition; the deep link opens the app, where RLS applies.

## Consequences

- Staff must open the app to see what happened. That is the point.
- Delivery is at-least-once. Email can't repeat (idempotency key). Push and SMS can repeat if a run crashes between sending and reporting, or if the outbox retries a message after another channel failed. Within one run, a Twilio request is not retried after a timeout, because Twilio may already have accepted it.
