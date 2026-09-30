-- FlowDesk Live C12: deterministic LIVE-session shutdown.
-- `closing` is a transactional cut-over state: no new buyer intents or variant
-- switches are accepted, waiting buyers are cancelled, and existing active holds
-- drain using their original server-authoritative expiry timestamps.

ALTER TABLE live_sessions
  DROP CONSTRAINT IF EXISTS live_sessions_status_check;

ALTER TABLE live_sessions
  ADD CONSTRAINT live_sessions_status_check CHECK (
    status IN ('draft','live','closing','ended','cancelled')
  );

ALTER TABLE live_sessions
  ADD COLUMN IF NOT EXISTS closing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS close_policy text;

UPDATE live_sessions
SET close_policy='drain_holds'
WHERE status='closing' AND close_policy IS NULL;

ALTER TABLE live_sessions
  DROP CONSTRAINT IF EXISTS live_sessions_close_policy_check;

ALTER TABLE live_sessions
  ADD CONSTRAINT live_sessions_close_policy_check CHECK (
    close_policy IS NULL OR close_policy IN ('drain_holds')
  );

CREATE INDEX IF NOT EXISTS live_sessions_merchant_status_idx
  ON live_sessions(merchant_id,status);
