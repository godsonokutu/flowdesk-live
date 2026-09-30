-- FlowDesk Live application-edge security and durable provider ingress.

CREATE TABLE IF NOT EXISTS merchant_memberships (
  merchant_id uuid NOT NULL,
  actor_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','suspended','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id,actor_id)
);

CREATE TABLE IF NOT EXISTS merchant_permissions (
  merchant_id uuid NOT NULL,
  actor_id text NOT NULL,
  permission text NOT NULL CHECK (char_length(permission) BETWEEN 3 AND 128),
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by text,
  PRIMARY KEY (merchant_id,actor_id,permission),
  FOREIGN KEY (merchant_id,actor_id)
    REFERENCES merchant_memberships(merchant_id,actor_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('paystack','meta_whatsapp')),
  endpoint_key text NOT NULL UNIQUE CHECK (endpoint_key ~ '^[A-Za-z0-9_-]{24,96}$'),
  secret_ref text NOT NULL,
  verify_token_ref text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz
);

CREATE INDEX IF NOT EXISTS webhook_endpoints_merchant_provider_idx
  ON webhook_endpoints(merchant_id,provider,status);

CREATE TABLE IF NOT EXISTS webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id),
  merchant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('paystack','meta_whatsapp')),
  provider_event_id text NOT NULL CHECK (char_length(provider_event_id) BETWEEN 1 AND 300),
  event_type text NOT NULL,
  payload_sha256 char(64) NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','processing','processed','dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  signature_verified_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  processed_at timestamptz,
  last_error text,
  UNIQUE (webhook_endpoint_id,provider_event_id)
);

CREATE INDEX IF NOT EXISTS webhook_inbox_pending_idx
  ON webhook_inbox(received_at,id)
  WHERE status IN ('received','processing');

CREATE INDEX IF NOT EXISTS webhook_inbox_merchant_idx
  ON webhook_inbox(merchant_id,provider,received_at DESC);

-- Never store provider signing secrets directly in these tables. `secret_ref`
-- points to the production secret-management system selected for deployment.
