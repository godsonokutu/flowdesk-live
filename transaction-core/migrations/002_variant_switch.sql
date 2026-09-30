-- FlowDesk Live C11: reservation variant switching releases source inventory and
-- therefore participates in the same durable inventory_available outbox contract.
ALTER TABLE lifecycle_outbox
  DROP CONSTRAINT IF EXISTS lifecycle_outbox_source_type_check;

ALTER TABLE lifecycle_outbox
  ADD CONSTRAINT lifecycle_outbox_source_type_check CHECK (
    source_type IN (
      'reservation_expiry',
      'late_payment_expiry',
      'reservation_cancel',
      'inventory_adjustment',
      'variant_switch'
    )
  );
