CREATE TABLE notification_preferences (
 principal_type TEXT NOT NULL CHECK(principal_type IN ('user','service_account')),
 principal_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 PRIMARY KEY(principal_type,principal_id)
);
CREATE TABLE document_notification_mutes (
 principal_type TEXT NOT NULL CHECK(principal_type IN ('user','service_account')),
 principal_id TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 PRIMARY KEY(principal_type,principal_id,document_id)
);
CREATE TABLE comment_notification_outbox (
 comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
 recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 reason TEXT NOT NULL CHECK(reason IN ('mention','reply','owner')),
 attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(comment_id,recipient_id)
);
CREATE INDEX comment_notification_pending ON comment_notification_outbox(available_at);
CREATE TABLE document_access_notification_outbox (
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 source TEXT NOT NULL CHECK(source IN ('direct','opened')),
 reason TEXT NOT NULL CHECK(reason IN ('access_shared','access_updated','access_removed')),
 previous_role TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '',
 attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(document_id,recipient_id,source)
);
CREATE INDEX document_access_notification_pending ON document_access_notification_outbox(available_at);
CREATE TABLE document_access_requests (
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 requester_type TEXT NOT NULL CHECK(requester_type IN ('user','service_account')),
 requester_id TEXT NOT NULL, requested_at INTEGER NOT NULL, request_token TEXT NOT NULL,
 PRIMARY KEY(document_id,requester_type,requester_id)
);
CREATE TABLE document_access_request_notification_outbox (
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 requester_type TEXT NOT NULL CHECK(requester_type IN ('user','service_account')),
 requester_id TEXT NOT NULL, requester_label TEXT NOT NULL,
 recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(document_id,requester_type,requester_id)
);
CREATE INDEX document_access_request_notification_pending ON document_access_request_notification_outbox(available_at);
ALTER TABLE users ADD COLUMN next_notification_at INTEGER NOT NULL DEFAULT 0;
-- Transaction-local scratch rows are keyed by an unguessable mutation token.
-- Writers insert, use, and delete them within one D1 batch.
CREATE TABLE notification_mutation_guards (token TEXT PRIMARY KEY, allowed INTEGER NOT NULL);
CREATE TABLE notification_access_snapshots (
 token TEXT NOT NULL, document_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
 source TEXT NOT NULL, previous_role TEXT NOT NULL,
 PRIMARY KEY(token,recipient_id)
);
