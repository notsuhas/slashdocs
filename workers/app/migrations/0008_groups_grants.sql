-- Preserve the six-column document grant layout used by existing importers.
CREATE TABLE document_grants_v2 (id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id),principal_type TEXT NOT NULL CHECK(principal_type IN ('user','service_account','google_group','anyone')),principal_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('viewer','commenter','editor')),granted_by_user_id TEXT NOT NULL REFERENCES users(id),UNIQUE(document_id,principal_type,principal_id));
INSERT INTO document_grants_v2 SELECT * FROM document_grants;
DROP TABLE document_grants;
ALTER TABLE document_grants_v2 RENAME TO document_grants;
CREATE INDEX grants_actor ON document_grants(principal_type,principal_id,document_id);
CREATE TABLE google_groups (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,email TEXT NOT NULL,name TEXT NOT NULL,last_verified_at INTEGER NOT NULL);
CREATE INDEX google_groups_email ON google_groups(email);
CREATE TABLE google_group_membership_snapshots (user_id TEXT PRIMARY KEY REFERENCES users(id),customer_id TEXT NOT NULL DEFAULT '',last_success_at INTEGER NOT NULL DEFAULT 0,last_attempt_at INTEGER NOT NULL DEFAULT 0,last_error_code TEXT NOT NULL DEFAULT '');
CREATE TABLE google_group_memberships (user_id TEXT NOT NULL REFERENCES users(id),group_id TEXT NOT NULL REFERENCES google_groups(id),PRIMARY KEY(user_id,group_id));
CREATE INDEX google_group_memberships_group ON google_group_memberships(group_id,user_id);
