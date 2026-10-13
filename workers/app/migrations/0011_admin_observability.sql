CREATE TABLE admin_activity (day TEXT NOT NULL, principal_id TEXT NOT NULL, is_user INTEGER NOT NULL, requests INTEGER NOT NULL DEFAULT 1, last_seen TEXT NOT NULL, PRIMARY KEY(day,principal_id));
CREATE INDEX admin_activity_last_seen ON admin_activity(last_seen) WHERE is_user=1;
