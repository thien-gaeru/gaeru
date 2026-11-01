'use strict';

const backupDumpFixture = `-- PostgreSQL database dump
DROP TABLE IF EXISTS public.test_orders;
DROP TABLE IF EXISTS public.test_products;
CREATE TABLE public.test_products (
  id serial PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  price numeric NOT NULL,
  active boolean NOT NULL DEFAULT true,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE public.test_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  total integer NOT NULL
);
INSERT INTO public.test_products (sku, name, price, active, meta) VALUES ('SP-01', 'Sản phẩm 1', 100000, true, '{"tag": "new"}'::jsonb);
INSERT INTO public.test_products (sku, name, price, active, meta) VALUES ('SP-02', 'Sản phẩm 2', 200000, false, '{"tag": "sale"}'::jsonb);
INSERT INTO public.test_orders (code, total) VALUES
  ('ORD-001', 300000);
`;

async function writeBackupDumpFixture({ outputPath }) {
  const fs = require('node:fs/promises');
  await fs.writeFile(outputPath, backupDumpFixture);
}

module.exports = { backupDumpFixture, writeBackupDumpFixture };
