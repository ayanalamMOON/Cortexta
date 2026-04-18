import { connectSqlite, initializeSqlite } from "../../storage/sqlite/db";
import { embedText } from "../embeddings/embedder";
import {
    deleteVectorItems,
    ensureVectorCollection,
    searchVectorItems,
    upsertVectorItem
} from "../embeddings/vector.store";
import { hybridScore } from "../scoring/hybrid.score";
import {
    analyzeStoredContent,
    compactContentForStorage,
    getCompactionConfig,
    isCompactedContent,
    resurrectContentForCopilot,
    resurrectContentFromStorage
} from "./content.compaction";
import { createMemory, parseTags, stringifyTags } from "./memory.model";
import type {
    BackfillMemoryCompactionOptions,
    BackfillMemoryCompactionResult,
    CreateMemoryInput,
    MemoryCompactionDashboardOptions,
    MemoryCompactionDashboardPayload,
    MemoryCompactionIntegrityAnomalies,
    MemoryCompactionProjectBreakdownItem,
    MemoryCompactionStats,
    MemoryCompactionTrendSnapshot,
    MemoryRecord,
    MemorySearchOptions,
    ScoredMemory
} from "./memory.types";

const MEMORY_COLLECTION = "cortexa_memories";
const DEFAULT_VECTOR_DIMENSION = 256;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DASHBOARD_LOOKBACK_DAYS = 30;
const DEFAULT_DASHBOARD_MAX_TREND_POINTS = 120;
const DEFAULT_DASHBOARD_MAX_PROJECTS = 50;
const DEFAULT_DASHBOARD_PER_PROJECT_SNAPSHOT_LIMIT = 25;
const DEFAULT_DASHBOARD_SNAPSHOT_RETENTION_DAYS = 180;

const db = connectSqlite();
initializeSqlite(db);

let vectorReady = false;
let vectorUnavailableWarningPrinted = false;

interface CompactionAggregateRow {
    projectId: string;
    content: string;
    lastAccessedAt: number;
}

interface ProjectCompactionAccumulator {
    projectId: string;
    stats: MemoryCompactionStats;
    lastAccessedAt: number;
}

interface NormalizedDashboardOptions {
    projectId?: string;
    lookbackDays: number;
    maxTrendPoints: number;
    maxProjects: number;
    persistSnapshot: boolean;
    perProjectSnapshotLimit: number;
    snapshotRetentionDays: number;
}

function warnVectorUnavailableOnce(action: string, error: unknown): void {
    if (vectorUnavailableWarningPrinted) {
        return;
    }

    vectorUnavailableWarningPrinted = true;
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
        `[cortexa:mempalace] Vector backend unavailable during ${action}; continuing with SQLite-only memory operations.`,
        detail
    );
}

async function ensureVectorReady(): Promise<void> {
    if (vectorReady) {
        return;
    }

    await ensureVectorCollection(MEMORY_COLLECTION, DEFAULT_VECTOR_DIMENSION);
    vectorReady = true;
}

function toFiniteInteger(value: unknown): number | undefined {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
        return undefined;
    }

    return Math.trunc(parsed);
}

function normalizeProjectId(value: unknown): string {
    const normalized = String(value ?? "default").trim();
    return normalized || "default";
}

function normalizeOptionalProjectId(value: unknown): string | undefined {
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized || undefined;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalizeDashboardOptions(options: MemoryCompactionDashboardOptions = {}): NormalizedDashboardOptions {
    return {
        projectId: normalizeOptionalProjectId(options.projectId),
        lookbackDays: clampInteger(options.lookbackDays, DEFAULT_DASHBOARD_LOOKBACK_DAYS, 1, 3650),
        maxTrendPoints: clampInteger(options.maxTrendPoints, DEFAULT_DASHBOARD_MAX_TREND_POINTS, 1, 1000),
        maxProjects: clampInteger(options.maxProjects, DEFAULT_DASHBOARD_MAX_PROJECTS, 1, 500),
        persistSnapshot: options.persistSnapshot !== false,
        perProjectSnapshotLimit: clampInteger(
            options.perProjectSnapshotLimit,
            DEFAULT_DASHBOARD_PER_PROJECT_SNAPSHOT_LIMIT,
            0,
            500
        ),
        snapshotRetentionDays: clampInteger(
            options.snapshotRetentionDays,
            DEFAULT_DASHBOARD_SNAPSHOT_RETENTION_DAYS,
            7,
            3650
        )
    };
}

function createIntegrityAnomalies(): MemoryCompactionIntegrityAnomalies {
    return {
        invalidChecksum: 0,
        decodeError: 0,
        total: 0
    };
}

function createEmptyCompactionStats(projectId?: string): MemoryCompactionStats {
    return {
        projectId,
        totalRows: 0,
        compactedRows: 0,
        plainRows: 0,
        storedChars: 0,
        originalChars: 0,
        savedChars: 0,
        savedPercent: 0,
        compactionRate: 0,
        averageCompressionRatio: 1,
        integrityAnomalies: createIntegrityAnomalies()
    };
}

function finalizeCompactionStats(stats: MemoryCompactionStats): MemoryCompactionStats {
    const invalidChecksum = stats.integrityAnomalies.invalidChecksum;
    const decodeError = stats.integrityAnomalies.decodeError;
    const anomalyTotal = invalidChecksum + decodeError;

    const savedPercent = stats.originalChars > 0 ? (stats.savedChars / stats.originalChars) * 100 : 0;
    const compactionRate = stats.totalRows > 0 ? stats.compactedRows / stats.totalRows : 0;
    const averageCompressionRatio = stats.originalChars > 0 ? stats.storedChars / stats.originalChars : 1;

    return {
        ...stats,
        savedPercent,
        compactionRate,
        averageCompressionRatio,
        integrityAnomalies: {
            invalidChecksum,
            decodeError,
            total: anomalyTotal
        }
    };
}

function applyAnalysisToStats(stats: MemoryCompactionStats, content: string): void {
    const analysis = analyzeStoredContent(content);

    stats.totalRows += 1;
    stats.storedChars += analysis.storedChars;
    stats.originalChars += analysis.originalChars;
    stats.savedChars += analysis.savedChars;

    if (analysis.isCompacted) {
        stats.compactedRows += 1;
    } else {
        stats.plainRows += 1;
    }

    if (analysis.integrity === "invalid_checksum") {
        stats.integrityAnomalies.invalidChecksum += 1;
    }

    if (analysis.integrity === "decode_error") {
        stats.integrityAnomalies.decodeError += 1;
    }
}

function buildCompactionAggregateRows(projectId?: string): CompactionAggregateRow[] {
    const rows = projectId
        ? db
            .prepare(
                `
            SELECT projectId, content, lastAccessedAt
            FROM memories
            WHERE projectId = ?
          `
            )
            .all<Record<string, unknown>>(projectId)
        : db
            .prepare(
                `
            SELECT projectId, content, lastAccessedAt
            FROM memories
          `
            )
            .all<Record<string, unknown>>();

    return rows.map((row) => ({
        projectId: normalizeProjectId(row.projectId),
        content: String(row.content ?? ""),
        lastAccessedAt: toFiniteInteger(row.lastAccessedAt) ?? 0
    }));
}

function resolveProjectRisk(stats: MemoryCompactionStats): "healthy" | "warning" | "critical" {
    if (stats.integrityAnomalies.total > 0) {
        return "critical";
    }

    if (stats.totalRows >= 25 && stats.compactionRate < 0.5) {
        return "warning";
    }

    if (stats.totalRows >= 100 && stats.savedPercent < 5) {
        return "warning";
    }

    return "healthy";
}

function snapshotId(projectId: string | undefined, createdAt: number): string {
    const scope = (projectId ?? "global").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30) || "global";
    const random = Math.random().toString(36).slice(2, 10);
    return `cmp_snp_${scope}_${createdAt.toString(36)}_${random}`;
}

function toTrendSnapshot(row: Record<string, unknown>): MemoryCompactionTrendSnapshot {
    return {
        projectId: normalizeOptionalProjectId(row.projectId),
        createdAt: toFiniteInteger(row.createdAt) ?? 0,
        totalRows: toFiniteInteger(row.totalRows) ?? 0,
        compactedRows: toFiniteInteger(row.compactedRows) ?? 0,
        plainRows: toFiniteInteger(row.plainRows) ?? 0,
        storedChars: toFiniteInteger(row.storedChars) ?? 0,
        originalChars: toFiniteInteger(row.originalChars) ?? 0,
        savedChars: toFiniteInteger(row.savedChars) ?? 0,
        savedPercent: Number(row.savedPercent ?? 0),
        compactionRate: Number(row.compactionRate ?? 0),
        invalidChecksum: toFiniteInteger(row.invalidChecksum) ?? 0,
        decodeError: toFiniteInteger(row.decodeError) ?? 0,
        integrityAnomalyTotal: toFiniteInteger(row.integrityAnomalyTotal) ?? 0
    };
}

function insertTrendSnapshot(projectId: string | undefined, stats: MemoryCompactionStats, createdAt: number): void {
    db.prepare(
        `
        INSERT INTO memory_compaction_snapshots (
            id,
            projectId,
            totalRows,
            compactedRows,
            plainRows,
            storedChars,
            originalChars,
            savedChars,
            savedPercent,
            compactionRate,
            invalidChecksum,
            decodeError,
            integrityAnomalyTotal,
            createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
        snapshotId(projectId, createdAt),
        projectId ?? null,
        stats.totalRows,
        stats.compactedRows,
        stats.plainRows,
        stats.storedChars,
        stats.originalChars,
        stats.savedChars,
        stats.savedPercent,
        stats.compactionRate,
        stats.integrityAnomalies.invalidChecksum,
        stats.integrityAnomalies.decodeError,
        stats.integrityAnomalies.total,
        createdAt
    );
}

function listTrendSnapshots(
    projectId: string | undefined,
    cutoffMs: number,
    maxTrendPoints: number
): MemoryCompactionTrendSnapshot[] {
    const rows = projectId
        ? db
            .prepare(
                `
            SELECT *
            FROM memory_compaction_snapshots
            WHERE projectId = ?
              AND createdAt >= ?
            ORDER BY createdAt DESC
            LIMIT ?
          `
            )
            .all<Record<string, unknown>>(projectId, cutoffMs, maxTrendPoints)
        : db
            .prepare(
                `
            SELECT *
            FROM memory_compaction_snapshots
            WHERE projectId IS NULL
              AND createdAt >= ?
            ORDER BY createdAt DESC
            LIMIT ?
          `
            )
            .all<Record<string, unknown>>(cutoffMs, maxTrendPoints);

    return rows.reverse().map(toTrendSnapshot);
}

function cleanupSnapshotsOlderThan(cutoffMs: number): void {
    db.prepare(`DELETE FROM memory_compaction_snapshots WHERE createdAt < ?`).run(cutoffMs);
}

function buildProjectBreakdown(rows: CompactionAggregateRow[]): {
    globalStats: MemoryCompactionStats;
    perProject: MemoryCompactionProjectBreakdownItem[];
    byProjectId: Map<string, MemoryCompactionProjectBreakdownItem>;
} {
    const globalStats = createEmptyCompactionStats();
    const projectMap = new Map<string, ProjectCompactionAccumulator>();

    for (const row of rows) {
        applyAnalysisToStats(globalStats, row.content);

        let project = projectMap.get(row.projectId);
        if (!project) {
            project = {
                projectId: row.projectId,
                stats: createEmptyCompactionStats(row.projectId),
                lastAccessedAt: row.lastAccessedAt
            };
            projectMap.set(row.projectId, project);
        }

        project.lastAccessedAt = Math.max(project.lastAccessedAt, row.lastAccessedAt);
        applyAnalysisToStats(project.stats, row.content);
    }

    const finalizedGlobal = finalizeCompactionStats(globalStats);

    const perProject = [...projectMap.values()].map<MemoryCompactionProjectBreakdownItem>((project) => {
        const finalizedStats = finalizeCompactionStats(project.stats);
        return {
            projectId: project.projectId,
            stats: finalizedStats,
            lastAccessedAt: project.lastAccessedAt,
            riskLevel: resolveProjectRisk(finalizedStats)
        };
    });

    perProject.sort((a, b) => {
        const anomalyGap = b.stats.integrityAnomalies.total - a.stats.integrityAnomalies.total;
        if (anomalyGap !== 0) {
            return anomalyGap;
        }

        const savedGap = b.stats.savedChars - a.stats.savedChars;
        if (savedGap !== 0) {
            return savedGap;
        }

        const rowsGap = b.stats.totalRows - a.stats.totalRows;
        if (rowsGap !== 0) {
            return rowsGap;
        }

        return a.projectId.localeCompare(b.projectId);
    });

    return {
        globalStats: finalizedGlobal,
        perProject,
        byProjectId: new Map(perProject.map((item) => [item.projectId, item]))
    };
}

function persistDashboardSnapshots(
    generatedAt: number,
    globalStats: MemoryCompactionStats,
    perProject: MemoryCompactionProjectBreakdownItem[],
    options: NormalizedDashboardOptions
): void {
    insertTrendSnapshot(undefined, globalStats, generatedAt);

    if (options.perProjectSnapshotLimit > 0 && perProject.length > 0) {
        const candidates = [...perProject].sort((a, b) => {
            const rowGap = b.stats.totalRows - a.stats.totalRows;
            if (rowGap !== 0) {
                return rowGap;
            }

            return b.lastAccessedAt ?? 0 - (a.lastAccessedAt ?? 0);
        });

        const selected = new Set<string>();
        const chosen: MemoryCompactionProjectBreakdownItem[] = [];

        for (const candidate of candidates) {
            if (chosen.length >= options.perProjectSnapshotLimit) {
                break;
            }

            if (selected.has(candidate.projectId)) {
                continue;
            }

            selected.add(candidate.projectId);
            chosen.push(candidate);
        }

        if (options.projectId && !selected.has(options.projectId)) {
            const scoped = perProject.find((item) => item.projectId === options.projectId);
            if (scoped) {
                chosen.push(scoped);
            }
        }

        for (const item of chosen) {
            insertTrendSnapshot(item.projectId, item.stats, generatedAt);
        }
    }

    const retentionCutoff = generatedAt - options.snapshotRetentionDays * DAY_MS;
    cleanupSnapshotsOlderThan(retentionCutoff);
}

function getCopilotPreviewChars(): number {
    return getCompactionConfig().copilotPreviewChars;
}

function normalizeBackfillLimit(limit: number | undefined): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return 1000;
    }

    return Math.min(20_000, Math.max(1, Math.trunc(limit)));
}

function rowToMemory(row: Record<string, unknown>): MemoryRecord {
    const storedContent = String(row.content ?? "");
    const content = resurrectContentFromStorage(storedContent);
    const copilotContent = resurrectContentForCopilot(storedContent, getCopilotPreviewChars());

    return {
        id: String(row.id),
        projectId: String(row.projectId ?? "default"),
        kind: String(row.kind) as MemoryRecord["kind"],
        sourceType: String(row.sourceType ?? "manual") as MemoryRecord["sourceType"],
        title: String(row.title ?? ""),
        summary: String(row.summary ?? ""),
        content,
        tags: parseTags(row.tags),
        importance: Number(row.importance ?? 0.6),
        confidence: Number(row.confidence ?? 0.7),
        createdAt: Number(row.createdAt ?? Date.now()),
        lastAccessedAt: Number(row.lastAccessedAt ?? Date.now()),
        embeddingRef: row.embeddingRef ? String(row.embeddingRef) : undefined,
        sourceRef: row.sourceRef ? String(row.sourceRef) : undefined,
        copilotContent
    };
}

export async function upsertMemory(input: CreateMemoryInput): Promise<MemoryRecord> {
    const memory = createMemory(input);
    const restoredContent = memory.content;
    const storedContent = compactContentForStorage(restoredContent);
    const embedding = input.embedding ?? (await embedText(`${memory.title}\n${memory.summary}\n${restoredContent}`));

    db.prepare(
        `
        INSERT OR REPLACE INTO memories (
          id, projectId, kind, sourceType, title, summary, content, tags,
          importance, confidence, createdAt, lastAccessedAt, embeddingRef, sourceRef
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
        memory.id,
        memory.projectId,
        memory.kind,
        memory.sourceType,
        memory.title,
        memory.summary,
        storedContent,
        stringifyTags(memory.tags),
        memory.importance,
        memory.confidence,
        memory.createdAt,
        memory.lastAccessedAt,
        memory.embeddingRef ?? null,
        memory.sourceRef ?? null
    );

    if (embedding.length > 0) {
        try {
            await ensureVectorReady();
            await upsertVectorItem(MEMORY_COLLECTION, {
                id: memory.id,
                vector: embedding,
                payload: {
                    projectId: memory.projectId,
                    kind: memory.kind,
                    title: memory.title,
                    summary: memory.summary,
                    importance: memory.importance,
                    confidence: memory.confidence,
                    sourceRef: memory.sourceRef ?? null
                }
            });
        } catch (error) {
            vectorReady = false;
            warnVectorUnavailableOnce("upsert", error);
        }
    }

    return {
        ...memory,
        content: restoredContent,
        copilotContent: resurrectContentForCopilot(storedContent, getCopilotPreviewChars()),
        embedding
    };
}

export function getMemoryById(id: string): MemoryRecord | null {
    const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get<Record<string, unknown>>(id);
    return row ? rowToMemory(row) : null;
}

export function listMemories(projectId?: string, limit = 100): MemoryRecord[] {
    const rows = projectId
        ? db
            .prepare(`SELECT * FROM memories WHERE projectId = ? ORDER BY lastAccessedAt DESC LIMIT ?`)
            .all<Record<string, unknown>>(projectId, limit)
        : db.prepare(`SELECT * FROM memories ORDER BY lastAccessedAt DESC LIMIT ?`).all<Record<string, unknown>>(limit);

    return rows.map(rowToMemory);
}

export function getMemoryCompactionStats(projectId?: string): MemoryCompactionStats {
    const rows = buildCompactionAggregateRows(projectId);
    const stats = createEmptyCompactionStats(projectId);

    for (const row of rows) {
        applyAnalysisToStats(stats, row.content);
    }

    return finalizeCompactionStats(stats);
}

export function getMemoryCompactionDashboard(
    options: MemoryCompactionDashboardOptions = {}
): MemoryCompactionDashboardPayload {
    const normalized = normalizeDashboardOptions(options);
    const generatedAt = Date.now();

    const rows = buildCompactionAggregateRows();
    const aggregate = buildProjectBreakdown(rows);

    const scoped = normalized.projectId
        ? aggregate.byProjectId.get(normalized.projectId)
        : undefined;

    const current = scoped?.stats ?? (normalized.projectId ? createEmptyCompactionStats(normalized.projectId) : aggregate.globalStats);
    const perProject = aggregate.perProject.slice(0, normalized.maxProjects);

    if (normalized.persistSnapshot) {
        persistDashboardSnapshots(generatedAt, aggregate.globalStats, aggregate.perProject, normalized);
    }

    const lookbackCutoff = generatedAt - normalized.lookbackDays * DAY_MS;

    const globalTrend = listTrendSnapshots(undefined, lookbackCutoff, normalized.maxTrendPoints);
    const scopedProjectTrend = normalized.projectId
        ? listTrendSnapshots(normalized.projectId, lookbackCutoff, normalized.maxTrendPoints)
        : [];

    const projectsWithAnomalies = aggregate.perProject.filter((item) => item.stats.integrityAnomalies.total > 0).length;
    const projectsMostlyCompacted = aggregate.perProject.filter(
        (item) => item.stats.totalRows > 0 && item.stats.compactionRate >= 0.8
    ).length;

    return {
        generatedAt,
        lookbackDays: normalized.lookbackDays,
        scopedProjectId: normalized.projectId,
        current,
        trend: {
            global: globalTrend,
            scopedProject: scopedProjectTrend
        },
        perProject,
        integrityAnomalies: current.integrityAnomalies,
        totals: {
            projectCount: aggregate.perProject.length,
            projectsWithAnomalies,
            projectsMostlyCompacted
        }
    };
}

export function backfillMemoryCompaction(
    options: BackfillMemoryCompactionOptions = {}
): BackfillMemoryCompactionResult {
    const projectId = options.projectId;
    const dryRun = options.dryRun !== false;
    const limit = normalizeBackfillLimit(options.limit);

    const rows = projectId
        ? db
            .prepare(
                `
            SELECT id, content
            FROM memories
            WHERE projectId = ?
            ORDER BY lastAccessedAt DESC
            LIMIT ?
          `
            )
            .all<Record<string, unknown>>(projectId, limit)
        : db
            .prepare(
                `
            SELECT id, content
            FROM memories
            ORDER BY lastAccessedAt DESC
            LIMIT ?
          `
            )
            .all<Record<string, unknown>>(limit);

    let eligible = 0;
    let compacted = 0;
    let skipped = 0;
    let savedChars = 0;

    const update = dryRun ? null : db.prepare(`UPDATE memories SET content = ? WHERE id = ?`);

    for (const row of rows) {
        const id = String(row.id ?? "");
        const content = String(row.content ?? "");

        if (!id) {
            skipped += 1;
            continue;
        }

        if (isCompactedContent(content)) {
            skipped += 1;
            continue;
        }

        eligible += 1;
        const compactedContent = compactContentForStorage(content);
        if (compactedContent === content) {
            skipped += 1;
            continue;
        }

        compacted += 1;
        savedChars += Math.max(0, content.length - compactedContent.length);

        if (update) {
            update.run(compactedContent, id);
        }
    }

    return {
        projectId,
        dryRun,
        scanned: rows.length,
        eligible,
        compacted,
        skipped,
        savedChars
    };
}

export async function searchMemories(
    query: string,
    options: MemorySearchOptions = {}
): Promise<ScoredMemory[]> {
    const q = query.trim();
    if (!q) {
        return [];
    }

    const topK = options.topK ?? 10;
    const now = Date.now();
    const qLower = q.toLowerCase();
    const lexicalLike = `%${q}%`;

    const lexicalRows = options.projectId
        ? db
            .prepare(
                `
            SELECT * FROM memories
            WHERE projectId = ?
              AND (title LIKE ? OR summary LIKE ? OR content LIKE ?)
            ORDER BY lastAccessedAt DESC
            LIMIT ?
          `
            )
            .all<Record<string, unknown>>(options.projectId, lexicalLike, lexicalLike, lexicalLike, topK * 3)
        : db
            .prepare(
                `
            SELECT * FROM memories
            WHERE title LIKE ? OR summary LIKE ? OR content LIKE ?
            ORDER BY lastAccessedAt DESC
            LIMIT ?
          `
            )
            .all<Record<string, unknown>>(lexicalLike, lexicalLike, lexicalLike, topK * 3);

    const lexicalCandidates = new Map<string, MemoryRecord>();
    for (const row of lexicalRows) {
        const memory = rowToMemory(row);
        lexicalCandidates.set(memory.id, memory);
    }

    if (lexicalCandidates.size < topK * 3) {
        const fallbackLimit = Math.min(1500, Math.max(250, topK * 40));
        const fallbackRows = options.projectId
            ? db
                .prepare(
                    `
                SELECT * FROM memories
                WHERE projectId = ?
                ORDER BY lastAccessedAt DESC
                LIMIT ?
              `
                )
                .all<Record<string, unknown>>(options.projectId, fallbackLimit)
            : db
                .prepare(
                    `
                SELECT * FROM memories
                ORDER BY lastAccessedAt DESC
                LIMIT ?
              `
                )
                .all<Record<string, unknown>>(fallbackLimit);

        for (const row of fallbackRows) {
            if (lexicalCandidates.size >= topK * 3) {
                break;
            }

            const memory = rowToMemory(row);
            if (lexicalCandidates.has(memory.id)) {
                continue;
            }

            const text = `${memory.title}\n${memory.summary}\n${memory.content}`.toLowerCase();
            if (!text.includes(qLower)) {
                continue;
            }

            lexicalCandidates.set(memory.id, memory);
        }
    }

    const merged = new Map<string, ScoredMemory>();

    for (const memory of lexicalCandidates.values()) {
        const ageMs = Math.max(0, now - memory.lastAccessedAt);
        const inTitle = memory.title.toLowerCase().includes(qLower);
        const inSummary = memory.summary.toLowerCase().includes(qLower);
        const inContent = memory.content.toLowerCase().includes(qLower);
        const lexicalSimilarity = inTitle || inSummary ? 0.82 : inContent ? 0.72 : 0.6;
        const score = hybridScore(lexicalSimilarity, memory.importance, ageMs);
        const recency = Math.exp(-0.00000001 * ageMs);

        merged.set(memory.id, {
            ...memory,
            score,
            similarity: lexicalSimilarity,
            recency
        });
    }

    try {
        const queryEmbedding = await embedText(q);
        if (queryEmbedding.length > 0) {
            await ensureVectorReady();
            const vectorHits = await searchVectorItems(MEMORY_COLLECTION, queryEmbedding, topK * 3);

            for (const hit of vectorHits) {
                const existing = merged.get(hit.id);
                const row = existing
                    ? null
                    : db.prepare(`SELECT * FROM memories WHERE id = ?`).get<Record<string, unknown>>(hit.id);

                const memory = existing ?? (row ? rowToMemory(row) : null);
                if (!memory) continue;
                if (options.projectId && memory.projectId !== options.projectId) continue;

                const ageMs = Math.max(0, now - memory.lastAccessedAt);
                const score = hybridScore(hit.score, memory.importance, ageMs);
                const recency = Math.exp(-0.00000001 * ageMs);

                merged.set(memory.id, {
                    ...memory,
                    score: Math.max(existing?.score ?? 0, score),
                    similarity: Math.max(existing?.similarity ?? 0, hit.score),
                    recency
                });
            }
        }
    } catch {
        // Keep lexical-only results if vector layer is unavailable.
    }

    const minScore = options.minScore ?? 0;

    return [...merged.values()]
        .filter((memory) => memory.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
}

export async function deleteMemory(id: string): Promise<void> {
    db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    try {
        await deleteVectorItems(MEMORY_COLLECTION, [id]);
    } catch (error) {
        vectorReady = false;
        warnVectorUnavailableOnce("delete", error);
    }
}

export const memoryService = {
    upsert: upsertMemory,
    search: searchMemories,
    getById: getMemoryById,
    list: listMemories,
    compactionStats: getMemoryCompactionStats,
    compactionDashboard: getMemoryCompactionDashboard,
    backfillCompaction: backfillMemoryCompaction,
    delete: deleteMemory
};
