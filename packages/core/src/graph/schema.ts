export const graphSchemaSql = `
CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  type TEXT,
  label TEXT,
  projectId TEXT,
  metadata TEXT,
  createdAt INTEGER,
  updatedAt INTEGER
);

CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY,
  fromNode TEXT,
  toNode TEXT,
  type TEXT,
  weight REAL,
  projectId TEXT,
  metadata TEXT,
  createdAt INTEGER,
  updatedAt INTEGER,
  UNIQUE(fromNode, toNode, type, projectId)
);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_project ON graph_nodes(projectId);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type);
CREATE INDEX IF NOT EXISTS idx_graph_edges_project ON graph_edges(projectId);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(fromNode);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(toNode);
CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(type);
`;
