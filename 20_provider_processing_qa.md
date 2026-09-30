# FlowDesk Live v1.2 — Durable Provider Processing Gate

## Production increment
- Restored the persisted v1.1 release from the user's FlowDesk Library instead of rebuilding from memory.
- Added leased webhook processing with `FOR UPDATE SKIP LOCKED`, worker ownership tokens, lease expiry recovery, retry scheduling, bounded exponential backoff, and dead-letter terminal handling.
- Added deterministic Paystack `charge.success` normalization.
- Added durable `payment_intents` plus `payment_provider_references`.
- Provider callbacks resolve against the complete reference history, including superseded retry references. This prevents a late successful callback from an earlier provider-initialization attempt becoming orphaned.
- Amount/currency mismatch is quarantined as `reconciliation_required`; it is not silently settled.
- Added deterministic WhatsApp intent normalization for explicit offer aliases and quantities.
- Natural-language ambiguity, unknown/ambiguous offers, unsupported message types, and unsafe quantities go to `buyer_intent_review`; FlowDesk does not guess buyer intent.
- Added merchant/channel-scoped buyer identity mapping and LIVE-session offer aliases.
- Added a durable seller-event outbox boundary for subsequent realtime publication.

## Executable evidence
- transaction-core: 49 passed / 0 failed
- client-runtime: 8 passed / 0 failed
- api-service: 45 passed / 0 failed
- combined current contracts: 102 passed / 0 failed
- syntax checks: PASS

## Explicit remaining gates
1. PostgreSQL-backed C01–C12 + v1.2 migration execution still requires a live `DATABASE_URL`.
2. The webhook worker runner/process supervisor is not yet wired in this increment.
3. Buyer-intent review operator APIs/UI remain to be wired.
4. Seller-event outbox publication to the realtime transport remains to be implemented.
5. Paystack checkout initialization remains separate from webhook settlement and must retain the provider-reference-history invariant.
