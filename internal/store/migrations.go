package store

const migrateIssueThreadEventsNoContentSQL = `
ALTER TABLE issue_thread_events RENAME TO issue_thread_events_old;
CREATE TABLE issue_thread_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  event_key TEXT,
  event_type TEXT NOT NULL,
  actor TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issue_threads(issue_id)
);
INSERT INTO issue_thread_events(id,issue_id,event_key,event_type,actor,payload_json,created_at)
SELECT id,issue_id,event_key,event_type,actor,payload_json,created_at FROM issue_thread_events_old;
DROP TABLE issue_thread_events_old;
`

const migrateIssueRunsNoContentSQL = `
ALTER TABLE issue_runs RENAME TO issue_runs_old;
CREATE TABLE issue_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  source_event_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  posted INTEGER NOT NULL DEFAULT 0,
  attribution TEXT,
  error TEXT,
  completion_reason TEXT,
  FOREIGN KEY (issue_id) REFERENCES issue_threads(issue_id)
);
INSERT INTO issue_runs(id,issue_id,source_event_type,started_at,completed_at,posted,attribution,error,completion_reason)
SELECT id,issue_id,source_event_type,started_at,completed_at,posted,attribution,error,completion_reason FROM issue_runs_old;
DROP TABLE issue_runs_old;
`

const migrateAgentThreadEventsNoContentSQL = `
ALTER TABLE agent_thread_events RENAME TO agent_thread_events_old;
CREATE TABLE agent_thread_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT,
  actor_id TEXT,
  external_message_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES agent_threads(thread_id)
);
INSERT INTO agent_thread_events(id,thread_id,event_type,actor,actor_id,external_message_id,payload_json,created_at)
SELECT id,thread_id,event_type,actor,actor_id,external_message_id,payload_json,created_at FROM agent_thread_events_old;
DROP TABLE agent_thread_events_old;
`

const migrateAgentRunsNoContentSQL = `
ALTER TABLE agent_runs RENAME TO agent_runs_old;
CREATE TABLE agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  source_event_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  posted INTEGER NOT NULL DEFAULT 0,
  attribution TEXT,
  error TEXT,
  completion_reason TEXT,
  summary TEXT,
  FOREIGN KEY (thread_id) REFERENCES agent_threads(thread_id)
);
INSERT INTO agent_runs(id,thread_id,source_event_type,started_at,completed_at,posted,attribution,error,completion_reason,summary)
SELECT id,thread_id,source_event_type,started_at,completed_at,posted,attribution,error,completion_reason,summary FROM agent_runs_old;
DROP TABLE agent_runs_old;
`
