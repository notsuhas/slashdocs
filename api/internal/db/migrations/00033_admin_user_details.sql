-- +goose Up
ALTER TABLE users ADD COLUMN last_login_at TIMESTAMPTZ;
CREATE INDEX users_admin_created ON users(created_at DESC,id DESC) WHERE google_sub IS NOT NULL;
CREATE INDEX versions_admin_uploader ON versions(created_by_type,created_by_id,document_id);
CREATE INDEX admin_activity_principal ON admin_activity(principal_id,day);
CREATE INDEX admin_sessions_user ON admin_sessions(user_id,expires_at);
-- +goose Down
DROP INDEX admin_sessions_user;
DROP INDEX admin_activity_principal;
DROP INDEX versions_admin_uploader;
DROP INDEX users_admin_created;
ALTER TABLE users DROP COLUMN last_login_at;
