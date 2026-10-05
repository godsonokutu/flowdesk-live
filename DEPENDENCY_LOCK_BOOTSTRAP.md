# Dependency lock bootstrap

This branch is reserved for closing FlowDesk Live's reproducible-dependency blocker.

Required execution contract:

- Node 22.16.0
- npm 10.9.2
- generate package-lock.json with lifecycle scripts disabled
- prove each candidate with npm ci
- run package syntax and unit contracts
- fingerprint each package-lock.json with SHA-256
- retain generated candidates for review before merging

Packages requiring registry-resolved lockfiles:

1. api-service
2. transaction-core

Release eligibility remains fail-closed until both reviewed lockfiles are committed and the full PostgreSQL, Paystack test-mode, deterministic-tree and release-attestation gates pass on one exact commit.
