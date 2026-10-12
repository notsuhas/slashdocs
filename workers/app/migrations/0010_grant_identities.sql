-- Keep revoked grant identities outside the active ACL tables. Resource type
-- is part of the key because document and folder IDs can share a namespace.
CREATE TABLE grant_identities (
 resource_type TEXT NOT NULL CHECK(resource_type IN ('document','folder')),
 resource_id TEXT NOT NULL,
 principal_type TEXT NOT NULL CHECK(principal_type IN ('user','service_account','google_group','anyone')),
 principal_id TEXT NOT NULL,
 grant_id TEXT NOT NULL,
 PRIMARY KEY(resource_type,resource_id,principal_type,principal_id)
);
INSERT INTO grant_identities SELECT 'document',document_id,principal_type,principal_id,id FROM document_grants;
INSERT INTO grant_identities SELECT 'folder',folder_id,principal_type,principal_id,id FROM folder_grants;
-- Capture grants from all writers, including default grants and direct imports,
-- without changing the six-column document_grants layout.
CREATE TRIGGER document_grants_capture_identity AFTER INSERT ON document_grants BEGIN
 INSERT INTO grant_identities VALUES ('document',NEW.document_id,NEW.principal_type,NEW.principal_id,NEW.id)
 ON CONFLICT(resource_type,resource_id,principal_type,principal_id) DO NOTHING;
END;
CREATE TRIGGER folder_grants_capture_identity AFTER INSERT ON folder_grants BEGIN
 INSERT INTO grant_identities VALUES ('folder',NEW.folder_id,NEW.principal_type,NEW.principal_id,NEW.id)
 ON CONFLICT(resource_type,resource_id,principal_type,principal_id) DO NOTHING;
END;
