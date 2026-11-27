-- Audit remediation v2 (2026-11-27):
-- #02: Explicit anonymized_at flag on orders to block public lookup/return on anonymized records
-- #04: Persist actual loyalty_clawback_vnd settled on MoMo refunds + provable legacy backfill
-- #10: Idempotency request_key / request_hash on purchase_orders
-- #18: Immutable confirmed_at timestamp on orders (never falls back to mutable updated_at or failed callbacks)

ALTER TABLE orders ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

-- #02: Backfill anonymized_at ONLY on orders with explicit anonymization audit evidence
-- OR the complete canonical anonymization signature (never a single weak field heuristic)
UPDATE orders o
SET anonymized_at = COALESCE(o.anonymized_at, o.updated_at, now())
WHERE o.anonymized_at IS NULL
  AND (
    EXISTS (
      SELECT 1 FROM audit_events ae
      WHERE ae.entity_type = 'order'
        AND ae.entity_id = o.id::text
        AND ae.action = 'order.anonymized_for_retention'
    )
    OR (
      o.customer_id IS NULL
      AND lower(COALESCE(o.email, '')) = 'anonymized@privacy.gaeru.com'
      AND regexp_replace(COALESCE(o.phone, ''), '[^0-9]', '', 'g') = '0000000000'
      AND (
        COALESCE(o.customer_name, '') LIKE 'Khách hàng ẩn danh%'
        OR COALESCE(o.address, '') LIKE 'Đã ẩn danh%'
      )
    )
  );

-- #18: Backfill confirmed_at ONLY from successful payment confirmations or status transitions
-- (strictly excludes failed/cancelled payment callbacks)
UPDATE orders o
SET confirmed_at = sub.first_confirmed_at
FROM (
  SELECT ae.entity_id::uuid AS order_id, MIN(ae.created_at) AS first_confirmed_at
  FROM audit_events ae
  WHERE ae.entity_type = 'order'
    AND ae.entity_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND (
      (
        ae.action IN ('payment.momo.callback', 'payment.momo.query', 'payment.vnpay.callback', 'payment.zalopay.callback')
        AND ae.metadata->>'successful' = 'true'
      )
      OR (
        ae.action = 'payment.bank_transfer.approved'
        AND COALESCE(ae.metadata->>'successful', 'true') = 'true'
      )
      OR (
        ae.action IN ('order.update', 'order.status.update', 'order.bulk_update')
        AND COALESCE(ae.after_state->>'status', ae.metadata->>'status', ae.metadata->'after'->>'status', '') IN ('confirmed', 'processing', 'shipped', 'completed')
      )
    )
  GROUP BY ae.entity_id::uuid
) sub
WHERE o.id = sub.order_id
  AND o.confirmed_at IS NULL
  AND o.status IN ('confirmed', 'processing', 'shipped', 'completed');

ALTER TABLE momo_refunds
  ADD COLUMN IF NOT EXISTS loyalty_clawback_vnd bigint NOT NULL DEFAULT 0 CHECK (loyalty_clawback_vnd >= 0);

-- #04: Provable backfill of pre-migration MoMo cash-recovered Xu clawback onto earliest succeeded momo_refunds row
-- Sources (ordered by provenance): audit_events(loyalty.refund.cashRecoveredEarn) -> customer_loyalty_ledger(refund-earn:<orderId>)
WITH candidate_orders AS (
  SELECT
    o.id AS order_id,
    GREATEST(
      0::bigint,
      COALESCE(o.total_vnd, 0)::bigint
      - COALESCE((SELECT SUM(mr.amount_vnd)::bigint FROM momo_refunds mr WHERE mr.order_id = o.id AND mr.status = 'succeeded'), 0)
      - COALESCE((SELECT SUM(COALESCE(oas.refund_amount_vnd, 0) + COALESCE(oas.loyalty_clawback_vnd, 0))::bigint FROM order_after_sales oas WHERE oas.order_id = o.id AND oas.kind = 'return' AND oas.status = 'resolved'), 0)
    ) AS max_backfillable_vnd,
    COALESCE(
      (
        SELECT MAX((ae.metadata->>'cashRecoveredEarn')::bigint)
        FROM audit_events ae
        WHERE ae.action = 'loyalty.refund'
          AND ae.metadata->>'orderId' = o.id::text
          AND COALESCE(ae.metadata->>'cashRecoveredEarn', '') ~ '^[0-9]+$'
          AND (ae.metadata->>'cashRecoveredEarn')::bigint > 0
      ),
      (
        SELECT MAX((substring(l.reason FROM 'khấu trừ tiền hoàn: ([0-9]+) ₫'))::bigint)
        FROM customer_loyalty_ledger l
        WHERE l.order_id = o.id
          AND l.event_key = 'refund-earn:' || o.id::text
          AND l.reason ~ 'khấu trừ tiền hoàn: [0-9]+ ₫'
      ),
      0::bigint
    ) AS legacy_clawback_vnd,
    (
      SELECT mr.id
      FROM momo_refunds mr
      WHERE mr.order_id = o.id AND mr.status = 'succeeded'
      ORDER BY COALESCE(mr.completed_at, mr.created_at) ASC, mr.id ASC
      LIMIT 1
    ) AS target_refund_id
  FROM orders o
  WHERE EXISTS (SELECT 1 FROM momo_refunds mr WHERE mr.order_id = o.id AND mr.status = 'succeeded')
    AND NOT EXISTS (SELECT 1 FROM momo_refunds mr WHERE mr.order_id = o.id AND mr.loyalty_clawback_vnd > 0)
    AND NOT EXISTS (SELECT 1 FROM order_after_sales oas WHERE oas.order_id = o.id AND oas.kind = 'return' AND oas.status = 'resolved' AND COALESCE(oas.loyalty_clawback_vnd, 0) > 0)
)
UPDATE momo_refunds mr
SET loyalty_clawback_vnd = LEAST(co.legacy_clawback_vnd, co.max_backfillable_vnd),
    updated_at = now()
FROM candidate_orders co
WHERE mr.id = co.target_refund_id
  AND co.legacy_clawback_vnd > 0
  AND co.max_backfillable_vnd > 0;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS request_key text;
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS request_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_orders_request_key
  ON purchase_orders (request_key)
  WHERE request_key IS NOT NULL;
