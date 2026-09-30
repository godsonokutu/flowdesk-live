# FlowDesk Live v1.4 — Realtime + Resilient Checkout QA

## Implemented
- Redis Streams seller-event delivery with atomic event-id dedupe and bounded stream retention.
- SSE seller stream with `Last-Event-ID` reconnect cursor, keepalive frames, merchant stream isolation and live-session filtering.
- Redis readiness is included in API readiness; PostgreSQL remains transaction authority.
- Durable seller-event publisher leasing, retry and dead-letter behavior.
- Authoritative server-side inventory pricing (`unit_price_minor`, `currency`).
- Idempotent checkout creation backed by `idempotency_requests`.
- Durable payment-provider outbox.
- Paystack initialization adapter with timeout handling and authorization-host validation.
- Critical timeout invariant: every provider reference is persisted **before** the external Paystack initialize call. A retry may create another reference; late webhooks remain resolvable through `payment_provider_references`.
- Checkout API never accepts client-supplied amount/currency.
- Figma production board extended with realtime degradation, checkout initialization, provider timeout recovery and reconciliation states.

## Executable regression gate
- transaction-core: 49 passed
- client-runtime: 8 passed
- api-service: 55 passed
- total: **112 passed / 0 failed**
- Node syntax gate: PASS

## Red gates / no false claims
- PostgreSQL migrations 001–003 were not executed against a live PostgreSQL instance in this environment.
- Redis Streams behavior was contract-tested with fakes; no live Redis integration test was executed.
- No live Paystack request was sent and no provider credentials were used.
- Deployment/production load, failover and webhook-to-checkout E2E remain external integration gates.
