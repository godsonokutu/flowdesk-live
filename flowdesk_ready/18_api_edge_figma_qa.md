# FlowDesk Live — API Trust & Provider Ingress Figma QA

Board: `29:143` — **FlowDesk Live - API Trust & Provider Ingress**

Coverage:
- verify-only RS256 JWT trust boundary;
- pinned issuer/audience;
- tenant identity only from verified `merchant_id`;
- PostgreSQL-authoritative permissions;
- fresh step-up requirement for privileged operations;
- per-route/distributed rate-limit posture;
- sensitive-header log redaction;
- opaque webhook endpoint-key routing;
- external secret-reference policy;
- Paystack HMAC SHA-512;
- Meta WhatsApp HMAC SHA-256;
- exact-raw-body signature verification;
- durable webhook inbox before provider acknowledgement;
- endpoint-scoped dedupe;
- invalid-signature safe-failure state with zero business side effects.

Final structural QA:
- 60 editable descendants
- 22 frames
- 37 text layers
- 2 linked design-system button instances
- zero raster/image layers
- Inter-only typography
- board 1660×877
- max child right 1590
- max child bottom 853
- no horizontal overflow
- no vertical overflow
