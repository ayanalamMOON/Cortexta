CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  projectId TEXT,
  kind TEXT,
  sourceType TEXT,
  title TEXT,
  summary TEXT,
  content TEXT,
  tags TEXT,
  importance REAL,
  confidence REAL,
  createdAt INTEGER,
  lastAccessedAt INTEGER,
  embeddingRef TEXT,
  sourceRef TEXT
);

CREATE TABLE IF NOT EXISTS code_entities (
  id TEXT PRIMARY KEY,
  projectId TEXT,
  filePath TEXT,
  kind TEXT,
  language TEXT,
  name TEXT,
  signature TEXT,
  summary TEXT,
  complexityHint TEXT,
  startLine INTEGER,
  endLine INTEGER,
  startIndex INTEGER,
  endIndex INTEGER,
  sourceHash TEXT,
  createdAt INTEGER,
  updatedAt INTEGER
);

CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  type TEXT,
  label TEXT,
  projectId TEXT,
  metadata TEXT,
  createdAt INTEGER
);

CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY,
  fromNode TEXT,
  toNode TEXT,
  type TEXT,
  weight REAL,
  projectId TEXT,
  metadata TEXT,
  createdAt INTEGER
);

CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  projectId TEXT,
  agentName TEXT,
  eventType TEXT,
  payload TEXT,
  createdAt INTEGER
);

CREATE TABLE IF NOT EXISTS stream_checkpoints (
  id TEXT PRIMARY KEY,
  projectId TEXT,
  sessionId TEXT,
  cursor TEXT,
  state TEXT,
  createdAt INTEGER
);

CREATE TABLE IF NOT EXISTS memory_compaction_snapshots (
  id TEXT PRIMARY KEY,
  projectId TEXT,
  totalRows INTEGER,
  compactedRows INTEGER,
  plainRows INTEGER,
  storedChars INTEGER,
  originalChars INTEGER,
  savedChars INTEGER,
  savedPercent REAL,
  compactionRate REAL,
  invalidChecksum INTEGER,
  decodeError INTEGER,
  integrityAnomalyTotal INTEGER,
  createdAt INTEGER
);

CREATE TABLE IF NOT EXISTS memory_ingestion_sources (
  id TEXT PRIMARY KEY,
  projectId TEXT,
  sourceType TEXT,
  sourceRef TEXT,
  contentHash TEXT,
  contentBytes INTEGER,
  ingestVersion TEXT,
  firstIngestedAt INTEGER,
  lastIngestedAt INTEGER
);

CREATE TABLE IF NOT EXISTS self_healing_run_history (
  id TEXT PRIMARY KEY,
  schedulerScope TEXT NOT NULL,
  projectId TEXT,
  trigger TEXT NOT NULL,
  outcome TEXT NOT NULL,
  dryRunOnly INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  startedAt INTEGER NOT NULL,
  completedAt INTEGER NOT NULL,
  durationMs INTEGER NOT NULL,
  payload TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(projectId);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(lastAccessedAt);
CREATE INDEX IF NOT EXISTS idx_code_entities_project ON code_entities(projectId);
CREATE INDEX IF NOT EXISTS idx_code_entities_file ON code_entities(filePath);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_project ON graph_nodes(projectId);
CREATE INDEX IF NOT EXISTS idx_graph_edges_project ON graph_edges(projectId);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from_to ON graph_edges(fromNode, toNode);
CREATE INDEX IF NOT EXISTS idx_compaction_snapshots_created_at ON memory_compaction_snapshots(createdAt);
CREATE INDEX IF NOT EXISTS idx_compaction_snapshots_project_created_at ON memory_compaction_snapshots(projectId, createdAt);
CREATE INDEX IF NOT EXISTS idx_ingestion_sources_project_type ON memory_ingestion_sources(projectId, sourceType);
CREATE INDEX IF NOT EXISTS idx_ingestion_sources_project_ref ON memory_ingestion_sources(projectId, sourceType, sourceRef);
CREATE INDEX IF NOT EXISTS idx_self_healing_history_scope_started ON self_healing_run_history(schedulerScope, startedAt DESC);
CREATE INDEX IF NOT EXISTS idx_self_healing_history_scope_outcome_started ON self_healing_run_history(schedulerScope, outcome, startedAt DESC);
