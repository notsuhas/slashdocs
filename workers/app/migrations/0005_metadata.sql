ALTER TABLE versions ADD COLUMN search_text TEXT;
ALTER TABLE versions ADD COLUMN headings_json TEXT;
CREATE TABLE document_labels (
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 label TEXT NOT NULL,
 PRIMARY KEY(document_id,label)
);
CREATE INDEX document_labels_label ON document_labels(label,document_id);
CREATE TABLE document_workspace_entries (
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 principal_type TEXT NOT NULL CHECK(principal_type IN ('user','service_account')),
 principal_id TEXT NOT NULL,
 PRIMARY KEY(document_id,principal_type,principal_id)
);
ALTER TABLE comment_mentions ADD COLUMN label_text TEXT NOT NULL DEFAULT '';
-- The guard is inserted and removed in one atomic label replacement batch.
-- Its CHECK rolls back the batch on access revocation without partial removal.
CREATE TABLE document_label_write_guards (
 document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
 allowed INTEGER NOT NULL CHECK(allowed=1)
);
ALTER TABLE comments ADD COLUMN author_email TEXT NOT NULL DEFAULT '';
ALTER TABLE comments ADD COLUMN author_name TEXT NOT NULL DEFAULT '';
UPDATE comments SET author_email=COALESCE((SELECT email FROM users WHERE users.id=comments.author_user_id),''),author_name=COALESCE((SELECT name FROM users WHERE users.id=comments.author_user_id),'');
ALTER TABLE comment_reactions ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
