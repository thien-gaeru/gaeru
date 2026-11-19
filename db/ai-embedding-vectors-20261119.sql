CREATE TABLE IF NOT EXISTS ai_embedding_vectors (
  namespace TEXT NOT NULL,
  item_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector_b64 TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (namespace, item_key, model_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_embedding_vectors_ns_model
  ON ai_embedding_vectors (namespace, model_id);
