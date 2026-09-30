# FlowDesk Live Transaction Core v0.5

This package is the production-oriented transaction authority for the highest-risk FlowDesk Live flows:

- hot-SKU reservation allocation;
- WhatsApp provider-event deduplication;
- merchant-scoped API idempotency;
- payment settlement;
- server-authoritative expiry;
- cancellation stock release;
- durable lifecycle outbox;
- strict FIFO, quantity-aware waitlist promotion;
- dead-letter health and audited replay.

## Local PostgreSQL gate

```bash
docker compose up -d postgres
cp .env.example .env
export DATABASE_URL=postgres://flowdesk:flowdesk_local_only@127.0.0.1:54329/flowdesk
npm ci
npm run db:migrate
npm run test:all
```

The repository intentionally does **not** use Redis as the inventory correctness boundary. PostgreSQL row locks and database constraints own correctness. A queue/cache layer can be added later for throughput, but cannot be the sole source of truth for reservations.

## Release gates currently encoded

- C01 — 50 concurrent buyers / 6 units => 6 reserved, 44 waitlisted.
- C02 — duplicate WhatsApp event => one side effect.
- C03 — duplicate payment callback => one stock transition.
- C04 — expiry releases once and durably queues promotion.
- C05 — strict FIFO promotion preserves requested quantity and grants fresh TTL.
- C06 — late payment after reallocation => reconciliation, no oversell.
- C07 — retry after lost response returns original idempotent result.
- C10 — two independent pools racing for final unit => one reservation.

C08/C09 are operator/client security UX gates. C11 (atomic variant swap) and C12 (deterministic LIVE-session close) remain explicit implementation work.

## Worker

```bash
npm run worker
```

The lifecycle worker uses multiple independent consumers. `SKIP LOCKED` is used only for independent outbox jobs. It is deliberately **not** used on the buyer waitlist because strict FIFO forbids bypassing a locked head buyer.

## Security/operational rules

- Provider transaction IDs and provider event IDs are payload-bound.
- Mutation retries cannot change payload under the same idempotency key.
- Late payment cannot reacquire inventory.
- Every inventory release creates durable lifecycle work before the same commit.
- Dead-letter replay cannot edit the original event payload and must be authorized/audited.
