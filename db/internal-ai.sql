-- Bảng lưu trữ phiên trò chuyện AI nội bộ GAERU AI
CREATE TABLE IF NOT EXISTS internal_ai_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(128) NOT NULL,
  user_role VARCHAR(64) NOT NULL DEFAULT 'staff',
  user_name VARCHAR(255),
  title VARCHAR(255) NOT NULL DEFAULT 'Hội thoại mới',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_internal_ai_threads_user ON internal_ai_threads(user_id, updated_at DESC);

-- Bảng lưu trữ tin nhắn AI nội bộ
CREATE TABLE IF NOT EXISTS internal_ai_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES internal_ai_threads(id) ON DELETE CASCADE,
  role VARCHAR(32) NOT NULL, -- 'user', 'assistant', 'system', 'tool'
  content TEXT NOT NULL,
  tool_calls JSONB,
  tool_results JSONB,
  action_card JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_internal_ai_messages_thread ON internal_ai_messages(thread_id, created_at ASC);

-- Bảng lưu trữ và kiểm toán hành động quản trị (Audit log for safe action execution)
CREATE TABLE IF NOT EXISTS internal_ai_action_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID REFERENCES internal_ai_threads(id) ON DELETE SET NULL,
  message_id UUID,
  action_type VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending', -- 'pending', 'executed', 'cancelled', 'failed'
  created_by VARCHAR(128) NOT NULL,
  executed_at TIMESTAMPTZ,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_internal_ai_action_logs_status ON internal_ai_action_logs(status, created_at DESC);
