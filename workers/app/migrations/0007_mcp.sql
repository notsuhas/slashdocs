CREATE TABLE mcp_clients (id TEXT PRIMARY KEY,name TEXT NOT NULL,redirect_uris TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE mcp_consent (nonce_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),request_json TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE mcp_codes (code_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),client_id TEXT NOT NULL REFERENCES mcp_clients(id),redirect_uri TEXT NOT NULL,resource TEXT NOT NULL,scope TEXT NOT NULL,challenge TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE mcp_tokens (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),resource TEXT NOT NULL,scope TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX mcp_tokens_expiry ON mcp_tokens(expires_at);
