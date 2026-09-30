-- FlowDesk Live v1.4 — realtime seller events + resilient Paystack checkout.
ALTER TABLE inventory_variants ADD COLUMN IF NOT EXISTS unit_price_minor bigint, ADD COLUMN IF NOT EXISTS currency char(3);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='inventory_unit_price_nonnegative') THEN
  ALTER TABLE inventory_variants ADD CONSTRAINT inventory_unit_price_nonnegative CHECK(unit_price_minor IS NULL OR unit_price_minor>=0);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='inventory_currency_format') THEN
  ALTER TABLE inventory_variants ADD CONSTRAINT inventory_currency_format CHECK(currency IS NULL OR currency ~ '^[A-Z]{3}$');
 END IF;
END $$;
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS customer_email text, ADD COLUMN IF NOT EXISTS authorization_url text,
 ADD COLUMN IF NOT EXISTS access_code text, ADD COLUMN IF NOT EXISTS initialized_at timestamptz, ADD COLUMN IF NOT EXISTS last_provider_error text;
ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS payment_intents_status_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_status_check CHECK(status IN('initializing','pending','settled','reconciliation_required','cancelled','initialization_failed'));

CREATE TABLE IF NOT EXISTS payment_provider_outbox(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),merchant_id uuid NOT NULL,payment_intent_id uuid NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
 operation text NOT NULL CHECK(operation='initialize_paystack_checkout'),status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','completed','dead_letter')),
 attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,worker_token uuid,last_error text,result_body jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,UNIQUE(payment_intent_id,operation));
CREATE INDEX IF NOT EXISTS payment_provider_outbox_pending_idx ON payment_provider_outbox(available_at,created_at,id) WHERE status='pending';

CREATE TABLE IF NOT EXISTS payment_provider_connections(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),merchant_id uuid NOT NULL,provider text NOT NULL CHECK(provider='paystack'),secret_ref text NOT NULL,
 mode text NOT NULL DEFAULT 'test' CHECK(mode IN('test','live')),status text NOT NULL DEFAULT 'active' CHECK(status IN('active','disabled')),
 callback_url text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(merchant_id,provider));

ALTER TABLE seller_event_outbox DROP CONSTRAINT IF EXISTS seller_event_outbox_source_type_check;
ALTER TABLE seller_event_outbox ADD CONSTRAINT seller_event_outbox_source_type_check CHECK(source_type IN('webhook_inbox','payment_provider_outbox','transaction','operator'));
