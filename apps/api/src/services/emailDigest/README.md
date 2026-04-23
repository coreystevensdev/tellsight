# emailDigest — RETIRING

**Status:** predates Epic 9 sprint planning. Scheduled for full retirement in Story 9.2 when the new digest generator lands at `apps/api/src/jobs/digest/`.

## Do not extend this module

New transactional email paths must go through `apps/api/src/services/email/` (Story 9.1). That module is the provider-abstracted seam: one `sendEmail(opts)` call, one registered backend at boot, one observable log shape. Adding a new email feature to `emailDigest/` would bypass that abstraction and earn a code-review rejection.

| This module (retiring) | New module (use this) |
|------------------------|------------------------|
| `emailDigest/resendClient.ts` | `services/email/providers/resend.ts` |
| `emailDigest/templates.ts` (raw HTML strings) | React Email templates rendered via `sendEmail({ react })` |
| `emailDigest/digestService.ts` + `worker.ts` + `scheduler.ts` | `jobs/digest/*` (landing in Story 9.2) |
| `emailDigest/unsubscribeToken.ts` | Reused or superseded in Story 9.4 — TBD |

## Why this exists at all

Commit `a8628d1` (pre-Epic-9) landed a working end-to-end digest pipeline as proof-of-concept before Story 9.1's infrastructure was scoped. Story 9.1 is strictly additive — it builds the right abstractions without disrupting the POC. Story 9.2 cuts over the digest pipeline to the new abstractions and deletes this directory.

## If you're here in a code review

- If someone is adding a new feature under `emailDigest/` — reject. Point them at `services/email/`.
- If someone is modifying this module for Story 9.2's cutover — that's the one time it's OK.
- If you see this README after Story 9.2 ships — open a PR deleting the whole directory.
