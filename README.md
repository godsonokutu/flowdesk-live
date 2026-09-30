# FlowDesk Live — v1.6 Worker Liveness & Operational Readiness

FlowDesk Live is a production-oriented commerce operations backend focused on reliable live-selling workflows: buyer intent capture, inventory-safe reservations, payment checkout, webhook ingestion, seller events, worker liveness, and operational readiness.

## Portfolio highlights

- PostgreSQL-authoritative transaction and reservation lifecycle
- Fastify 5 API boundary with structured error handling and security controls
- Paystack checkout and signed webhook verification
- WhatsApp provider ingress and durable webhook inbox processing
- Redis-backed seller-event delivery support
- Idempotency, inventory-version preconditions, lifecycle outbox, and worker heartbeat checks
- Executable regression evidence across transaction core, client freshness runtime, and API service

## Runtime boundaries

1. `transaction-core/`
   - PostgreSQL transaction authority through C01–C12
   - reservation allocation, payment/expiry/cancellation lifecycle
   - strict FIFO waitlist + durable lifecycle outbox
   - C08 privileged force allocation
   - C09 inventory-version enforcement
   - C11 atomic variant switching
   - C12 deterministic LIVE-session shutdown

2. `client-runtime/`
   - C09 stale-stock/offline safety guard
   - connection-generation invalidation
   - server-ACK/snapshot freshness enforcement

3. `api-service/`
   - Fastify 5 production application boundary
   - verify-only RS256 JWT configuration
   - PostgreSQL-authoritative merchant permissions
   - step-up enforcement for privileged mutations
   - RFC-style problem responses without 5xx detail leakage
   - sensitive-header structured-log redaction
   - route-local rate limits + multi-replica distributed-limit deployment gate
   - opaque tenant/provider webhook endpoint routing
   - Paystack HMAC SHA-512 verification
   - Meta WhatsApp HMAC SHA-256 verification
   - durable `webhook_inbox` before HTTP acknowledgement

OpenAPI: `18_flowdesk_api_contract_v0.9.yaml`

## Current executable evidence

Validated from this source archive:

- transaction core: 49 passed / 0 failed
- client freshness runtime: 8 passed / 0 failed
- API service: 63 passed / 0 failed
- combined executable regression: **120 passed / 0 failed**

The suite exercises transaction safety, inventory versioning, idempotency, reservation lifecycle, webhook security, provider processing, control-plane authorization, realtime seller events, checkout initialization, operational readiness and worker-liveness heartbeats.

## Hard gates that are intentionally not reported as passed
- real PostgreSQL C01–C12 integration execution requires `DATABASE_URL`
- npm dependency installation / lockfile generation was unavailable in this runtime because registry access timed out
- Fastify `inject()` integration should run after dependencies are installed
- production secret manager adapter must be selected and wired
- durable webhook inbox worker + provider normalization is the next implementation boundary

Figma:
https://www.figma.com/design/R3jRWeMeaGEHvyFRfbdlkR
Latest board: `29:143` — FlowDesk Live - API Trust & Provider Ingress


## v1.2 durable provider processing
See `20_provider_processing_qa.md`. Current local executable contracts: 102 passed / 0 failed.


## v1.5 operational readiness
`/readyz` now includes queue-lag and expired-worker-lease safety gates. Current executable regression: 116 passed / 0 failed. See `23_operational_readiness_qa.md`.


## v1.6 worker liveness
Critical asynchronous workers now have executable entrypoints and PostgreSQL-backed liveness heartbeats. `/readyz` fails closed when a required worker disappears even with an empty queue. See `24_worker_liveness_qa.md`.


## Author

**Godson Okutu**  
Backend-focused software developer based in Ghana  
Portfolio: [godsonokutu.dev](https://godsonokutu.dev)
