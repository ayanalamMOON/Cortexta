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
  "uptimeMs": 23567,
  "selfHealing": {
    "enabled": true,
    "started": true,
    "running": false,
    "nextRunAt": 1713433972123,
    "lastScheduledDelayMs": 1805421,
    "consecutiveFailures": 0,
    "lastOutcome": "dry-run-only",
    "runCount": 14,
    "slo": {
      "generatedAt": 1713432172123,
      "windows": [
        {
          "windowMinutes": 60,
          "windowMs": 3600000,
          "sinceMs": 1713428572123,
          "total": 3,
          "applied": 1,
          "dryRunOnly": 2,
          "skipped": 0,
          "error": 0,
          "successRate": 1,
          "errorRate": 0,
          "applyRate": 0.3333
        }
      ]
    }
  }
}
```

---

## 2) Core routes

### POST `/ingest`

Notes:
- `path` is required.
- `includeChats` defaults to `false` for API calls unless provided.
- `skipUnchanged` defaults to `true` for API calls.

**Request**
```json
{
  "path": "C:/Users/ayana/Projects/Cortexta",
  "projectId": "cortexta",
  "includeChats": true,
  "skipUnchanged": true,
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
    "codeFilesSkippedUnchanged": 312,
    "chatFilesScanned": 18,
    "chatFilesSkippedUnchanged": 11,
    "codeChunks": 1910,
    "chatTurns": 220,
    "memoriesStored": 2130,
    "skipUnchanged": true,
    "ingestVersion": "ingest-v2",
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

Notes:
- If `text` is omitted, the route uses **consolidate mode** (existing batch consolidation behavior).
- If `text` is provided, the route uses **progression mode** and returns `progression` stage telemetry.
- `POST /evolve/progression` is a strict alias for progression mode and requires `text`.

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

**Request (progression mode)**
```json
{
  "projectId": "cortexta",
  "text": "upgrade memory evolution progression telemetry",
  "context": "operator-triggered daemon cycle",
  "dryRun": true
}
```

**Response (progression mode)**
```json
{
  "ok": true,
  "route": "evolve",
  "mode": "progression",
  "projectId": "cortexta",
  "dryRun": true,
  "stored": true,
  "persisted": false,
  "action": "store",
  "reason": "fallback-heuristic",
  "atomId": "mem_n4yk3x8z",
  "progression": {
    "proposedCandidates": 1,
    "reviewedCandidates": 1,
    "selectedCandidateIndex": 0,
    "selectedScore": 0.6934,
    "merged": false,
    "neighborCount": 3,
    "promoted": false,
    "archived": false,
    "stages": [
      {
        "stage": "propose",
        "ok": true,
        "detail": "writer-produced-1-candidate(s)",
        "at": 1713433000000
      },
      {
        "stage": "review",
        "ok": true,
        "detail": "selected-candidate-0-action-store",
        "at": 1713433000005
      },
      {
        "stage": "consolidate",
        "ok": true,
        "detail": "no-consolidation-required",
        "at": 1713433000007
      },
      {
        "stage": "archivist",
        "ok": true,
        "detail": "decay=1 promote=false archive=false",
        "at": 1713433000008
      },
      {
        "stage": "persist",
        "ok": true,
        "detail": "upserted",
        "at": 1713433000009
      }
    ]
  }
}
```

### POST `/evolve/progression`

Notes:
- Strict progression endpoint alias.
- Requires `text`; missing `text` returns `400` with `{"ok":false,"error":"Missing required field: text"}`.

**Request**
```json
{
  "projectId": "cortexta",
  "text": "upgrade memory evolution progression telemetry",
  "context": "operator-triggered daemon cycle",
  "dryRun": true
}
```

**Response**
```json
{
  "ok": true,
  "route": "evolve/progression",
  "mode": "progression",
  "projectId": "cortexta",
  "dryRun": true,
  "stored": true,
  "persisted": false,
  "action": "store",
  "reason": "fallback-heuristic",
  "atomId": "mem_n4yk3x8z",
  "progression": {
    "proposedCandidates": 1,
    "reviewedCandidates": 1,
    "selectedCandidateIndex": 0,
    "selectedScore": 0.6934,
    "merged": false,
    "neighborCount": 3,
    "promoted": false,
    "archived": false,
    "stages": [
      {
        "stage": "propose",
        "ok": true,
        "detail": "writer-produced-1-candidate(s)",
        "at": 1713433000000
      }
    ]
  }
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
  "memoryHealth": {
    "projectId": "cortexta",
    "totalRows": 4200,
    "compactionRate": 0.81,
    "savedPercent": 74.2,
    "anomalyTotal": 0,
    "status": "healthy",
    "recommendation": "Memory quality is healthy. Keep regular ingestion and dashboard snapshots running."
  },
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
  "memoryHealth": {
    "projectId": "cortexta",
    "totalRows": 4200,
    "compactionRate": 0.81,
    "savedPercent": 74.2,
    "anomalyTotal": 0,
    "status": "healthy",
    "recommendation": "Memory quality is healthy. Keep regular ingestion and dashboard snapshots running."
  },
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
  "memoryHealth": {
    "projectId": "cortexta",
    "totalRows": 4200,
    "compactionRate": 0.81,
    "savedPercent": 74.2,
    "anomalyTotal": 0,
    "status": "healthy",
    "recommendation": "Memory quality is healthy. Keep regular ingestion and dashboard snapshots running."
  },
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

### POST `/cxlink/compaction/audit`

**Request**
```json
{
  "projectId": "cortexta",
  "limit": 5000,
  "maxIssues": 10
}
```

**Response**
```json
{
  "ok": true,
  "route": "cxlink/compaction/audit",
  "report": {
    "projectId": "cortexta",
    "scannedRows": 5000,
    "compactedRows": 4100,
    "plainRows": 900,
    "validCompactedRows": 4098,
    "anomalies": {
      "invalidChecksum": 1,
      "decodeError": 1,
      "total": 2
    },
    "anomalyRate": 0.0005,
    "compactionOpportunityRate": 0.18,
    "issueSamples": [
      {
        "id": "cmp_integrity_anomaly_1",
        "projectId": "cortexta",
        "kind": "code_entity",
        "sourceType": "manual",
        "title": "Integrity anomaly sample",
        "integrity": "invalid_checksum",
        "preview": "Tampered compact row for anomaly accounting.",
        "storedChars": 321,
        "originalChars": 1280,
        "savedChars": 959,
        "lastAccessedAt": 1713431000000
      }
    ],
    "recommendations": [
      "Integrity anomalies detected. Inspect issue samples and re-ingest affected sources to restore full resurrection fidelity."
    ]
  }
}
```

### POST `/cxlink/compaction/self-heal/status`

**Request**
```json
{}
```

**Response**
```json
{
  "ok": true,
  "route": "cxlink/compaction/self-heal/status",
  "status": {
    "enabled": true,
    "started": true,
    "running": false,
    "nextRunAt": 1713433972123,
    "lastScheduledDelayMs": 1805421,
    "consecutiveFailures": 0,
    "runCount": 14,
    "config": {
      "enabled": true,
      "projectId": "cortexta",
      "intervalMs": 1800000,
      "jitterMs": 60000,
      "runOnStart": true,
      "auditLimit": 5000,
      "auditMaxIssues": 20,
      "backfillLimit": 5000,
      "applyEnabled": true,
      "maxAllowedAnomalies": 0,
      "minCompactionOpportunityRate": 0.2,
      "minDryRunCompactedRows": 50,
      "maxApplyRows": 2000,
      "applyWindowStartHour": 1,
      "applyWindowEndHour": 5,
      "historyLimit": 50,
      "persistHistory": true,
      "persistedHistoryLimit": 2000,
      "backoffEnabled": true,
      "backoffMultiplier": 2,
      "maxBackoffIntervalMs": 21600000,
      "sloWindowsMinutes": [
        60,
        1440,
        10080
      ]
    },
    "lastRun": {
      "runId": "selfheal_m14a2f_9",
      "trigger": "scheduled",
      "dryRunOnly": false,
      "startedAt": 1713432100000,
      "completedAt": 1713432100190,
      "durationMs": 190,
      "outcome": "dry-run-only",
      "decision": {
        "allowApply": false,
        "applyLimit": 2000,
        "reasons": [
          "Compaction opportunity below threshold (0.1200 < 0.2000)."
        ]
      }
    },
    "recentRuns": [],
    "slo": {
      "generatedAt": 1713433972123,
      "windows": [
        {
          "windowMinutes": 60,
          "windowMs": 3600000,
          "sinceMs": 1713430372123,
          "total": 2,
          "applied": 0,
          "dryRunOnly": 2,
          "skipped": 0,
          "error": 0,
          "successRate": 1,
          "errorRate": 0,
          "applyRate": 0
        }
      ]
    }
  }
}
```

### POST `/cxlink/compaction/self-heal/trigger`

**Request**
```json
{
  "reason": "nightly-ops-check",
  "dryRunOnly": true
}
```

**Response**
```json
{
  "ok": true,
  "route": "cxlink/compaction/self-heal/trigger",
  "report": {
    "runId": "selfheal_m14a2f_a",
    "trigger": "manual",
    "reason": "nightly-ops-check",
    "dryRunOnly": true,
    "startedAt": 1713432200000,
    "completedAt": 1713432200181,
    "durationMs": 181,
    "outcome": "dry-run-only",
    "decision": {
      "allowApply": false,
      "applyLimit": 2000,
      "reasons": [
        "Manual dry-run only mode requested.",
        "Apply mode is disabled by configuration."
      ]
    },
    "audit": {
      "scannedRows": 5000,
      "compactedRows": 4100,
      "plainRows": 900,
      "anomalies": {
        "invalidChecksum": 0,
        "decodeError": 0,
        "total": 0
      },
      "anomalyRate": 0,
      "compactionOpportunityRate": 0.18,
      "recommendationCount": 1
    },
    "dryRunBackfill": {
      "projectId": "cortexta",
      "dryRun": true,
      "scanned": 5000,
      "eligible": 900,
      "compacted": 900,
      "skipped": 4100,
      "savedChars": 350000
    }
  },
  "status": {
    "runCount": 15
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
