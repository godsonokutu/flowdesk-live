# FlowDesk Live v1.6 — Worker Liveness QA

## Defect closed
The persisted v1.5 release exposed `worker:payments` and `worker:seller-events` npm scripts but did not contain the corresponding `bin/payment-provider-worker.js` and `bin/seller-event-publisher.js` entrypoints. This is a deployment-blocking defect: package scripts could advertise processes that cannot start.

## Production increment
- Added both missing worker process entrypoints with bounded concurrency, structured failures and graceful SIGTERM/SIGINT shutdown.
- Added PostgreSQL-backed `worker_heartbeats` for webhook, payment-provider and seller-event workers.
- Added heartbeat registration/removal to all three workers.
- `/readyz` now fails closed when a required worker has no heartbeat or its newest heartbeat is older than the configured maximum age (default 30s), even if its queue is empty.
- This closes the blind spot where PostgreSQL/Redis are healthy and queues are empty while a critical worker process is dead.
- Heartbeat metadata contains process-operational metadata only; no merchant/buyer/provider payloads.

## Executable gate
- transaction-core: 49 passed / 0 failed
- client-runtime: 8 passed / 0 failed
- api-service: 63 passed / 0 failed
- total: 120 passed / 0 failed
- syntax/check gates: PASS

## Still unclaimed
No claim is made that PostgreSQL migration 004 has run on production infrastructure, that Redis failover has been exercised, or that Paystack sandbox/provider execution has passed. Those remain external integration gates.
