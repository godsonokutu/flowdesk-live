# FlowDesk Live v1.3 — Operator Control Plane

This increment closes the operational gap between durable provider ingestion and human commerce operations.

## Implemented
- Dedicated webhook worker process runner with bounded concurrency, graceful SIGTERM/SIGINT drain, durable leased job processing, retry and dead-letter logging.
- LIVE offer alias control plane: list, upsert and disable merchant/session-scoped aliases; inventory ownership and session state are validated transactionally.
- Buyer-intent review control plane: list open review items, idempotently resolve an ambiguous intent into the existing reservation core, or dismiss it with a mandatory reason.
- Review resolution derives a stable idempotency key from merchant + review id and preserves the original provider message id, so an operator retry cannot manufacture a second reservation.
- Merchant-scoped webhook operational health endpoint: received, processing, dead-letter, processed-last-hour, oldest unfinished age, last processed timestamp.
- Permission partitioning: live_session.manage, buyer_intent.review and webhook.health.read are distinct DB-authoritative capabilities.

## Executable gate
- API contracts: 49 passed / 0 failed.
- Transaction core: 49 passed / 0 failed.
- Client freshness runtime: 8 passed / 0 failed.
- Combined: 106 passed / 0 failed.
- Node syntax gate: PASS.

## Deliberate red gates
- PostgreSQL integration/migration execution is still not claimed without a real DATABASE_URL.
- Redis/SSE seller-event delivery is not implemented in this release; seller_event_outbox remains the durable boundary.
- Paystack checkout initialization remains separate from settlement; do not accept money until checkout initialization also persists every attempted provider reference.
