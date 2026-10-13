CREATE TABLE admin_activity (day TEXT NOT NULL, principal_id TEXT NOT NULL, is_user INTEGER NOT NULL, requests INTEGER NOT NULL DEFAULT 1, last_seen TEXT NOT NULL, PRIMARY KEY(day,principal_id));
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE admin_metadata (id INTEGER PRIMARY KEY CHECK(id=1), tracking_started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d','now')), last_cleanup_day TEXT NOT NULL DEFAULT '');
INSERT INTO admin_metadata(id) VALUES(1);
CREATE TRIGGER admin_activity_retention AFTER INSERT ON admin_activity
WHEN NEW.day > (SELECT last_cleanup_day FROM admin_metadata WHERE id=1)
BEGIN
  DELETE FROM admin_activity WHERE day<date(NEW.day,'-30 days');
  UPDATE admin_metadata SET last_cleanup_day=NEW.day WHERE id=1;
END;
