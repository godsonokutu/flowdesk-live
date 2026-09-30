# FlowDesk Live — C12 Figma Shutdown UX QA

Figma file: `FlowDesk Live — Production UX`
Board: `27:128` — **FlowDesk Live - Session Shutdown**

## States
- Desktop / End LIVE Review
- Desktop / Closing & Draining
- Mobile / Session Ended Receipt

## Product behavior represented
- closing is an explicit transactional cut-over, not a destructive modal action;
- new buyer intents, force allocation and variant switching stop at cut-over;
- waiting buyers are cancelled;
- existing accepted holds retain their original server-authoritative TTL;
- valid payment may still settle before each hold expires;
- lifecycle jobs cannot create new promotions while the session is closing;
- the operator can see active-hold drain progress and next/last expiry;
- ended receipt explicitly shows the zero-orphan gate and audit/lifecycle outcome.

## Structural QA
- 64 editable descendants
- 21 frames
- 39 text layers
- 5 linked Simple Design System button instances
- 0 raster/image UI layers
- Inter-only typography
- board size: 1640 × 887
- max child right: 1534
- max child bottom: 863
- no horizontal overflow
- no vertical overflow
