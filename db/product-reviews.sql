CREATE TABLE IF NOT EXISTS product_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title text,
  comment text NOT NULL CHECK (length(comment) >= 5),
  is_verified_buyer boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'hidden')),
  moderator_note text,
  moderated_by uuid,
  moderated_at timestamptz,
  admin_reply text,
  admin_replied_at timestamptz,
  helpful_count integer NOT NULL DEFAULT 0 CHECK (helpful_count >= 0),
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_reviews_product_status_idx ON product_reviews(product_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS product_reviews_status_created_idx ON product_reviews(status, created_at DESC);
CREATE INDEX IF NOT EXISTS product_reviews_email_idx ON product_reviews(lower(trim(customer_email)));
CREATE INDEX IF NOT EXISTS product_reviews_order_idx ON product_reviews(order_id);

CREATE TABLE IF NOT EXISTS product_review_helpful_votes (
  review_id uuid NOT NULL REFERENCES product_reviews(id) ON DELETE CASCADE,
  voter_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, voter_key)
);

CREATE INDEX IF NOT EXISTS product_review_helpful_votes_review_idx ON product_review_helpful_votes(review_id);
