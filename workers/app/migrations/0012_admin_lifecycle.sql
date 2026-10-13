DROP INDEX admin_activity_last_seen;
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE admin_metadata (id INTEGER PRIMARY KEY CHECK(id=1), tracking_started_at TEXT NOT NULL, last_cleanup_day TEXT NOT NULL DEFAULT '');
INSERT INTO admin_metadata(id,tracking_started_at) VALUES(1,coalesce((SELECT min(day) FROM admin_activity),strftime('%Y-%m-%d','now')));
CREATE TRIGGER admin_activity_retention AFTER INSERT ON admin_activity
WHEN NEW.day > (SELECT last_cleanup_day FROM admin_metadata WHERE id=1)
BEGIN
  DELETE FROM admin_activity WHERE day<date(NEW.day,'-30 days');
  DELETE FROM sessions WHERE expires_at<=unixepoch('now');
  UPDATE admin_metadata SET last_cleanup_day=NEW.day WHERE id=1;
END;
