CREATE TABLE folders (
 id TEXT PRIMARY KEY,
 title TEXT NOT NULL,
 -- Writers derive this key with JS Unicode toLowerCase(), never SQLite lower().
 title_key TEXT NOT NULL,
 owner_type TEXT NOT NULL CHECK(owner_type IN ('user','service_account')),
 owner_id TEXT NOT NULL,
 parent_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 CHECK(parent_folder_id IS NULL OR parent_folder_id<>id)
);
CREATE INDEX folders_parent ON folders(parent_folder_id);
CREATE UNIQUE INDEX folders_root_title ON folders(owner_type,owner_id,title_key) WHERE parent_folder_id IS NULL;
CREATE UNIQUE INDEX folders_child_title ON folders(parent_folder_id,title_key) WHERE parent_folder_id IS NOT NULL;
ALTER TABLE documents ADD COLUMN parent_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX documents_parent ON documents(parent_folder_id,deleted_at);
CREATE TABLE folder_grants (
 id TEXT PRIMARY KEY,
 folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
 principal_type TEXT NOT NULL CHECK(principal_type IN ('user','service_account','google_group','anyone')),
 principal_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('viewer','commenter','editor')),
 granted_by_type TEXT NOT NULL CHECK(granted_by_type IN ('user','service_account')),
 granted_by_id TEXT NOT NULL,
 UNIQUE(folder_id,principal_type,principal_id)
);
CREATE INDEX folder_grants_actor ON folder_grants(principal_type,principal_id,folder_id);
CREATE TABLE folder_workspace_entries (
 folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
 principal_type TEXT NOT NULL,
 principal_id TEXT NOT NULL,
 last_opened_at TEXT NOT NULL,
 PRIMARY KEY(folder_id,principal_type,principal_id)
);
CREATE INDEX folder_workspace_actor ON folder_workspace_entries(principal_type,principal_id,folder_id);
CREATE TABLE hidden_featured_items (
 principal_type TEXT NOT NULL,
 principal_id TEXT NOT NULL,
 resource_id TEXT NOT NULL,
 PRIMARY KEY(principal_type,principal_id,resource_id)
);
CREATE TABLE pins_v2 (
 user_id TEXT NOT NULL,
 resource_type TEXT NOT NULL CHECK(resource_type IN ('document','folder')),
 resource_id TEXT NOT NULL,
 PRIMARY KEY(user_id,resource_type,resource_id)
);
INSERT INTO pins_v2 SELECT user_id,resource_type,resource_id FROM pins;
DROP TABLE pins;
ALTER TABLE pins_v2 RENAME TO pins;
-- Triggers validate the tree in the same serialized SQLite write as the mutation.
-- No read-then-write cycle/depth check can race a concurrent re-parent.
CREATE TRIGGER folders_insert_depth BEFORE INSERT ON folders WHEN NEW.parent_folder_id IS NOT NULL BEGIN
 SELECT CASE WHEN (WITH RECURSIVE a(id,parent,depth) AS (
  SELECT id,parent_folder_id,1 FROM folders WHERE id=NEW.parent_folder_id
  UNION ALL SELECT f.id,f.parent_folder_id,a.depth+1 FROM folders f JOIN a ON f.id=a.parent WHERE a.depth<64
 ) SELECT COALESCE(MAX(depth),0) FROM a)>=15 THEN RAISE(ABORT,'folder_depth_conflict') END;
END;
CREATE TRIGGER folders_update_tree BEFORE UPDATE OF parent_folder_id ON folders WHEN NEW.parent_folder_id IS NOT NULL BEGIN
 SELECT CASE WHEN EXISTS(WITH RECURSIVE a(id,parent,depth) AS (
  SELECT id,parent_folder_id,1 FROM folders WHERE id=NEW.parent_folder_id
  UNION ALL SELECT f.id,f.parent_folder_id,a.depth+1 FROM folders f JOIN a ON f.id=a.parent WHERE a.depth<64
 ) SELECT 1 FROM a WHERE id=NEW.id) THEN RAISE(ABORT,'folder_cycle_conflict') END;
 SELECT CASE WHEN (WITH RECURSIVE a(id,parent,depth) AS (
  SELECT id,parent_folder_id,1 FROM folders WHERE id=NEW.parent_folder_id
  UNION ALL SELECT f.id,f.parent_folder_id,a.depth+1 FROM folders f JOIN a ON f.id=a.parent WHERE a.depth<64
 ), s(id,depth) AS (
  SELECT OLD.id,1 UNION ALL SELECT f.id,s.depth+1 FROM folders f JOIN s ON f.parent_folder_id=s.id WHERE s.depth<64
 ) SELECT (SELECT COALESCE(MAX(depth),0) FROM a)+(SELECT MAX(depth) FROM s))>15 THEN RAISE(ABORT,'folder_depth_conflict') END;
END;
-- Foreign-owned children survive deletion and keep their descendants. Rename
-- only when their owner's root already contains the case-insensitive title.
CREATE TRIGGER folders_keep_foreign_children BEFORE DELETE ON folders BEGIN
 UPDATE folders SET title=CASE WHEN EXISTS(
  SELECT 1 FROM folders root WHERE root.parent_folder_id IS NULL AND root.owner_type=folders.owner_type AND root.owner_id=folders.owner_id AND root.title_key=folders.title_key
 ) THEN (WITH RECURSIVE suffix(n) AS (
  SELECT 2 UNION ALL SELECT n+1 FROM suffix WHERE n<2+(SELECT COUNT(*) FROM folders root WHERE root.parent_folder_id IS NULL AND root.owner_type=folders.owner_type AND root.owner_id=folders.owner_id)
 ) SELECT folders.title||' ('||n||')' FROM suffix WHERE NOT EXISTS(
  SELECT 1 FROM folders root WHERE root.parent_folder_id IS NULL AND root.owner_type=folders.owner_type AND root.owner_id=folders.owner_id AND root.title_key=folders.title_key||' ('||n||')'
 ) ORDER BY n LIMIT 1) ELSE title END,
 title_key=CASE WHEN EXISTS(
  SELECT 1 FROM folders root WHERE root.parent_folder_id IS NULL AND root.owner_type=folders.owner_type AND root.owner_id=folders.owner_id AND root.title_key=folders.title_key
 ) THEN (WITH RECURSIVE suffix(n) AS (
  SELECT 2 UNION ALL SELECT n+1 FROM suffix WHERE n<2+(SELECT COUNT(*) FROM folders root WHERE root.parent_folder_id IS NULL AND root.owner_type=folders.owner_type AND root.owner_id=folders.owner_id)
 ) SELECT folders.title_key||' ('||n||')' FROM suffix WHERE NOT EXISTS(
  SELECT 1 FROM folders root WHERE root.parent_folder_id IS NULL AND root.owner_type=folders.owner_type AND root.owner_id=folders.owner_id AND root.title_key=folders.title_key||' ('||n||')'
 ) ORDER BY n LIMIT 1) ELSE title_key END,
 parent_folder_id=NULL
 WHERE parent_folder_id=OLD.id AND NOT(owner_type=OLD.owner_type AND owner_id=OLD.owner_id);
END;
