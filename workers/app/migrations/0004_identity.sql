CREATE TABLE service_accounts (id TEXT PRIMARY KEY REFERENCES users(id),name TEXT UNIQUE NOT NULL,owner_user_id TEXT NOT NULL REFERENCES users(id),created_by_user_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,disabled_at TEXT);
CREATE INDEX service_accounts_owner ON service_accounts(owner_user_id,created_at);
CREATE TABLE service_account_keys (id TEXT PRIMARY KEY,service_account_id TEXT NOT NULL REFERENCES service_accounts(id),name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT,last_used_at TEXT);
CREATE INDEX service_account_keys_account ON service_account_keys(service_account_id,created_at);
CREATE TABLE ownership_transfers (id TEXT PRIMARY KEY,service_account_id TEXT NOT NULL REFERENCES service_accounts(id),from_user_id TEXT NOT NULL REFERENCES users(id),to_user_id TEXT NOT NULL REFERENCES users(id),status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined')),initiated_at TEXT NOT NULL,accepted_at TEXT);
CREATE INDEX ownership_transfers_users ON ownership_transfers(from_user_id,to_user_id,initiated_at);
