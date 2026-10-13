-- +goose Up
ALTER TABLE admin_sessions ADD COLUMN revoked_at TIMESTAMPTZ;
-- +goose Down
ALTER TABLE admin_sessions DROP COLUMN revoked_at;
