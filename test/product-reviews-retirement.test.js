'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const migration = () => fs.readFile(path.join(__dirname, '../db/archive-product-reviews.sql'), 'utf8');

test('retiring reviews preserves existing records and vote foreign keys on repeated migration', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE products (id integer PRIMARY KEY, name text);
    INSERT INTO products VALUES (1, 'GAERU K9');
    CREATE TABLE product_reviews (
      id integer PRIMARY KEY,
      product_id integer REFERENCES products(id),
      comment text NOT NULL,
      status text NOT NULL
    );
    CREATE TABLE product_review_helpful_votes (
      review_id integer REFERENCES product_reviews(id),
      voter_key text,
      PRIMARY KEY (review_id, voter_key)
    );
    INSERT INTO product_reviews VALUES (2, 1, 'Historical customer review', 'approved');
    INSERT INTO product_review_helpful_votes VALUES (2, 'existing-voter');
  `);
  const reviews = (await db.query('SELECT * FROM product_reviews')).rows;
  const votes = (await db.query('SELECT * FROM product_review_helpful_votes')).rows;
  const sql = await migration();
  await db.exec(sql);
  await db.exec(sql);
  assert.deepEqual((await db.query('SELECT * FROM archived_product_reviews')).rows, reviews);
  assert.deepEqual((await db.query('SELECT * FROM archived_product_review_helpful_votes')).rows, votes);
  assert.deepEqual((await db.query('SELECT * FROM products')).rows, [{ id: 1, name: 'GAERU K9' }]);
  assert.deepEqual((await db.query(`SELECT to_regclass('product_reviews') AS reviews,
    to_regclass('product_review_helpful_votes') AS votes`)).rows[0], { reviews: null, votes: null });
  assert.equal((await db.query(`SELECT confrelid::regclass::text AS referenced_table
    FROM pg_constraint WHERE conrelid = 'archived_product_review_helpful_votes'::regclass
      AND contype = 'f'`)).rows[0].referenced_table, 'archived_product_reviews');
});

test('retiring reviews never overwrites an existing archive on a naming collision', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE product_reviews (id integer PRIMARY KEY);
    CREATE TABLE product_review_helpful_votes (review_id integer);
    CREATE TABLE archived_product_review_helpful_votes (review_id integer);
    INSERT INTO product_reviews VALUES (1);
    INSERT INTO product_review_helpful_votes VALUES (1);
    INSERT INTO archived_product_review_helpful_votes VALUES (99);
  `);
  await assert.rejects(db.exec(await migration()), /already exists/);
  assert.deepEqual((await db.query('SELECT * FROM product_reviews')).rows, [{ id: 1 }]);
  assert.deepEqual((await db.query('SELECT * FROM product_review_helpful_votes')).rows, [{ review_id: 1 }]);
  assert.deepEqual((await db.query('SELECT * FROM archived_product_review_helpful_votes')).rows, [{ review_id: 99 }]);
});
