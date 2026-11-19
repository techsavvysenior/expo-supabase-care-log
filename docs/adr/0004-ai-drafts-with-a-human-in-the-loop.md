# 4. AI handoff drafts with a person in the loop

**Status:** accepted

## Context

Writing a shift handoff from a day of notes is slow. A language model can draft it, but it can also invent facts, and care notes are protected health information.

## Decision

- Off by default. An organization can turn it on only after recording the date its BAA with the AI vendor was signed (a CHECK constraint), and a PostHog feature flag gates the screen.
- The function reads notes with the caller's JWT, so it sees exactly what the caller can.
- Residents are pseudonymized before the call (R1, R2, names masked inside note text) and re-identified in the function's response. Requests send `store: false` and ask for a strict JSON schema.
- The draft is never saved by the function. A person edits each per-resident follow-up and posts it as their own handoff note on that resident's record, so no chart holds another resident's details.
- Each request is audited with the note count only.

## Consequences

- Pseudonymization reduces what the vendor sees but doesn't remove the need for a BAA: note text can still identify someone.
- The model name is configuration (`OPENAI_MODEL`), not code.
