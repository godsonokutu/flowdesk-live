-- FlowDesk Live v1.2 durable provider processing
ALTER TABLE webhook_inbox ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN IF NOT EXISTS worker_token uuid, ADD COLUMN IF NOT EXISTS result_body jsonb,
 ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;
CREATE INDEX IF NOT EXISTS webhook_inbox_work_idx ON webhook_inbox(next_attempt_at,received_at,id)
 WHERE status='received' OR status='processing';

CREATE TABLE IF NOT EXISTS payment_intents(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL,
 reservation_id uuid NOT NULL REFERENCES reservations(id), provider text NOT NULL CHECK(provider='paystack'),
 amount_minor bigint NOT NULL CHECK(amount_minor>=0), currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','settled','reconciliation_required','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS payment_provider_references(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL,
 payment_intent_id uuid NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK(provider='paystack'), reference text NOT NULL CHECK(char_length(reference) BETWEEN 1 AND 200),
 state text NOT NULL DEFAULT 'active' CHECK(state IN('attempting','active','superseded','failed')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(merchant_id,provider,reference));
CREATE INDEX IF NOT EXISTS payment_provider_references_intent_idx ON payment_provider_references(payment_intent_id,created_at DESC);

CREATE TABLE IF NOT EXISTS buyer_identities(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),merchant_id uuid NOT NULL,channel text NOT NULL CHECK(channel='whatsapp'),
 external_id text NOT NULL CHECK(char_length(external_id) BETWEEN 3 AND 200),display_name text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(merchant_id,channel,external_id));
CREATE TABLE IF NOT EXISTS live_offer_aliases(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),merchant_id uuid NOT NULL,live_session_id uuid NOT NULL REFERENCES live_sessions(id),
 inventory_variant_id uuid NOT NULL REFERENCES inventory_variants(id),alias text NOT NULL CHECK(alias ~ '^[A-Z0-9_-]{1,40}$'),
 status text NOT NULL DEFAULT 'active' CHECK(status IN('active','disabled')),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(live_session_id,alias));
CREATE INDEX IF NOT EXISTS live_offer_aliases_lookup_idx ON live_offer_aliases(merchant_id,alias,live_session_id) WHERE status='active';
CREATE TABLE IF NOT EXISTS buyer_intent_review(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),merchant_id uuid NOT NULL,webhook_inbox_id uuid NOT NULL REFERENCES webhook_inbox(id),
 buyer_identity_id uuid REFERENCES buyer_identities(id),provider_message_id text,
 reason text NOT NULL CHECK(reason IN('unsupported_message','intent_unrecognized','offer_not_found','offer_ambiguous','invalid_quantity')),
 normalized_text text,status text NOT NULL DEFAULT 'open' CHECK(status IN('open','resolved','dismissed')),
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz,
 UNIQUE(webhook_inbox_id));
CREATE TABLE IF NOT EXISTS seller_event_outbox(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),merchant_id uuid NOT NULL,live_session_id uuid,event_type text NOT NULL,
 source_type text NOT NULL CHECK(source_type IN('webhook_inbox','transaction','operator')),source_id uuid NOT NULL,
 payload jsonb NOT NULL DEFAULT '{}'::jsonb,status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','published','dead_letter')),
 attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,worker_token uuid,last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz,UNIQUE(merchant_id,source_type,source_id,event_type));
