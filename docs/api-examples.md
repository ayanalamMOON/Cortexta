# CORTEXA Daemon API Examples (Copy/Paste JSON)

These are practical request/response examples for every currently exposed daemon endpoint.

[← Back to README](../README.md)

## Base URL and auth

- Base URL (default): `http://localhost:4312`
- If `CORTEXA_DAEMON_TOKEN` is configured, send one of:
  - `x-cortexa-token: <token>`
  - `Authorization: Bearer <token>`

All examples below use JSON request bodies for `POST` routes.

---

## 1) Health

### GET `/health`

**Response**
```json
{
  "ok": true,
  "service": "cortexa-daemon",
  "ts": 1713432172123,
  "uptimeMs": 23567
}
```

---

## 2) Core routes

### POST `/ingest`

Notes:
- `path` is required.
- `includeChats` defaults to `false` for API calls unless provided.

**Request**
```json
{
  "path": "C:/Users/ayana/Projects/Cortexta",
  "projectId": "cortexta",
  "includeChats": true,
  "maxFiles": 3000,
  "maxChatFiles": 500,
  "chatRoot": "C:/Users/ayana/AppData/Roaming/Code/User/workspaceStorage"
}
```

**Response**
```json
{
  "ok": true,
  "route": "ingest",
  "result": {
    "filesScanned": 714,
    "codeChunks": 1910,
    "chatTurns": 220,
    "memoriesStored": 2130,
    "errors": []
  }
}
```

### POST `/query`

**Request**
```json
{
  "query": "how is compaction dashboard built?",
  "projectId": "cortexta",
  "topK": 5,
  "minScore": 0.55
}
```

**Response**
```json
{
  "ok": true,
  "route": "query",
  "count": 1,
  "results": [
    {
      "id": "code_4b132f3a5b4f0f5dc7ab9123",
      "projectId": "cortexta",
      "kind": "code_entity",
      "sourceType": "code",
      "title": "Compaction dashboard aggregation",
      "summary": "Builds global and per-project trend payload.",
      "content": "export function getMemoryCompactionDashboard(...) { ... }",
      "tags": [
        "typescript",
        "file:core/mempalace/memory.service.ts"
      ],
      "importance": 0.72,
      "confidence": 0.7,
      "createdAt": 1713431111000,
      "lastAccessedAt": 1713432111000,
      "sourceRef": "core/mempalace/memory.service.ts",
      "copilotContent": "getMemoryCompactionDashboard aggregates current stats, trend snapshots and project risk.",
      "score": 0.8934,
      "similarity": 0.82,
      "recency": 0.9912
    }
  ]
}
```

### POST `/context`

**Request**
```json
{
  "query": "add a new risk dimension to compaction dashboard",
  "projectId": "cortexta",
  "maxTokens": 4096,
  "topK": 12,
  "constraints": [
    "preserve existing API schema",
    "add integration tests"
  ],
  "scope": "core/mempalace"
}
```

**Response**
```json
{
  "ok": true,
  "route": "context",
  "context": "### Objective\nAdd a new risk dimension ...",
  "tokens": 1328,
  "memoriesUsed": 8,
  "dropped": 4
}
```

### POST `/evolve`

**Request**
```json
{
  "projectId": "cortexta",
  "dryRun": false,
  "limit": 500
}
```

**Response**
```json
{
  "ok": true,
  "route": "evolve",
  "dryRun": false,
  "sourceCount": 500,
  "evolvedCount": 438,
  "removed": 62,
  "persistedCount": 438
}
```

---

## 3) CX-LINK routes

### POST `/cxlink/context`

**Request**
```json
{
  "query": "wire compaction stats into a dashboard widget",
  "agent": "cli",
  "projectId": "cortexta",
  "topK": 12,
  "minScore": 0.5
}
```

**Response**
```json
{
  "ok": true,
  "route": "cxlink/context",
  "agent": "cli",
  "tokens": 944,
  "context": "# Context\n- ...",
  "cxf": "intent: wire compaction stats into a dashboard widget\nscope: project + memory + retrieval",
  "envelope": "# Context\n- ...\n\n[CONTEXT_STATS]\ntokens=944 atoms=12 dropped=3\n\n[USER_QUERY]\nwire compaction stats into a dashboard widget"
}
```

### POST `/cxlink/query`

**Request**
```json
{
  "query": "memory backfill behavior",
  "agent": "cli",
  "projectId": "cortexta",
  "topK": 6,
  "minScore": 0.5
}
```

**Response**
```json
{
  "ok": true,
  "route": "cxlink/query",
  "query": "memory backfill behavior",
  "count": 1,
  "results": [
    {
      "id": "code_2f8f4dbeacbd7e6bc8d9a111",
      "projectId": "cortexta",
      "kind": "code_entity",
      "sourceType": "code",
      "title": "backfillMemoryCompaction",
      "summary": "Dry-run/apply compaction over recent rows.",
      "content": "export function backfillMemoryCompaction(...) { ... }",
      "tags": [
        "typescript",
        "file:core/mempalace/memory.service.ts"
      ],
      "importance": 0.72,
      "confidence": 0.7,
      "createdAt": 1713430001000,
      "lastAccessedAt": 1713432001000,
      "sourceRef": "core/mempalace/memory.service.ts",
      "copilotContent": "Scans rows, skips already compacted entries, and reports scanned/eligible/compacted/savedChars.",
      "score": 0.8755,
      "similarity": 0.81,
      "recency": 0.9901
    }
  ],
  "cxf": "intent: memory backfill behavior\nscope: project + memory + retrieval",
  "envelope": "# Context\n- ...\n\n[CONTEXT_STATS]\ntokens=611 atoms=6 dropped=0\n\n[USER_QUERY]\nmemory backfill behavior"
}
```

### POST `/cxlink/plan`

**Request**
```json
{
  "query": "introduce retention alerting for compaction anomalies",
  "agent": "cli",
  "projectId": "cortexta",
  "topK": 8,
  "minScore": 0.45
}
```

**Response**
```json
{
  "ok": true,
  "route": "cxlink/plan",
  "query": "introduce retention alerting for compaction anomalies",
  "agent": "cli",
  "tokens": 702,
  "steps": [
    {
      "id": 1,
      "title": "Confirm objective and constraints",
      "detail": "Clarify the primary goal for: introduce retention alerting for compaction anomalies"
    },
    {
      "id": 2,
      "title": "Collect relevant context",
      "detail": "Review top-ranked memory/code entities and extract high-confidence facts."
    },
    {
      "id": 3,
      "title": "Execute change in bounded increments",
      "detail": "Apply updates in small steps, validate after each change, and track regressions early."
    },
    {
      "id": 4,
      "title": "Verify and summarize",
      "detail": "Run validation checks, capture outcomes, and document follow-up actions."
    }
  ],
  "cxf": "intent: introduce retention alerting for compaction anomalies\nscope: project + memory + retrieval",
  "envelope": "# Context\n- ...\n\n[CONTEXT_STATS]\ntokens=702 atoms=8 dropped=2\n\n[USER_QUERY]\nintroduce retention alerting for compaction anomalies"
}
```

---

## 4) Compaction routes

### POST `/cxlink/compaction/stats`

**Request**
```json
{
  "projectId": "cortexta"
}
```

**Response**
```json
{
  "ok": true,
  "route": "cxlink/compaction/stats",
  "stats": {
    "projectId": "cortexta",
    "totalRows": 1500,
    "compactedRows": 1200,
    "plainRows": 300,
    "storedChars": 500000,
    "originalChars": 2000000,
    "savedChars": 1500000,
    "savedPercent": 75,
    "compactionRate": 0.8,
    "averageCompressionRatio": 0.25,
    "integrityAnomalies": {
      "invalidChecksum": 0,
      "decodeError": 0,
      "total": 0
    }
  }
}
```

### POST `/cxlink/compaction/backfill`

**Request**
```json
{
  "projectId": "cortexta",
  "limit": 5000,
  "dryRun": false
}
```

**Response**
```json
{
  "ok": true,
  "route": "cxlink/compaction/backfill",
  "result": {
    "projectId": "cortexta",
    "dryRun": false,
    "scanned": 5000,
    "eligible": 1200,
    "compacted": 1200,
    "skipped": 3800,
    "savedChars": 450000
  }
}
```

### POST `/cxlink/compaction/dashboard`

**Request**
```json
{
  "projectId": "cortexta",
  "lookbackDays": 30,
  "maxTrendPoints": 120,
  "maxProjects": 50,
  "persistSnapshot": true,
  "perProjectSnapshotLimit": 25,
  "snapshotRetentionDays": 180
}
```

**Response**
```json
{
  "ok": true,
  "route": "cxlink/compaction/dashboard",
  "dashboard": {
    "generatedAt": 1713430000000,
    "lookbackDays": 30,
    "scopedProjectId": "cortexta",
    "current": {
      "projectId": "cortexta",
      "totalRows": 1500,
      "compactedRows": 1200,
      "plainRows": 300,
      "storedChars": 500000,
      "originalChars": 2000000,
      "savedChars": 1500000,
      "savedPercent": 75,
      "compactionRate": 0.8,
      "averageCompressionRatio": 0.25,
      "integrityAnomalies": {
        "invalidChecksum": 0,
        "decodeError": 0,
        "total": 0
      }
    },
    "trend": {
      "global": [
        {
          "createdAt": 1713343600000,
          "totalRows": 1400,
          "compactedRows": 1000,
          "plainRows": 400,
          "storedChars": 520000,
          "originalChars": 2000000,
          "savedChars": 1480000,
          "savedPercent": 74,
          "compactionRate": 0.7143,
          "invalidChecksum": 0,
          "decodeError": 0,
          "integrityAnomalyTotal": 0
        },
        {
          "createdAt": 1713430000000,
          "totalRows": 1500,
          "compactedRows": 1200,
          "plainRows": 300,
          "storedChars": 500000,
          "originalChars": 2000000,
          "savedChars": 1500000,
          "savedPercent": 75,
          "compactionRate": 0.8,
          "invalidChecksum": 0,
          "decodeError": 0,
          "integrityAnomalyTotal": 0
        }
      ],
      "scopedProject": [
        {
          "projectId": "cortexta",
          "createdAt": 1713430000000,
          "totalRows": 1500,
          "compactedRows": 1200,
          "plainRows": 300,
          "storedChars": 500000,
          "originalChars": 2000000,
          "savedChars": 1500000,
          "savedPercent": 75,
          "compactionRate": 0.8,
          "invalidChecksum": 0,
          "decodeError": 0,
          "integrityAnomalyTotal": 0
        }
      ]
    },
    "perProject": [
      {
        "projectId": "cortexta",
        "stats": {
          "projectId": "cortexta",
          "totalRows": 1500,
          "compactedRows": 1200,
          "plainRows": 300,
          "storedChars": 500000,
          "originalChars": 2000000,
          "savedChars": 1500000,
          "savedPercent": 75,
          "compactionRate": 0.8,
          "averageCompressionRatio": 0.25,
          "integrityAnomalies": {
            "invalidChecksum": 0,
            "decodeError": 0,
            "total": 0
          }
        },
        "lastAccessedAt": 1713425000000,
        "riskLevel": "healthy"
      }
    ],
    "integrityAnomalies": {
      "invalidChecksum": 0,
      "decodeError": 0,
      "total": 0
    },
    "totals": {
      "projectCount": 1,
      "projectsWithAnomalies": 0,
      "projectsMostlyCompacted": 1
    }
  }
}
```

---

## Common error responses

### Missing required field
```json
{
  "ok": false,
  "error": "Missing required field: query"
}
```

### Invalid token
```json
{
  "ok": false,
  "error": "unauthorized"
}
```
