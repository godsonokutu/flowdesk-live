# FlowDesk Live — Production Application Edge Gate v1.1

## Increment
Added a concrete Fastify 5 application/API boundary around the completed C01–C12 transaction core.

## Stack decision
- Node.js 22+
- Fastify **5.12.5**
- `@fastify/jwt` **10.2.2**
- `@fastify/rate-limit` **11.2.0**
- PostgreSQL driver `pg` **8.23.0**

The versions are pinned in `api-service/package.json`. Dependency installation itself could not be executed in this runtime because npm registry access timed out, so a generated lockfile/runtime Fastify-inject suite remains a deployment gate. Pure application-edge contracts and syntax checks execute locally.

## Authentication boundary
- verify-only asymmetric JWT configuration;
- RS256 is the only accepted JWT algorithm;
- issuer and audience are deployment-pinned;
- merchant tenancy is derived from the verified `merchant_id` claim, never from request body input;
- actor identity is the verified `sub`;
- authorization is rechecked against `merchant_memberships` and `merchant_permissions` in PostgreSQL;
- token permission claims are not treated as authorization truth;
- force allocation, LIVE shutdown cut-over, and dead-letter replay require fresh step-up verification (≤10 minutes).

## HTTP safety
- full object JSON schemas for Fastify v5 request validation;
- `Idempotency-Key` normalization on mutation routes;
- `If-Inventory-Version` required for force allocation;
- per-route rate limits;
- multi-replica production startup refuses an in-memory-only rate-limit posture unless distributed edge limiting is explicitly attested;
- structured `application/problem+json` errors;
- server-side 5xx details are suppressed from client responses;
- authorization, cookies and webhook signatures are redacted from structured logs;
- `/livez` is process liveness; `/readyz` proves PostgreSQL reachability.

## Webhook architecture correction
The previous shared webhook paths were tenant-ambiguous. v1.1 changes them to:
- `/v1/webhooks/payments/{endpointKey}`
- `/v1/webhooks/whatsapp/{endpointKey}`

`endpointKey` is an opaque routing identifier, **not a secret**. It resolves exactly one merchant/provider record. The database stores only `secret_ref`; the provider signing secret must come from the deployment secret manager.

### Paystack
- `x-paystack-signature`
- HMAC SHA-512 over the exact raw request bytes
- timing-safe comparison

### Meta WhatsApp
- `X-Hub-Signature-256`
- HMAC SHA-256 over the exact raw request bytes
- timing-safe comparison

Invalid signature ⇒ no durable inbox insert and no transaction service invocation.

## Durable ingress
Verified callbacks are committed to `webhook_inbox` before HTTP 200 acknowledgement.
- payload SHA-256 is recorded;
- provider event identity is endpoint-scoped;
- duplicate callbacks are safely acknowledged without another inbox side effect;
- signing secrets are never written to the inbox;
- inbox state model: `received → processing → processed | dead_letter`.

The downstream inbox worker/provider normalization layer remains the next implementation boundary.

## Executable evidence
- transaction-core: **49 passed / 0 failed**
- client freshness runtime: **8 passed / 0 failed**
- API/application edge: **35 passed / 0 failed**
- combined current FlowDesk contracts: **92 passed / 0 failed**
- syntax checks: PASS

## Figma handoff
Board `29:143` — **FlowDesk Live - API Trust & Provider Ingress**

States:
- Desktop / API Trust Overview
- Desktop / Provider Ingress
- Mobile / Webhook Rejected

QA:
- 60 editable descendants
- 22 frames
- 37 text layers
- 2 linked Simple Design System button instances
- 0 raster/image UI layers
- Inter-only typography
- no horizontal or vertical overflow

## Remaining hard gates
1. Install pinned Fastify dependencies and generate/commit the lockfile in a network-enabled build environment.
2. Run Fastify `inject()` integration tests against the real framework plugins.
3. Run PostgreSQL C01–C12 release gates with `DATABASE_URL`.
4. Implement the leased `webhook_inbox` processor and provider-specific normalization into FlowDesk transaction commands.
5. Select and wire the production secret manager; API startup intentionally requires an injected secret-resolver module.
