ALTER TABLE users ADD COLUMN last_login_at TEXT;
CREATE INDEX users_admin_created ON users(created_at DESC,id DESC) WHERE provider NOT IN ('service_account','placeholder');
CREATE INDEX versions_admin_uploader ON versions(created_by_user_id,document_id);
CREATE INDEX admin_activity_principal ON admin_activity(principal_id,day);
CREATE INDEX sessions_user ON sessions(user_id,expires_at);
