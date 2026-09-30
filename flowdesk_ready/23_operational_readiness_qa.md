# FlowDesk Live v1.5 — Operational Readiness Gate

## Increment
This candidate is based on the exact persisted v1.4 realtime-checkout archive.

Added aggregate system readiness checks so `/readyz` no longer declares the API ready merely because PostgreSQL and Redis answer pings. Readiness now fails closed when webhook processing, Paystack initialization, or seller-event publication exceeds configured queue-age limits, or when any worker lease has expired.

### Default safety thresholds
- webhook unfinished age: 120 seconds
- payment-provider initialization age: 120 seconds
- seller-event publication age: 60 seconds

Thresholds are environment configurable. The public readiness response exposes only reason codes; merchant payloads, buyer information and provider secrets are not returned.

## Regression evidence
- transaction-core: 49 passed / 0 failed
- client-runtime: 8 passed / 0 failed
- api-service: 59 passed / 0 failed
- combined: 116 passed / 0 failed
- syntax/check gates: PASS for all three packages

## Still red
- No claim of live PostgreSQL migration/locking validation in this run.
- No claim of live Redis restart/replay validation.
- No claim of Paystack sandbox timeout/retry/webhook E2E.
- No deployment/soak claim.

Those are external integration gates, not unit-contract substitutes.
