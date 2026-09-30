-- FlowDesk Live transaction authority — fresh PostgreSQL 16+ schema
-- This schema is the canonical bootstrap for integration/CI gates.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE live_sessions (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','live','ended','cancelled')),
  reservation_ttl_seconds integer NOT NULL DEFAULT 300
    CHECK (reservation_ttl_seconds BETWEEN 60 AND 1800),
  config_version bigint NOT NULL DEFAULT 1,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_variants (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL,
  sku text NOT NULL,
  available_qty integer NOT NULL CHECK (available_qty >= 0),
  reserved_qty integer NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  sold_qty integer NOT NULL DEFAULT 0 CHECK (sold_qty >= 0),
  version bigint NOT NULL DEFAULT 0,
  UNIQUE (merchant_id, sku),
  CONSTRAINT inventory_nonnegative_all
    CHECK (available_qty >= 0 AND reserved_qty >= 0 AND sold_qty >= 0)
);

CREATE TABLE reservations (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL,
  live_session_id uuid NOT NULL REFERENCES live_sessions(id),
  inventory_variant_id uuid NOT NULL REFERENCES inventory_variants(id),
  buyer_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL CHECK (
    status IN ('active','payment_pending','paid','expired','cancelled','reconciliation_required')
  ),
  expires_at timestamptz NOT NULL,
  provider_event_id text,
  promotion_outbox_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reservations_expiry_idx
  ON reservations(status, expires_at)
  WHERE status IN ('active','payment_pending');

CREATE UNIQUE INDEX reservation_live_buyer_sku_unique
  ON reservations(live_session_id, inventory_variant_id, buyer_id)
  WHERE status IN ('active','payment_pending');

CREATE UNIQUE INDEX reservations_provider_event_unique
  ON reservations(merchant_id, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL,
  live_session_id uuid NOT NULL REFERENCES live_sessions(id),
  inventory_variant_id uuid NOT NULL REFERENCES inventory_variants(id),
  buyer_id uuid NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  status text NOT NULL CHECK (status IN ('waiting','promoted','expired','cancelled','converted')),
  position_seq bigint NOT NULL CHECK (position_seq > 0),
  provider_event_id text,
  promoted_reservation_id uuid REFERENCES reservations(id),
  promoted_by_outbox_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX waitlist_fifo_idx
  ON waitlist_entries(live_session_id, inventory_variant_id, position_seq)
  WHERE status='waiting';

CREATE UNIQUE INDEX waitlist_position_unique
  ON waitlist_entries(live_session_id, inventory_variant_id, position_seq);

CREATE UNIQUE INDEX waitlist_provider_event_unique
  ON waitlist_entries(merchant_id, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE UNIQUE INDEX waitlist_waiting_buyer_sku_unique
  ON waitlist_entries(live_session_id, inventory_variant_id, buyer_id)
  WHERE status='waiting';

CREATE TABLE provider_events (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload_hash text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (merchant_id, provider, provider_event_id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL,
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_requests (
  merchant_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 200),
  request_hash text NOT NULL,
  operation text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (merchant_id, idempotency_key)
);

CREATE INDEX idempotency_expiry_idx ON idempotency_requests(expires_at);

CREATE TABLE payment_events (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL,
  provider text NOT NULL,
  provider_transaction_id text NOT NULL,
  reservation_id uuid NOT NULL REFERENCES reservations(id),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('received','processed')),
  result_body jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (merchant_id, provider, provider_transaction_id)
);

CREATE INDEX payment_events_reservation_idx
  ON payment_events(merchant_id,reservation_id,received_at DESC);

CREATE TABLE lifecycle_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('inventory_available')),
  source_type text NOT NULL CHECK (
    source_type IN ('reservation_expiry','late_payment_expiry','reservation_cancel','inventory_adjustment')
  ),
  source_id uuid NOT NULL,
  live_session_id uuid NOT NULL REFERENCES live_sessions(id),
  inventory_variant_id uuid NOT NULL REFERENCES inventory_variants(id),
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  result_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (merchant_id, dedupe_key)
);

CREATE INDEX lifecycle_outbox_pending_idx
  ON lifecycle_outbox (available_at, created_at, id)
  WHERE status='pending';

CREATE INDEX lifecycle_outbox_variant_idx
  ON lifecycle_outbox (merchant_id, live_session_id, inventory_variant_id, created_at DESC);

ALTER TABLE reservations
  ADD CONSTRAINT reservations_promotion_outbox_fk
  FOREIGN KEY (promotion_outbox_id) REFERENCES lifecycle_outbox(id);

ALTER TABLE waitlist_entries
  ADD CONSTRAINT waitlist_promoted_by_outbox_fk
  FOREIGN KEY (promoted_by_outbox_id) REFERENCES lifecycle_outbox(id);

CREATE UNIQUE INDEX waitlist_promoted_reservation_unique
  ON waitlist_entries(promoted_reservation_id)
  WHERE promoted_reservation_id IS NOT NULL;

CREATE INDEX reservations_promotion_outbox_idx
  ON reservations(promotion_outbox_id)
  WHERE promotion_outbox_id IS NOT NULL;
