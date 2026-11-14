-- Add B-tree indexes for foreign-key columns lacking a leading index.
-- Safe and idempotent across fresh, upgraded, and partial-schema databases.

DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('idx_abandoned_carts_customer_id', 'abandoned_carts', 'customer_id'),
      ('idx_abandoned_carts_order_id', 'abandoned_carts', 'order_id'),
      ('idx_cod_settlement_allocations_shipment_id', 'cod_settlement_allocations', 'shipment_id'),
      ('idx_cod_settlement_allocations_receipt_id', 'cod_settlement_allocations', 'receipt_id'),
      ('idx_barcode_scan_logs_warehouse_id', 'barcode_scan_logs', 'warehouse_id'),
      ('idx_care_email_outbox_message_id', 'care_email_outbox', 'message_id'),
      ('idx_care_email_outbox_customer_id', 'care_email_outbox', 'customer_id'),
      ('idx_care_requests_order_id', 'care_requests', 'order_id'),
      ('idx_customer_account_setup_tokens_customer_id', 'customer_account_setup_tokens', 'customer_id'),
      ('idx_order_email_outbox_customer_id', 'order_email_outbox', 'customer_id'),
      ('idx_cod_return_intakes_warehouse_id', 'cod_return_intakes', 'warehouse_id'),
      ('idx_customer_cart_items_variant_id', 'customer_cart_items', 'variant_id'),
      ('idx_internal_ai_action_logs_thread_id', 'internal_ai_action_logs', 'thread_id'),
      ('idx_marketing_campaigns_banner_id', 'marketing_campaigns', 'banner_id'),
      ('idx_marketing_campaigns_voucher_id', 'marketing_campaigns', 'voucher_id'),
      ('idx_customer_vouchers_voucher_id', 'customer_vouchers', 'voucher_id'),
      ('idx_voucher_redemptions_customer_id', 'voucher_redemptions', 'customer_id'),
      ('idx_customer_campaign_reads_campaign_id', 'customer_campaign_reads', 'campaign_id'),
      ('idx_misa_einvoices_document_id', 'misa_einvoices', 'document_id'),
      ('idx_news_posts_cover_id', 'news_posts', 'cover_id'),
      ('idx_warehouse_stock_variant_id', 'warehouse_stock', 'variant_id'),
      ('idx_order_stock_allocations_variant_id', 'order_stock_allocations', 'variant_id'),
      ('idx_order_stock_allocations_warehouse_id', 'order_stock_allocations', 'warehouse_id'),
      ('idx_purchase_orders_warehouse_id', 'purchase_orders', 'warehouse_id'),
      ('idx_purchase_order_items_variant_id', 'purchase_order_items', 'variant_id'),
      ('idx_goods_receipts_warehouse_id', 'goods_receipts', 'warehouse_id'),
      ('idx_goods_receipt_items_purchase_order_item_id', 'goods_receipt_items', 'purchase_order_item_id'),
      ('idx_goods_receipt_items_variant_id', 'goods_receipt_items', 'variant_id'),
      ('idx_order_after_sales_warehouse_id', 'order_after_sales', 'warehouse_id'),
      ('idx_order_idempotency_keys_order_id', 'order_idempotency_keys', 'order_id'),
      ('idx_checkout_payment_intents_order_id', 'checkout_payment_intents', 'order_id'),
      ('idx_checkout_stock_holds_variant_id', 'checkout_stock_holds', 'variant_id'),
      ('idx_checkout_stock_holds_warehouse_id', 'checkout_stock_holds', 'warehouse_id'),
      ('idx_order_restoration_requests_order_id', 'order_restoration_requests', 'order_id'),
      ('idx_rma_exchange_issues_warehouse_id', 'rma_exchange_issues', 'warehouse_id'),
      ('idx_rma_exchange_issue_items_order_item_id', 'rma_exchange_issue_items', 'order_item_id'),
      ('idx_rma_exchange_issue_items_replacement_variant_id', 'rma_exchange_issue_items', 'replacement_variant_id'),
      ('idx_rma_exchange_issue_items_inventory_movement_id', 'rma_exchange_issue_items', 'inventory_movement_id'),
      ('idx_order_items_order_id', 'order_items', 'order_id'),
      ('idx_order_items_variant_id', 'order_items', 'variant_id'),
      ('idx_shopping_chat_ai_jobs_thread_id', 'shopping_chat_ai_jobs', 'thread_id'),
      ('idx_shopping_chat_threads_customer_id', 'shopping_chat_threads', 'customer_id'),
      ('idx_shopping_chat_threads_product_id', 'shopping_chat_threads', 'product_id'),
      ('idx_shopping_chat_upload_sessions_completed_file_id', 'shopping_chat_upload_sessions', 'completed_file_id'),
      ('idx_warranty_email_outbox_warranty_id', 'warranty_email_outbox', 'warranty_id'),
      ('idx_warranty_email_outbox_order_id', 'warranty_email_outbox', 'order_id')
    ) AS t(idx, tbl, col)
  LOOP
    IF to_regclass(format('%I', rec.tbl)) IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         WHERE c.oid = to_regclass(format('%I', rec.tbl))
           AND a.attname = rec.col
           AND NOT a.attisdropped
       ) THEN
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (%I)', rec.idx, rec.tbl, rec.col);
    END IF;
  END LOOP;
END $$;
