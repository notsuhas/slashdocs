-- +goose Up
DROP INDEX admin_activity_last_seen;
ALTER TABLE admin_sessions ADD COLUMN signing_key_id TEXT NOT NULL DEFAULT '';
CREATE TABLE admin_metadata (id INTEGER PRIMARY KEY CHECK(id=1), tracking_started_at TIMESTAMPTZ NOT NULL);
INSERT INTO admin_metadata VALUES(1,coalesce((SELECT min(day)::timestamptz FROM admin_activity),now()));
-- +goose Down
DROP TABLE admin_metadata;
ALTER TABLE admin_sessions DROP COLUMN signing_key_id;
CREATE INDEX admin_activity_last_seen ON admin_activity(last_seen) WHERE is_user;
