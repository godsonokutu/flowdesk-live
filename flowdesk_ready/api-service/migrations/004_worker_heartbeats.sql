-- FlowDesk Live v1.6 — worker process liveness.
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_type text NOT NULL CHECK (worker_type IN ('webhook','payment_provider','seller_event_publisher')),
  instance_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (worker_type, instance_id)
);
CREATE INDEX IF NOT EXISTS worker_heartbeats_freshness_idx ON worker_heartbeats(worker_type,last_seen_at DESC);
