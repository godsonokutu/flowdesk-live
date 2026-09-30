# FlowDesk Live — C12 Deterministic LIVE-Session Shutdown Gate v1.0

## Increment
Implemented `PgLiveSessionShutdownService` with an explicit `closing` state.

## Shutdown policy
1. `live -> closing` is the transactional cut-over.
2. New buyer intents, force allocations and variant switches require `live` and therefore stop after the cut-over commits.
3. All waiting entries are cancelled immediately.
4. Existing `active` / `payment_pending` reservations keep their **original server-authoritative expiry**. They can still settle valid payment before expiry.
5. Lifecycle outbox jobs observe `closing` as non-live and complete without waitlist promotion.
6. Finalization returns `draining` while any valid hold remains.
7. When all remaining holds are due, finalization:
   - locks all active reservation rows deterministically;
   - locks the session;
   - locks affected inventory rows in deterministic ID order;
   - releases reserved inventory with accounting guards;
   - expires the due reservations;
   - verifies zero active/payment-pending reservations and zero waiting entries;
   - transitions the session to `ended`;
   - writes immutable shutdown audit evidence.
8. Any accounting or state conflict rolls back; `ended` is never written on partial failure.

## Concurrency decision
Shutdown does **not** shorten reservation TTLs during the cut-over transaction. Doing so would require touching reservation rows while holding the session lock and would invert the existing C11 `reservation -> session -> inventory` lock order. Preserving original TTLs avoids that deadlock class and gives buyers a deterministic promise: a hold accepted before close stays valid until its original server expiry.

## Executable evidence
Transaction-core contracts: **49 passed / 0 failed**.
Client C09 freshness contracts: **8 passed / 0 failed**.
Combined FlowDesk transaction/freshness contracts: **57 passed / 0 failed**.

New C12 contract cases:
- invalid shutdown request rejected before DB access;
- cut-over sets `closing`, cancels waitlist and audits without mutating active holds;
- idempotent begin replay does not duplicate audit side effects;
- finalize returns `draining` while a future hold remains;
- finalization enforces reservation -> session -> inventory lock order;
- aggregate inventory release is guarded and zero-orphan state is verified before `ended`;
- accounting conflict rolls back and cannot mark session ended;
- lifecycle worker cannot promote when session status is `closing`.

## PostgreSQL integration gate
C12 is appended to the real PostgreSQL release harness. This environment still has no reachable `DATABASE_URL`, so the real database lock gate remains pending rather than being represented as passed.

## API
OpenAPI advanced to **v0.8.0** with:
- `POST /v1/live-sessions/{sessionId}/shutdown`
- `POST /v1/live-sessions/{sessionId}/shutdown/finalize`
- `closing` in the `LiveSession.status` state machine
- `BeginSessionShutdownRequest`
- `SessionShutdownState`
- explicit C12 lock/order/waitlist/hold/audit invariants.
