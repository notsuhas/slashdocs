CREATE TABLE document_events (document_id TEXT NOT NULL REFERENCES documents(id), revision INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('kv','document','comments','presence')), event_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(document_id,revision));
CREATE INDEX document_events_presence ON document_events(document_id,kind,updated_at);
CREATE TABLE state_write_guard (allowed INTEGER NOT NULL);
