-- Client-scoped, idempotent receipts for dispatching pre-defined Action Worker tasks.
-- No prompts, GitHub credentials or command bodies are stored in this table.
CREATE TABLE IF NOT EXISTS agent_task_dispatches (
  client_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  project TEXT NOT NULL,
  bootstrap_ref TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('submitting','dispatched','rejected','uncertain')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, request_id)
) WITHOUT ROWID;
