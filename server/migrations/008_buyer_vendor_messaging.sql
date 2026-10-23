CREATE TABLE IF NOT EXISTS conversations (
  conversation_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  buyer_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  vendor_id BIGINT NOT NULL REFERENCES vendors(vendor_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT conversations_buyer_vendor_key UNIQUE (buyer_id, vendor_id)
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  message_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  sender_user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  message_body VARCHAR(2000) NOT NULL CHECK (length(btrim(message_body)) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_buyer_updated
  ON conversations(buyer_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_vendor_updated
  ON conversations(vendor_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_created
  ON conversation_messages(conversation_id, created_at, message_id);
