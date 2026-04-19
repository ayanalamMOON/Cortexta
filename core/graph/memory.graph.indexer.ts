import crypto from "node:crypto";
import path from "node:path";
import type { SqliteDatabase } from "../../storage/sqlite/db";
import { connectSqlite, initializeSqlite } from "../../storage/sqlite/db";
import { parseTags } from "../mempalace/memory.model";
import { listMemories } from "../mempalace/memory.service";
import type { MemoryKind, MemoryRecord, MemorySourceType } from "../mempalace/memory.types";

const MAIN_BRANCH = "main";
const DEFAULT_LIMIT = 5000;
const DEFAULT_SNAPSHOT_LIMIT = 5000;
const DEFAULT_LOOKBACK_HOURS = 24 * 14;

type GraphEdgeType = "derived_from" | "explains" | "depends_on";

interface GraphNodeWrite {
    id: string;
    type: string;
    label: string;
    projectId: string;
    metadata: Record<string, unknown>;
    createdAt: number;
}

interface GraphEdgeWrite {
    id: string;
    fromNode: string;
    toNode: string;
    type: GraphEdgeType;
    weight: number;
    projectId: string;
    metadata: Record<string, unknown>;
    createdAt: number;
}

interface MemorySnapshotRow {
    logicalId: string;
    operation: "upsert" | "delete";
    kind: MemoryKind;
    sourceType: MemorySourceType;
    title: string;
    sourceRef?: string;
    tags: string[];
    validFrom: number;
    validUntil?: number;
    createdAt: number;
}

export interface GraphMemoryIndexInput {
    projectId: string;
    branch?: string;
    sinceMs?: number;
    lookbackHours?: number;
    limit?: number;
    snapshotLimit?: number;
}

export interface GraphMemoryIndexResult {
    projectId: string;
    branch: string;
    sinceMs: number;
    scannedMemories: number;
    scannedSnapshots: number;
    nodesUpserted: number;
    edgesUpserted: number;
    memoryNodes: number;
    sessionNodes: number;
    temporalNodes: number;
    sessionEdges: number;
    temporalEdges: number;
    chatToCodeEdges: number;
}

const db = connectSqlite();
initializeSqlite(db);

function stableId(prefix: string, parts: Array<string | number | undefined>): string {
    const hash = crypto
        .createHash("sha1")
        .update(parts.map((part) => String(part ?? "")).join("|"))
        .digest("hex")
        .slice(0, 24);

    return `${prefix}_${hash}`;
}

function normalizeBranchName(value: unknown): string {
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized || MAIN_BRANCH;
}

function normalizeProjectId(value: unknown): string {
    const normalized = String(value ?? "default").trim();
    return normalized || "default";
}

function normalizeSlashes(value: string): string {
    return value.replace(/\\/g, "/").trim();
}

function normalizeSourceRef(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const normalized = normalizeSlashes(value);
    return normalized || undefined;
}

function toBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function toDayBucket(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10);
}

function readChatSessionRef(memory: { sourceRef?: string; tags?: string[]; sourceType?: string; kind?: string }): string | undefined {
    if (memory.sourceType === "chat" || memory.kind === "chat_turn") {
        const direct = normalizeSourceRef(memory.sourceRef);
        if (direct) {
            return direct;
        }
    }

    const tags = memory.tags ?? [];
    for (const tag of tags) {
        if (!tag.startsWith("chat-file:")) {
            continue;
        }

        const sourceRef = normalizeSourceRef(tag.slice("chat-file:".length));
        if (sourceRef) {
            return sourceRef;
        }
    }

    return undefined;
}

function readFileRefs(memory: { sourceRef?: string; tags?: string[]; kind?: string; sourceType?: string }): string[] {
    const refs = new Set<string>();

    const direct = normalizeSourceRef(memory.sourceRef);
    if (direct && (memory.kind === "code_entity" || memory.sourceType === "code")) {
        refs.add(direct);
    }

    for (const tag of memory.tags ?? []) {
        if (!tag.startsWith("file:")) {
            continue;
        }

        const ref = normalizeSourceRef(tag.slice("file:".length));
        if (ref) {
            refs.add(ref);
        }
    }

    return [...refs];
}

function memoryNodeId(projectId: string, branch: string, logicalId: string): string {
    return stableId("gx_mem", [projectId, branch, logicalId]);
}

function sessionNodeId(projectId: string, branch: string, sessionRef: string): string {
    return stableId("gx_session", [projectId, branch, sessionRef]);
}

function temporalNodeId(projectId: string, branch: string, dayBucket: string): string {
    return stableId("gx_time", [projectId, branch, dayBucket]);
}

function edgeId(projectId: string, branch: string, fromNode: string, toNode: string, type: GraphEdgeType, scope?: string): string {
    return stableId("gx_edge", [projectId, branch, fromNode, toNode, type, scope]);
}

function readMemorySnapshots(params: {
    db: SqliteDatabase;
    projectId: string;
    branch: string;
    sinceMs: number;
    limit: number;
}): MemorySnapshotRow[] {
    const rows = params.db
        .prepare(
            `
            SELECT logicalId, operation, kind, sourceType, title, sourceRef, tags, validFrom, validUntil, createdAt
            FROM memory_snapshots
            WHERE projectId = ?
              AND branch = ?
              AND validFrom >= ?
            ORDER BY validFrom DESC
            LIMIT ?
          `
        )
        .all<Record<string, unknown>>(params.projectId, params.branch, params.sinceMs, params.limit);

    return rows
        .map<MemorySnapshotRow | null>((row) => {
            const logicalId = String(row.logicalId ?? "").trim();
            const validFrom = Number(row.validFrom ?? 0);

            if (!logicalId || !Number.isFinite(validFrom) || validFrom <= 0) {
                return null;
            }

            return {
                logicalId,
                operation: String(row.operation ?? "upsert") === "delete" ? "delete" : "upsert",
                kind: (String(row.kind ?? "semantic") as MemoryKind),
                sourceType: (String(row.sourceType ?? "manual") as MemorySourceType),
                title: String(row.title ?? "").trim() || `Memory ${logicalId}`,
                sourceRef: normalizeSourceRef(row.sourceRef),
                tags: parseTags(row.tags),
                validFrom,
                validUntil:
                    row.validUntil === null || row.validUntil === undefined
                        ? undefined
                        : Number(row.validUntil),
                createdAt: Number(row.createdAt ?? validFrom)
            };
        })
        .filter((row): row is MemorySnapshotRow => Boolean(row));
}

function upsertNode(target: Map<string, GraphNodeWrite>, node: GraphNodeWrite): void {
    const existing = target.get(node.id);
    if (!existing) {
        target.set(node.id, node);
        return;
    }

    target.set(node.id, {
        ...existing,
        type: node.type,
        label: node.label,
        metadata: {
            ...existing.metadata,
            ...node.metadata
        }
    });
}

function upsertEdge(target: Map<string, GraphEdgeWrite>, edge: GraphEdgeWrite): void {
    const existing = target.get(edge.id);
    if (!existing) {
        target.set(edge.id, edge);
        return;
    }

    target.set(edge.id, {
        ...existing,
        weight: Math.max(existing.weight, edge.weight),
        metadata: {
            ...existing.metadata,
            ...edge.metadata
        }
    });
}

function upsertGraphRows(params: {
    db: SqliteDatabase;
    nodes: GraphNodeWrite[];
    edges: GraphEdgeWrite[];
}): void {
    if (params.nodes.length === 0 && params.edges.length === 0) {
        return;
    }

    const insertNode = params.db.prepare(
        `
        INSERT INTO graph_nodes (id, type, label, projectId, metadata, createdAt)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            type = excluded.type,
            label = excluded.label,
            projectId = excluded.projectId,
            metadata = excluded.metadata
      `
    );

    const insertEdge = params.db.prepare(
        `
        INSERT INTO graph_edges (id, fromNode, toNode, type, weight, projectId, metadata, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            fromNode = excluded.fromNode,
            toNode = excluded.toNode,
            type = excluded.type,
            weight = excluded.weight,
            projectId = excluded.projectId,
            metadata = excluded.metadata
      `
    );

    const tx = params.db.transaction(() => {
        for (const node of params.nodes) {
            insertNode.run(
                node.id,
                node.type,
                node.label,
                node.projectId,
                JSON.stringify(node.metadata),
                node.createdAt
            );
        }

        for (const edge of params.edges) {
            insertEdge.run(
                edge.id,
                edge.fromNode,
                edge.toNode,
                edge.type,
                edge.weight,
                edge.projectId,
                JSON.stringify(edge.metadata),
                edge.createdAt
            );
        }
    });

    tx();
}

function toGraphNodeType(kind: MemoryKind): string {
    if (kind === "chat_turn") {
        return "chat";
    }

    if (kind === "code_entity") {
        return "function";
    }

    return "memory";
}

function toLogicalId(memory: MemoryRecord): string {
    const logicalId = typeof memory.logicalId === "string" ? memory.logicalId.trim() : "";
    return logicalId || memory.id;
}

export function indexMemoryGraph(input: GraphMemoryIndexInput): GraphMemoryIndexResult {
    const now = Date.now();
    const projectId = normalizeProjectId(input.projectId);
    const branch = normalizeBranchName(input.branch);
    const lookbackHours = toBoundedInt(input.lookbackHours, DEFAULT_LOOKBACK_HOURS, 1, 24 * 365);
    const fallbackSinceMs = now - lookbackHours * 60 * 60 * 1000;
    const sinceMs = toBoundedInt(input.sinceMs, fallbackSinceMs, 0, 32_503_680_000_000);
    const memoryLimit = toBoundedInt(input.limit, DEFAULT_LIMIT, 1, 20_000);
    const snapshotLimit = toBoundedInt(input.snapshotLimit, DEFAULT_SNAPSHOT_LIMIT, 1, 20_000);

    const memories = listMemories(projectId, memoryLimit, { branch }).filter((memory) => {
        const ts = Number(memory.lastAccessedAt ?? memory.createdAt ?? 0);
        return Number.isFinite(ts) && ts >= sinceMs;
    });

    const snapshots = readMemorySnapshots({
        db,
        projectId,
        branch,
        sinceMs,
        limit: snapshotLimit
    });

    const nodes = new Map<string, GraphNodeWrite>();
    const edges = new Map<string, GraphEdgeWrite>();

    const memoryNodeIds = new Set<string>();
    const sessionNodeIds = new Set<string>();
    const temporalNodeIds = new Set<string>();
    const sessionEdgeIds = new Set<string>();
    const temporalEdgeIds = new Set<string>();
    const chatToCodeEdgeIds = new Set<string>();

    const codeMemoryByFileRef = new Map<string, string[]>();

    for (const memory of memories) {
        const logicalId = toLogicalId(memory);
        const nodeId = memoryNodeId(projectId, branch, logicalId);

        upsertNode(nodes, {
            id: nodeId,
            type: toGraphNodeType(memory.kind),
            label: memory.title || logicalId,
            projectId,
            metadata: {
                indexer: "session-temporal",
                branch,
                logicalId,
                storageId: memory.id,
                kind: memory.kind,
                sourceType: memory.sourceType,
                sourceRef: memory.sourceRef,
                tags: memory.tags,
                importance: memory.importance,
                confidence: memory.confidence,
                createdAt: memory.createdAt,
                lastAccessedAt: memory.lastAccessedAt,
                lastIndexedAt: now
            },
            createdAt: now
        });
        memoryNodeIds.add(nodeId);

        const memoryTimestamp = Number(memory.lastAccessedAt ?? memory.createdAt ?? now);
        const dayBucket = toDayBucket(memoryTimestamp);
        const dayNodeId = temporalNodeId(projectId, branch, dayBucket);

        upsertNode(nodes, {
            id: dayNodeId,
            type: "concept",
            label: `Day ${dayBucket}`,
            projectId,
            metadata: {
                indexer: "session-temporal",
                branch,
                kind: "time_bucket_day",
                day: dayBucket,
                lastIndexedAt: now
            },
            createdAt: now
        });
        temporalNodeIds.add(dayNodeId);

        const memoryDayEdgeId = edgeId(projectId, branch, nodeId, dayNodeId, "derived_from", `memory-day:${memoryTimestamp}`);
        upsertEdge(edges, {
            id: memoryDayEdgeId,
            fromNode: nodeId,
            toNode: dayNodeId,
            type: "derived_from",
            weight: 0.62,
            projectId,
            metadata: {
                indexer: "session-temporal",
                relation: "memory_time_bucket",
                timestamp: memoryTimestamp,
                branch,
                lastIndexedAt: now
            },
            createdAt: now
        });
        temporalEdgeIds.add(memoryDayEdgeId);

        const sessionRef = readChatSessionRef(memory);
        if (sessionRef) {
            const sessionId = sessionNodeId(projectId, branch, sessionRef);
            const sessionLabel = path.basename(sessionRef) || sessionRef;

            upsertNode(nodes, {
                id: sessionId,
                type: "session",
                label: `Session ${sessionLabel}`,
                projectId,
                metadata: {
                    indexer: "session-temporal",
                    branch,
                    kind: "chat_session",
                    sourceRef: sessionRef,
                    sessionLabel,
                    lastIndexedAt: now
                },
                createdAt: now
            });
            sessionNodeIds.add(sessionId);

            const memorySessionEdgeId = edgeId(projectId, branch, nodeId, sessionId, "derived_from", `memory-session:${logicalId}`);
            upsertEdge(edges, {
                id: memorySessionEdgeId,
                fromNode: nodeId,
                toNode: sessionId,
                type: "derived_from",
                weight: 0.88,
                projectId,
                metadata: {
                    indexer: "session-temporal",
                    relation: "memory_session",
                    sourceRef: sessionRef,
                    branch,
                    lastIndexedAt: now
                },
                createdAt: now
            });
            sessionEdgeIds.add(memorySessionEdgeId);

            const sessionDayEdgeId = edgeId(projectId, branch, sessionId, dayNodeId, "derived_from", `session-day:${dayBucket}`);
            upsertEdge(edges, {
                id: sessionDayEdgeId,
                fromNode: sessionId,
                toNode: dayNodeId,
                type: "derived_from",
                weight: 0.67,
                projectId,
                metadata: {
                    indexer: "session-temporal",
                    relation: "session_time_bucket",
                    day: dayBucket,
                    branch,
                    lastIndexedAt: now
                },
                createdAt: now
            });
            temporalEdgeIds.add(sessionDayEdgeId);
        }

        const fileRefs = readFileRefs(memory);
        if (memory.kind === "code_entity" && fileRefs.length > 0) {
            for (const fileRef of fileRefs) {
                const normalized = normalizeSlashes(fileRef);
                const bucket = codeMemoryByFileRef.get(normalized) ?? [];
                bucket.push(nodeId);
                codeMemoryByFileRef.set(normalized, bucket);
            }
        }
    }

    for (const memory of memories) {
        if (memory.kind !== "chat_turn") {
            continue;
        }

        const sourceNodeId = memoryNodeId(projectId, branch, toLogicalId(memory));
        const fileRefs = readFileRefs(memory);
        let localEdgeCount = 0;

        for (const fileRef of fileRefs) {
            const normalized = normalizeSlashes(fileRef);
            const targets = codeMemoryByFileRef.get(normalized) ?? [];

            for (const targetNodeId of targets) {
                if (targetNodeId === sourceNodeId) {
                    continue;
                }

                const edgeScope = `chat-code:${normalized}:${localEdgeCount}`;
                const chatCodeEdgeId = edgeId(projectId, branch, sourceNodeId, targetNodeId, "explains", edgeScope);
                upsertEdge(edges, {
                    id: chatCodeEdgeId,
                    fromNode: sourceNodeId,
                    toNode: targetNodeId,
                    type: "explains",
                    weight: 0.74,
                    projectId,
                    metadata: {
                        indexer: "session-temporal",
                        relation: "chat_to_code",
                        fileRef: normalized,
                        branch,
                        lastIndexedAt: now
                    },
                    createdAt: now
                });
                chatToCodeEdgeIds.add(chatCodeEdgeId);

                localEdgeCount += 1;
                if (localEdgeCount >= 12) {
                    break;
                }
            }

            if (localEdgeCount >= 12) {
                break;
            }
        }
    }

    for (const snapshot of snapshots) {
        const memoryId = memoryNodeId(projectId, branch, snapshot.logicalId);
        upsertNode(nodes, {
            id: memoryId,
            type: toGraphNodeType(snapshot.kind),
            label: snapshot.title || snapshot.logicalId,
            projectId,
            metadata: {
                indexer: "session-temporal",
                branch,
                logicalId: snapshot.logicalId,
                kind: snapshot.kind,
                sourceType: snapshot.sourceType,
                sourceRef: snapshot.sourceRef,
                tags: snapshot.tags,
                snapshotOnly: true,
                lastIndexedAt: now
            },
            createdAt: now
        });
        memoryNodeIds.add(memoryId);

        const dayBucket = toDayBucket(snapshot.validFrom);
        const dayNodeId = temporalNodeId(projectId, branch, dayBucket);

        upsertNode(nodes, {
            id: dayNodeId,
            type: "concept",
            label: `Day ${dayBucket}`,
            projectId,
            metadata: {
                indexer: "session-temporal",
                branch,
                kind: "time_bucket_day",
                day: dayBucket,
                lastIndexedAt: now
            },
            createdAt: now
        });
        temporalNodeIds.add(dayNodeId);

        const snapshotEdgeId = edgeId(
            projectId,
            branch,
            dayNodeId,
            memoryId,
            "derived_from",
            `snapshot:${snapshot.logicalId}:${snapshot.validFrom}:${snapshot.operation}`
        );
        upsertEdge(edges, {
            id: snapshotEdgeId,
            fromNode: dayNodeId,
            toNode: memoryId,
            type: "derived_from",
            weight: snapshot.operation === "delete" ? 0.45 : 0.7,
            projectId,
            metadata: {
                indexer: "session-temporal",
                relation: "snapshot_event",
                operation: snapshot.operation,
                validFrom: snapshot.validFrom,
                validUntil: snapshot.validUntil,
                sourceRef: snapshot.sourceRef,
                branch,
                lastIndexedAt: now
            },
            createdAt: now
        });
        temporalEdgeIds.add(snapshotEdgeId);

        const sessionRef = readChatSessionRef({
            sourceRef: snapshot.sourceRef,
            tags: snapshot.tags,
            sourceType: snapshot.sourceType,
            kind: snapshot.kind
        });

        if (sessionRef) {
            const sessionId = sessionNodeId(projectId, branch, sessionRef);
            const sessionLabel = path.basename(sessionRef) || sessionRef;

            upsertNode(nodes, {
                id: sessionId,
                type: "session",
                label: `Session ${sessionLabel}`,
                projectId,
                metadata: {
                    indexer: "session-temporal",
                    branch,
                    kind: "chat_session",
                    sourceRef: sessionRef,
                    sessionLabel,
                    lastIndexedAt: now
                },
                createdAt: now
            });
            sessionNodeIds.add(sessionId);

            const snapshotSessionEdgeId = edgeId(
                projectId,
                branch,
                sessionId,
                memoryId,
                "derived_from",
                `snapshot-session:${snapshot.logicalId}:${snapshot.validFrom}`
            );
            upsertEdge(edges, {
                id: snapshotSessionEdgeId,
                fromNode: sessionId,
                toNode: memoryId,
                type: "derived_from",
                weight: snapshot.operation === "delete" ? 0.42 : 0.79,
                projectId,
                metadata: {
                    indexer: "session-temporal",
                    relation: "session_snapshot",
                    operation: snapshot.operation,
                    sourceRef: sessionRef,
                    branch,
                    lastIndexedAt: now
                },
                createdAt: now
            });
            sessionEdgeIds.add(snapshotSessionEdgeId);
        }
    }

    const nodeRows = [...nodes.values()];
    const edgeRows = [...edges.values()];
    upsertGraphRows({
        db,
        nodes: nodeRows,
        edges: edgeRows
    });

    return {
        projectId,
        branch,
        sinceMs,
        scannedMemories: memories.length,
        scannedSnapshots: snapshots.length,
        nodesUpserted: nodeRows.length,
        edgesUpserted: edgeRows.length,
        memoryNodes: memoryNodeIds.size,
        sessionNodes: sessionNodeIds.size,
        temporalNodes: temporalNodeIds.size,
        sessionEdges: sessionEdgeIds.size,
        temporalEdges: temporalEdgeIds.size,
        chatToCodeEdges: chatToCodeEdgeIds.size
    };
}
