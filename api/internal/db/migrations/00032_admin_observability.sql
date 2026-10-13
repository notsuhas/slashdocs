-- +goose Up
ALTER TABLE versions ADD COLUMN byte_length BIGINT CHECK (byte_length >= 0);
CREATE TABLE admin_activity (day DATE NOT NULL, principal_id TEXT NOT NULL, is_user BOOLEAN NOT NULL, requests BIGINT NOT NULL DEFAULT 1, last_seen TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(day,principal_id));
CREATE TABLE admin_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, signing_key_id TEXT NOT NULL, revoked_at TIMESTAMPTZ);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE admin_metadata (id INTEGER PRIMARY KEY CHECK(id=1), tracking_started_at TIMESTAMPTZ NOT NULL DEFAULT now());
INSERT INTO admin_metadata(id) VALUES(1);
-- +goose Down
DROP TABLE admin_metadata;
DROP TABLE admin_sessions;
DROP TABLE admin_activity;
ALTER TABLE versions DROP COLUMN byte_length;
