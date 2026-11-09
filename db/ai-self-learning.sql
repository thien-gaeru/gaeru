-- Migration: GAERU AI Autonomous Self-Learning System
-- Bảng lưu trữ tri thức tự học từ các cuộc hội thoại khách hàng và hướng dẫn nhân viên
CREATE TABLE IF NOT EXISTS ai_learned_knowledge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL CHECK (source_type IN ('customer_chat', 'staff_guidance', 'internal_copilot', 'manual')),
  topic text NOT NULL,
  triggers text[] NOT NULL DEFAULT '{}',
  learned_facts text NOT NULL,
  sample_question text NOT NULL,
  sample_answer text NOT NULL,
  confidence_score numeric(4,2) NOT NULL DEFAULT 0.85 CHECK (confidence_score >= 0 AND confidence_score <= 1.00),
  occurrence_count integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending_review', 'archived')),
  auto_learned boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_learned_knowledge_status ON ai_learned_knowledge(status);
CREATE INDEX IF NOT EXISTS idx_ai_learned_knowledge_triggers ON ai_learned_knowledge USING gin(triggers);
CREATE INDEX IF NOT EXISTS idx_ai_learned_knowledge_updated ON ai_learned_knowledge(updated_at DESC);
