-- Add AP conversation URI to conversations table
ALTER TABLE conversations ADD COLUMN ap_uri TEXT;
CREATE UNIQUE INDEX idx_conversations_ap_uri ON conversations(ap_uri);
