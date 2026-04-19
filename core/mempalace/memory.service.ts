import crypto from "node:crypto";
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
    CreateMemoryBranchInput,
    CreateMemoryInput,
    MemoryBranchRecord,
    MemoryCompactionDashboardOptions,
    MemoryCompactionDashboardPayload,
    MemoryCompactionIntegrityAnomalies,
    MemoryCompactionOpportunityItem,
    MemoryCompactionOpportunityOptions,
    MemoryCompactionOpportunityReport,
    MemoryCompactionProjectBreakdownItem,
    MemoryCompactionStats,
    MemoryCompactionTrendSnapshot,
    MemoryRecord,
    MemoryResurrectionAuditIssue,
    MemoryResurrectionAuditOptions,
    MemoryResurrectionAuditReport,
    MemorySearchOptions,
    MemoryTemporalDiffOptions,
    MemoryTemporalDiffResult,
    MergeMemoryBranchInput,
    MergeMemoryBranchResult,
    ScoredMemory
} from "./memory.types";
import { resolveProjectRisk } from "./risk";

const MEMORY_COLLECTION = "cortexa_memories";
const DEFAULT_VECTOR_DIMENSION = 256;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DASHBOARD_LOOKBACK_DAYS = 30;
const DEFAULT_DASHBOARD_MAX_TREND_POINTS = 120;
const DEFAULT_DASHBOARD_MAX_PROJECTS = 50;
const DEFAULT_DASHBOARD_PER_PROJECT_SNAPSHOT_LIMIT = 25;
const DEFAULT_DASHBOARD_SNAPSHOT_RETENTION_DAYS = 180;
const DEFAULT_OPPORTUNITY_LIMIT = 25;
const DEFAULT_OPPORTUNITY_SCAN_LIMIT = 2000;
const DEFAULT_OPPORTUNITY_MIN_CONTENT_CHARS = 220;
const DEFAULT_RESURRECTION_AUDIT_LIMIT = 5000;
const DEFAULT_RESURRECTION_AUDIT_MAX_ISSUES = 10;
const MAIN_BRANCH = "main";
const DEFAULT_TEMPORAL_DIFF_LIMIT = 200;
const VECTOR_RETRY_COOLDOWN_MS = 30_000;

const db = connectSqlite();
initializeSqlite(db);

let vectorReady = false;
let vectorUnavailableWarningPrinted = false;
let vectorRetryAfterMs = 0;

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

type SnapshotOperation = "upsert" | "delete";

interface BranchScopedOptions {
    projectId: string;
    branch: string;
}

interface BranchScopedReadOptions extends BranchScopedOptions {
    asOf?: number;
}

interface MemoryBranchMetadata {
    parentBranch?: string;
    forkedFromCommit?: string;
}

interface MemorySnapshotRow {
    id: string;
    logicalId: string;
    storageId?: string;
    projectId: string;
    branch: string;
    parentBranch?: string;
    forkedFromCommit?: string;
    operation: SnapshotOperation;
    kind: MemoryRecord["kind"];
    sourceType: MemoryRecord["sourceType"];
    title: string;
    summary: string;
    content: string;
    tags: string[];
    importance: number;
    confidence: number;
    lastAccessedAt: number;
    embeddingRef?: string;
    sourceRef?: string;
    validFrom: number;
    validUntil?: number;
    createdAt: number;
}

function normalizeBranchName(value: unknown): string {
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized || MAIN_BRANCH;
}

function normalizeOptionalBranch(value: unknown): string | undefined {
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized || undefined;
}

function createStableId(prefix: string, parts: Array<string | number | undefined>): string {
    const hash = crypto
        .createHash("sha1")
        .update(parts.map((part) => String(part ?? "")).join("|"))
        .digest("hex")
        .slice(0, 24);

    return `${prefix}_${hash}`;
}

function branchRowId(projectId: string, branch: string): string {
    return createStableId("mem_branch", [projectId, branch]);
}

function branchMemoryStorageId(projectId: string, branch: string, logicalId: string): string {
    return createStableId("mem_branch_row", [projectId, branch, logicalId]);
}

function branchTombstoneId(projectId: string, branch: string, logicalId: string): string {
    return createStableId("mem_tomb", [projectId, branch, logicalId]);
}

function memorySnapshotId(projectId: string, branch: string, logicalId: string, validFrom: number, operation: SnapshotOperation): string {
    return createStableId("mem_snp", [projectId, branch, logicalId, validFrom, operation]);
}

function logicalIdFromRow(row: Record<string, unknown>): string {
    const logicalId = typeof row.logicalId === "string" ? row.logicalId.trim() : "";
    if (logicalId) {
        return logicalId;
    }

    const id = String(row.id ?? "").trim();
    return id || createStableId("mem_missing", [Date.now(), Math.random()]);
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

function isVectorRetryOnCooldown(now = Date.now()): boolean {
    return now < vectorRetryAfterMs;
}

function markVectorUnavailable(action: string, error: unknown): void {
    vectorReady = false;
    vectorRetryAfterMs = Date.now() + VECTOR_RETRY_COOLDOWN_MS;
    warnVectorUnavailableOnce(action, error);
}

function markVectorHealthy(): void {
    vectorRetryAfterMs = 0;
    vectorUnavailableWarningPrinted = false;
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

function normalizeResurrectionAuditLimit(limit: number | undefined): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_RESURRECTION_AUDIT_LIMIT;
    }

    return Math.min(50_000, Math.max(1, Math.trunc(limit)));
}

function normalizeResurrectionAuditMaxIssues(maxIssues: number | undefined): number {
    if (typeof maxIssues !== "number" || !Number.isFinite(maxIssues)) {
        return DEFAULT_RESURRECTION_AUDIT_MAX_ISSUES;
    }

    return Math.min(100, Math.max(0, Math.trunc(maxIssues)));
}

function normalizeOpportunityLimit(limit: number | undefined): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_OPPORTUNITY_LIMIT;
    }

    return Math.min(500, Math.max(1, Math.trunc(limit)));
}

function normalizeOpportunityScanLimit(scanLimit: number | undefined, itemLimit: number): number {
    if (typeof scanLimit !== "number" || !Number.isFinite(scanLimit)) {
        return Math.min(50_000, Math.max(DEFAULT_OPPORTUNITY_SCAN_LIMIT, itemLimit * 20));
    }

    return Math.min(50_000, Math.max(itemLimit, Math.trunc(scanLimit)));
}

function normalizeOpportunityMinContentChars(minContentChars: number | undefined): number {
    if (typeof minContentChars !== "number" || !Number.isFinite(minContentChars)) {
        return DEFAULT_OPPORTUNITY_MIN_CONTENT_CHARS;
    }

    return Math.min(20_000, Math.max(64, Math.trunc(minContentChars)));
}

function buildResurrectionAuditRecommendations(report: {
    scannedRows: number;
    anomalies: MemoryCompactionIntegrityAnomalies;
    compactionOpportunityRate: number;
}): string[] {
    if (report.scannedRows === 0) {
        return ["No memory rows were scanned. Ingest data first, then re-run memory audit."];
    }

    const recommendations: string[] = [];

    if (report.anomalies.total > 0) {
        recommendations.push(
            "Integrity anomalies detected. Inspect issue samples and re-ingest affected sources to restore full resurrection fidelity."
        );
    }

    if (report.compactionOpportunityRate >= 0.2) {
        recommendations.push(
            "A notable share of rows are still plain. Consider `memory backfill --apply` during a maintenance window."
        );
    }

    if (recommendations.length === 0) {
        recommendations.push("Resurrection integrity checks look healthy. Keep periodic audits enabled.");
    }

    return recommendations;
}

function normalizeBranchScopedReadOptions(projectId?: string, branch?: string, asOf?: number): BranchScopedReadOptions | null {
    const normalizedProjectId = normalizeOptionalProjectId(projectId);
    if (!normalizedProjectId) {
        return null;
    }

    return {
        projectId: normalizedProjectId,
        branch: normalizeBranchName(branch),
        asOf: typeof asOf === "number" && Number.isFinite(asOf) ? Math.trunc(asOf) : undefined
    };
}

function toBranchRecord(row: Record<string, unknown>): MemoryBranchRecord {
    return {
        id: String(row.id ?? ""),
        projectId: normalizeProjectId(row.projectId),
        branch: normalizeBranchName(row.branch),
        parentBranch: normalizeOptionalBranch(row.parentBranch),
        forkedFromCommit: row.forkedFromCommit ? String(row.forkedFromCommit) : undefined,
        createdAt: toFiniteInteger(row.createdAt) ?? Date.now(),
        updatedAt: toFiniteInteger(row.updatedAt) ?? Date.now()
    };
}

function ensureMainBranch(projectId: string): MemoryBranchRecord {
    const now = Date.now();
    const id = branchRowId(projectId, MAIN_BRANCH);

    db.prepare(
        `
        INSERT OR IGNORE INTO memory_branches (
            id, projectId, branch, parentBranch, forkedFromCommit, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    ).run(id, projectId, MAIN_BRANCH, null, null, now, now);

    db.prepare(
        `
        UPDATE memory_branches
        SET updatedAt = ?
        WHERE projectId = ?
          AND branch = ?
      `
    ).run(now, projectId, MAIN_BRANCH);

    const row = db
        .prepare(
            `
            SELECT *
            FROM memory_branches
            WHERE projectId = ?
              AND branch = ?
          `
        )
        .get<Record<string, unknown>>(projectId, MAIN_BRANCH);

    return row ? toBranchRecord(row) : {
        id,
        projectId,
        branch: MAIN_BRANCH,
        createdAt: now,
        updatedAt: now
    };
}

function readBranchMetadata(projectId: string, branch: string): MemoryBranchMetadata {
    const row = db
        .prepare(
            `
            SELECT parentBranch, forkedFromCommit
            FROM memory_branches
            WHERE projectId = ?
              AND branch = ?
          `
        )
        .get<Record<string, unknown>>(projectId, branch);

    return {
        parentBranch: normalizeOptionalBranch(row?.parentBranch),
        forkedFromCommit: row?.forkedFromCommit ? String(row.forkedFromCommit) : undefined
    };
}

function ensureMemoryBranch(projectId: string, branchInput: string, fromBranchInput?: string, forkedFromCommit?: string): MemoryBranchRecord {
    ensureMainBranch(projectId);

    const branch = normalizeBranchName(branchInput);
    const now = Date.now();

    if (branch === MAIN_BRANCH) {
        return ensureMainBranch(projectId);
    }

    const fromBranch = normalizeBranchName(fromBranchInput ?? MAIN_BRANCH);
    const id = branchRowId(projectId, branch);

    db.prepare(
        `
        INSERT OR IGNORE INTO memory_branches (
            id, projectId, branch, parentBranch, forkedFromCommit, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    ).run(id, projectId, branch, fromBranch, forkedFromCommit ?? null, now, now);

    db.prepare(
        `
        UPDATE memory_branches
        SET
            parentBranch = COALESCE(parentBranch, ?),
            forkedFromCommit = COALESCE(forkedFromCommit, ?),
            updatedAt = ?
        WHERE projectId = ?
          AND branch = ?
      `
    ).run(fromBranch, forkedFromCommit ?? null, now, projectId, branch);

    const row = db
        .prepare(
            `
            SELECT *
            FROM memory_branches
            WHERE projectId = ?
              AND branch = ?
          `
        )
        .get<Record<string, unknown>>(projectId, branch);

    if (!row) {
        return {
            id,
            projectId,
            branch,
            parentBranch: fromBranch,
            forkedFromCommit,
            createdAt: now,
            updatedAt: now
        };
    }

    return toBranchRecord(row);
}

function getBranchLineage(projectId: string, branchInput: string): string[] {
    ensureMainBranch(projectId);

    const lineage: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = normalizeBranchName(branchInput);

    while (current && !seen.has(current) && lineage.length < 32) {
        lineage.push(current);
        seen.add(current);

        if (current === MAIN_BRANCH) {
            break;
        }

        const row: Record<string, unknown> | undefined = db
            .prepare(
                `
                SELECT parentBranch
                FROM memory_branches
                WHERE projectId = ?
                  AND branch = ?
              `
            )
            .get(projectId, current);

        current = normalizeOptionalBranch(row?.parentBranch) ?? MAIN_BRANCH;
    }

    if (!seen.has(MAIN_BRANCH)) {
        lineage.push(MAIN_BRANCH);
    }

    return lineage;
}

function listBranchTombstones(projectId: string, lineage: string[]): Set<string> {
    if (lineage.length === 0) {
        return new Set<string>();
    }

    const placeholders = lineage.map(() => "?").join(",");
    const rows = db
        .prepare(
            `
            SELECT logicalId
            FROM memory_branch_tombstones
            WHERE projectId = ?
              AND branch IN (${placeholders})
          `
        )
        .all<Record<string, unknown>>(projectId, ...lineage);

    return new Set(rows.map((row) => String(row.logicalId ?? "")).filter(Boolean));
}

function removeBranchTombstone(projectId: string, branch: string, logicalId: string): void {
    db.prepare(
        `
        DELETE FROM memory_branch_tombstones
        WHERE projectId = ?
          AND branch = ?
          AND logicalId = ?
      `
    ).run(projectId, branch, logicalId);
}

function upsertBranchTombstone(projectId: string, branch: string, logicalId: string, createdAt: number): void {
    db.prepare(
        `
        INSERT OR REPLACE INTO memory_branch_tombstones (
            id,
            logicalId,
            projectId,
            branch,
            createdAt
        ) VALUES (?, ?, ?, ?, ?)
      `
    ).run(branchTombstoneId(projectId, branch, logicalId), logicalId, projectId, branch, createdAt);
}

function selectCurrentRowsForBranchScope(params: {
    projectId: string;
    branch: string;
    lexicalLike?: string;
    logicalId?: string;
    limit: number;
}): Record<string, unknown>[] {
    const { projectId, branch, lexicalLike, logicalId, limit } = params;

    if (branch === MAIN_BRANCH) {
        const clauses = ["projectId = ?"];
        const args: unknown[] = [projectId];

        if (logicalId) {
            clauses.push("id = ?");
            args.push(logicalId);
        }

        if (lexicalLike) {
            clauses.push("(title LIKE ? OR summary LIKE ? OR content LIKE ?)");
            args.push(lexicalLike, lexicalLike, lexicalLike);
        }

        args.push(limit);

        const rows = db
            .prepare(
                `
                SELECT *
                FROM memories
                WHERE ${clauses.join(" AND ")}
                ORDER BY lastAccessedAt DESC
                LIMIT ?
              `
            )
            .all<Record<string, unknown>>(...args);

        return rows.map((row) => ({
            ...row,
            logicalId: row.id,
            branch: MAIN_BRANCH
        }));
    }

    const clauses = ["projectId = ?", "branch = ?"];
    const args: unknown[] = [projectId, branch];

    if (logicalId) {
        clauses.push("logicalId = ?");
        args.push(logicalId);
    }

    if (lexicalLike) {
        clauses.push("(title LIKE ? OR summary LIKE ? OR content LIKE ?)");
        args.push(lexicalLike, lexicalLike, lexicalLike);
    }

    args.push(limit);

    return db
        .prepare(
            `
            SELECT *
            FROM memory_branch_memories
            WHERE ${clauses.join(" AND ")}
            ORDER BY lastAccessedAt DESC
            LIMIT ?
          `
        )
        .all<Record<string, unknown>>(...args);
}

function loadCurrentBranchViewRows(params: {
    projectId: string;
    branch: string;
    lexicalLike?: string;
    logicalId?: string;
    limit: number;
}): Record<string, unknown>[] {
    const lineage = getBranchLineage(params.projectId, params.branch);
    const tombstones = listBranchTombstones(params.projectId, lineage);
    const merged = new Map<string, Record<string, unknown>>();
    const perBranchLimit = Math.max(64, params.limit * 6);

    for (const branch of lineage) {
        const rows = selectCurrentRowsForBranchScope({
            projectId: params.projectId,
            branch,
            lexicalLike: params.lexicalLike,
            logicalId: params.logicalId,
            limit: perBranchLimit
        });

        for (const row of rows) {
            const logicalId = logicalIdFromRow(row);
            if (!logicalId || tombstones.has(logicalId) || merged.has(logicalId)) {
                continue;
            }

            merged.set(logicalId, {
                ...row,
                branch,
                logicalId
            });
        }

        if (params.logicalId && merged.has(params.logicalId)) {
            break;
        }
    }

    return [...merged.values()]
        .sort((a, b) => (toFiniteInteger(b.lastAccessedAt) ?? 0) - (toFiniteInteger(a.lastAccessedAt) ?? 0))
        .slice(0, params.limit);
}

function closeOpenSnapshot(projectId: string, branch: string, logicalId: string, closedAt: number): void {
    db.prepare(
        `
        UPDATE memory_snapshots
        SET validUntil = ?
        WHERE projectId = ?
          AND branch = ?
          AND logicalId = ?
          AND validUntil IS NULL
      `
    ).run(closedAt, projectId, branch, logicalId);
}

function insertMemorySnapshot(row: MemorySnapshotRow): void {
    db.prepare(
        `
        INSERT OR REPLACE INTO memory_snapshots (
            id,
            logicalId,
            storageId,
            projectId,
            branch,
            parentBranch,
            forkedFromCommit,
            operation,
            kind,
            sourceType,
            title,
            summary,
            content,
            tags,
            importance,
            confidence,
            lastAccessedAt,
            embeddingRef,
            sourceRef,
            validFrom,
            validUntil,
            createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
        row.id,
        row.logicalId,
        row.storageId ?? null,
        row.projectId,
        row.branch,
        row.parentBranch ?? null,
        row.forkedFromCommit ?? null,
        row.operation,
        row.kind,
        row.sourceType,
        row.title,
        row.summary,
        row.content,
        stringifyTags(row.tags),
        row.importance,
        row.confidence,
        row.lastAccessedAt,
        row.embeddingRef ?? null,
        row.sourceRef ?? null,
        row.validFrom,
        row.validUntil ?? null,
        row.createdAt
    );
}

function writeUpsertSnapshot(params: {
    memory: MemoryRecord;
    storageId: string;
    projectId: string;
    branch: string;
    validFrom: number;
    metadata?: MemoryBranchMetadata;
}): void {
    const logicalId = params.memory.logicalId ?? params.memory.id;
    closeOpenSnapshot(params.projectId, params.branch, logicalId, params.validFrom);

    insertMemorySnapshot({
        id: memorySnapshotId(params.projectId, params.branch, logicalId, params.validFrom, "upsert"),
        logicalId,
        storageId: params.storageId,
        projectId: params.projectId,
        branch: params.branch,
        parentBranch: params.metadata?.parentBranch,
        forkedFromCommit: params.metadata?.forkedFromCommit,
        operation: "upsert",
        kind: params.memory.kind,
        sourceType: params.memory.sourceType,
        title: params.memory.title,
        summary: params.memory.summary,
        content: params.memory.content,
        tags: params.memory.tags,
        importance: params.memory.importance,
        confidence: params.memory.confidence,
        lastAccessedAt: params.memory.lastAccessedAt,
        embeddingRef: params.memory.embeddingRef,
        sourceRef: params.memory.sourceRef,
        validFrom: params.validFrom,
        createdAt: params.validFrom
    });
}

function writeDeleteSnapshot(params: {
    projectId: string;
    branch: string;
    logicalId: string;
    deletedAt: number;
    metadata?: MemoryBranchMetadata;
    prior?: MemoryRecord | null;
}): void {
    closeOpenSnapshot(params.projectId, params.branch, params.logicalId, params.deletedAt);

    const prior = params.prior;
    insertMemorySnapshot({
        id: memorySnapshotId(params.projectId, params.branch, params.logicalId, params.deletedAt, "delete"),
        logicalId: params.logicalId,
        storageId: prior?.id,
        projectId: params.projectId,
        branch: params.branch,
        parentBranch: params.metadata?.parentBranch,
        forkedFromCommit: params.metadata?.forkedFromCommit,
        operation: "delete",
        kind: prior?.kind ?? "semantic",
        sourceType: prior?.sourceType ?? "manual",
        title: prior?.title ?? `Deleted memory ${params.logicalId}`,
        summary: prior?.summary ?? "Deleted in branch scope",
        content: prior?.content ?? "",
        tags: prior?.tags ?? [],
        importance: prior?.importance ?? 0.5,
        confidence: prior?.confidence ?? 0.5,
        lastAccessedAt: prior?.lastAccessedAt ?? params.deletedAt,
        embeddingRef: prior?.embeddingRef,
        sourceRef: prior?.sourceRef,
        validFrom: params.deletedAt,
        createdAt: params.deletedAt
    });
}

function rowToSnapshot(row: Record<string, unknown>): MemorySnapshotRow {
    return {
        id: String(row.id ?? ""),
        logicalId: String(row.logicalId ?? row.id ?? ""),
        storageId: row.storageId ? String(row.storageId) : undefined,
        projectId: normalizeProjectId(row.projectId),
        branch: normalizeBranchName(row.branch),
        parentBranch: normalizeOptionalBranch(row.parentBranch),
        forkedFromCommit: row.forkedFromCommit ? String(row.forkedFromCommit) : undefined,
        operation: (String(row.operation ?? "upsert") === "delete" ? "delete" : "upsert"),
        kind: String(row.kind ?? "semantic") as MemoryRecord["kind"],
        sourceType: String(row.sourceType ?? "manual") as MemoryRecord["sourceType"],
        title: String(row.title ?? ""),
        summary: String(row.summary ?? ""),
        content: String(row.content ?? ""),
        tags: parseTags(row.tags),
        importance: Number(row.importance ?? 0.6),
        confidence: Number(row.confidence ?? 0.75),
        lastAccessedAt: Number(row.lastAccessedAt ?? row.createdAt ?? Date.now()),
        embeddingRef: row.embeddingRef ? String(row.embeddingRef) : undefined,
        sourceRef: row.sourceRef ? String(row.sourceRef) : undefined,
        validFrom: Number(row.validFrom ?? 0),
        validUntil: row.validUntil === null || row.validUntil === undefined ? undefined : Number(row.validUntil),
        createdAt: Number(row.createdAt ?? Date.now())
    };
}

function snapshotToMemory(snapshot: MemorySnapshotRow): MemoryRecord {
    return {
        id: snapshot.storageId ?? snapshot.logicalId,
        logicalId: snapshot.logicalId,
        projectId: snapshot.projectId,
        branch: snapshot.branch,
        parentBranch: snapshot.parentBranch,
        forkedFromCommit: snapshot.forkedFromCommit,
        kind: snapshot.kind,
        sourceType: snapshot.sourceType,
        title: snapshot.title,
        summary: snapshot.summary,
        content: snapshot.content,
        tags: [...snapshot.tags],
        importance: snapshot.importance,
        confidence: snapshot.confidence,
        createdAt: snapshot.createdAt,
        lastAccessedAt: snapshot.lastAccessedAt,
        embeddingRef: snapshot.embeddingRef,
        sourceRef: snapshot.sourceRef,
        copilotContent: resurrectContentForCopilot(snapshot.content, getCopilotPreviewChars())
    };
}

function ensureTemporalSnapshotBaseline(projectId: string, branch: string): void {
    const metadata = readBranchMetadata(projectId, branch);

    if (branch === MAIN_BRANCH) {
        const rows = db
            .prepare(
                `
                SELECT m.*
                FROM memories m
                LEFT JOIN memory_snapshots s
                  ON s.projectId = m.projectId
                 AND s.branch = ?
                 AND s.logicalId = m.id
                 AND s.operation = 'upsert'
                 AND s.validUntil IS NULL
                WHERE m.projectId = ?
                  AND s.id IS NULL
              `
            )
            .all<Record<string, unknown>>(MAIN_BRANCH, projectId);

        for (const row of rows) {
            const memory = rowToMemory({ ...row, branch: MAIN_BRANCH, logicalId: row.id });
            const validFrom = Math.max(0, memory.createdAt || Date.now());
            writeUpsertSnapshot({
                memory,
                storageId: memory.id,
                projectId,
                branch: MAIN_BRANCH,
                validFrom,
                metadata
            });
        }

        return;
    }

    const rows = db
        .prepare(
            `
            SELECT b.*
            FROM memory_branch_memories b
            LEFT JOIN memory_snapshots s
              ON s.projectId = b.projectId
             AND s.branch = b.branch
             AND s.logicalId = b.logicalId
             AND s.operation = 'upsert'
             AND s.validUntil IS NULL
            WHERE b.projectId = ?
              AND b.branch = ?
              AND s.id IS NULL
          `
        )
        .all<Record<string, unknown>>(projectId, branch);

    for (const row of rows) {
        const memory = rowToMemory(row);
        const validFrom = Math.max(0, memory.createdAt || Date.now());
        writeUpsertSnapshot({
            memory,
            storageId: memory.id,
            projectId,
            branch,
            validFrom,
            metadata
        });
    }
}

function loadTemporalBranchState(projectId: string, branch: string, asOf: number): Map<string, MemorySnapshotRow> {
    const lineage = getBranchLineage(projectId, branch);
    for (const scopeBranch of lineage) {
        ensureTemporalSnapshotBaseline(projectId, scopeBranch);
    }

    const state = new Map<string, MemorySnapshotRow>();

    for (const scopeBranch of lineage) {
        const rows = db
            .prepare(
                `
                SELECT *
                FROM memory_snapshots
                WHERE projectId = ?
                  AND branch = ?
                  AND validFrom <= ?
                  AND (validUntil IS NULL OR validUntil > ?)
                ORDER BY validFrom DESC
              `
            )
            .all<Record<string, unknown>>(projectId, scopeBranch, asOf, asOf)
            .map(rowToSnapshot);

        for (const row of rows) {
            if (state.has(row.logicalId)) {
                continue;
            }

            state.set(row.logicalId, row);
        }
    }

    return state;
}

function scoreFromLexical(records: MemoryRecord[], query: string, topK: number, minScore: number): ScoredMemory[] {
    const qLower = query.toLowerCase();
    const now = Date.now();

    const scored = records
        .map<ScoredMemory>((memory) => {
            const inTitle = memory.title.toLowerCase().includes(qLower);
            const inSummary = memory.summary.toLowerCase().includes(qLower);
            const inContent = memory.content.toLowerCase().includes(qLower);
            const similarity = inTitle || inSummary ? 0.82 : inContent ? 0.72 : 0.6;
            const ageMs = Math.max(0, now - memory.lastAccessedAt);
            const recency = Math.exp(-0.00000001 * ageMs);
            const score = hybridScore(similarity, memory.importance, ageMs);

            return {
                ...memory,
                score,
                similarity,
                recency
            };
        })
        .filter((row) => row.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

    return scored;
}

function normalizeTemporalDiffLimit(limit: number | undefined): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_TEMPORAL_DIFF_LIMIT;
    }

    return Math.min(2000, Math.max(1, Math.trunc(limit)));
}

function rowToMemory(row: Record<string, unknown>): MemoryRecord {
    const storedContent = String(row.content ?? "");
    const content = resurrectContentFromStorage(storedContent);
    const copilotContent = resurrectContentForCopilot(storedContent, getCopilotPreviewChars());
    const logicalId = logicalIdFromRow(row);
    const branch = normalizeBranchName(row.branch);

    return {
        id: String(row.id),
        logicalId,
        projectId: String(row.projectId ?? "default"),
        branch,
        parentBranch: normalizeOptionalBranch(row.parentBranch),
        forkedFromCommit: row.forkedFromCommit ? String(row.forkedFromCommit) : undefined,
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

function chunkIds(ids: string[], chunkSize: number): string[][] {
    if (ids.length === 0) {
        return [];
    }

    const chunks: string[][] = [];
    for (let index = 0; index < ids.length; index += chunkSize) {
        chunks.push(ids.slice(index, index + chunkSize));
    }

    return chunks;
}

export async function upsertMemory(input: CreateMemoryInput): Promise<MemoryRecord> {
    const base = createMemory(input);
    const projectId = normalizeProjectId(base.projectId);
    const branch = normalizeBranchName(input.branch ?? base.branch);
    const logicalId = (input.logicalId ?? input.id ?? base.logicalId ?? base.id).trim();
    const branchRecord = ensureMemoryBranch(projectId, branch, input.parentBranch, input.forkedFromCommit);

    const storageId = branch === MAIN_BRANCH ? logicalId : branchMemoryStorageId(projectId, branch, logicalId);
    const memory: MemoryRecord = {
        ...base,
        id: storageId,
        logicalId,
        projectId,
        branch,
        parentBranch: branchRecord.parentBranch,
        forkedFromCommit: branchRecord.forkedFromCommit
    };

    const restoredContent = memory.content;
    const storedContent = compactContentForStorage(restoredContent);
    const embedding = input.embedding ?? (await embedText(`${memory.title}\n${memory.summary}\n${restoredContent}`));

    if (branch === MAIN_BRANCH) {
        db.prepare(
            `
            INSERT OR REPLACE INTO memories (
              id, projectId, kind, sourceType, title, summary, content, tags,
              importance, confidence, createdAt, lastAccessedAt, embeddingRef, sourceRef
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        ).run(
            storageId,
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
    } else {
        db.prepare(
            `
            INSERT OR REPLACE INTO memory_branch_memories (
              id,
              logicalId,
              projectId,
              branch,
              kind,
              sourceType,
              title,
              summary,
              content,
              tags,
              importance,
              confidence,
              createdAt,
              lastAccessedAt,
              embeddingRef,
              sourceRef
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        ).run(
            storageId,
            logicalId,
            memory.projectId,
            branch,
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
    }

    removeBranchTombstone(projectId, branch, logicalId);
    const snapshotValidFrom = Math.max(0, memory.lastAccessedAt || memory.createdAt || Date.now());
    writeUpsertSnapshot({
        memory,
        storageId,
        projectId,
        branch,
        validFrom: snapshotValidFrom,
        metadata: {
            parentBranch: branchRecord.parentBranch,
            forkedFromCommit: branchRecord.forkedFromCommit
        }
    });

    if (embedding.length > 0 && !isVectorRetryOnCooldown()) {
        try {
            await ensureVectorReady();
            await upsertVectorItem(MEMORY_COLLECTION, {
                id: storageId,
                vector: embedding,
                payload: {
                    projectId: memory.projectId,
                    branch,
                    logicalId,
                    kind: memory.kind,
                    title: memory.title,
                    summary: memory.summary,
                    importance: memory.importance,
                    confidence: memory.confidence,
                    sourceRef: memory.sourceRef ?? null
                }
            });
            markVectorHealthy();
        } catch (error) {
            markVectorUnavailable("upsert", error);
        }
    }

    return {
        ...memory,
        content: restoredContent,
        copilotContent: resurrectContentForCopilot(storedContent, getCopilotPreviewChars()),
        embedding
    };
}

export function getMemoryById(
    id: string,
    options: {
        projectId?: string;
        branch?: string;
        asOf?: number;
    } = {}
): MemoryRecord | null {
    const normalizedId = String(id ?? "").trim();
    if (!normalizedId) {
        return null;
    }

    const scoped = normalizeBranchScopedReadOptions(options.projectId, options.branch, options.asOf);
    if (!scoped) {
        const mainRow = db.prepare(`SELECT * FROM memories WHERE id = ?`).get<Record<string, unknown>>(normalizedId);
        if (mainRow) {
            return rowToMemory({
                ...mainRow,
                branch: MAIN_BRANCH,
                logicalId: mainRow.id
            });
        }

        const branchRow = db
            .prepare(`SELECT * FROM memory_branch_memories WHERE id = ?`)
            .get<Record<string, unknown>>(normalizedId);

        return branchRow ? rowToMemory(branchRow) : null;
    }

    if (typeof scoped.asOf === "number") {
        const state = loadTemporalBranchState(scoped.projectId, scoped.branch, scoped.asOf);
        for (const snapshot of state.values()) {
            if (snapshot.logicalId !== normalizedId && (snapshot.storageId ?? "") !== normalizedId) {
                continue;
            }

            return snapshot.operation === "delete" ? null : snapshotToMemory(snapshot);
        }

        return null;
    }

    const rows = loadCurrentBranchViewRows({
        projectId: scoped.projectId,
        branch: scoped.branch,
        limit: 5000
    });

    const row = rows.find((candidate) => {
        const storageId = String(candidate.id ?? "");
        const logicalId = logicalIdFromRow(candidate);
        return storageId === normalizedId || logicalId === normalizedId;
    });

    return row ? rowToMemory(row) : null;
}

export function listMemories(
    projectId?: string,
    limit = 100,
    options: {
        branch?: string;
        asOf?: number;
    } = {}
): MemoryRecord[] {
    const boundedLimit = clampInteger(limit, 100, 1, 5000);
    const scoped = normalizeBranchScopedReadOptions(projectId, options.branch, options.asOf);

    if (!scoped) {
        const rows = projectId
            ? db
                .prepare(`SELECT * FROM memories WHERE projectId = ? ORDER BY lastAccessedAt DESC LIMIT ?`)
                .all<Record<string, unknown>>(projectId, boundedLimit)
                .map((row) => ({
                    ...row,
                    branch: MAIN_BRANCH,
                    logicalId: row.id
                }))
            : db
                .prepare(`SELECT * FROM memories ORDER BY lastAccessedAt DESC LIMIT ?`)
                .all<Record<string, unknown>>(boundedLimit)
                .map((row) => ({
                    ...row,
                    branch: MAIN_BRANCH,
                    logicalId: row.id
                }));

        return rows.map(rowToMemory);
    }

    if (typeof scoped.asOf === "number") {
        const state = loadTemporalBranchState(scoped.projectId, scoped.branch, scoped.asOf);
        const rows = [...state.values()]
            .filter((snapshot) => snapshot.operation === "upsert")
            .map(snapshotToMemory)
            .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
            .slice(0, boundedLimit);

        return rows;
    }

    const rows = loadCurrentBranchViewRows({
        projectId: scoped.projectId,
        branch: scoped.branch,
        limit: boundedLimit
    });

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

export function auditMemoryResurrection(
    options: MemoryResurrectionAuditOptions = {}
): MemoryResurrectionAuditReport {
    const projectId = normalizeOptionalProjectId(options.projectId);
    const limit = normalizeResurrectionAuditLimit(options.limit);
    const maxIssues = normalizeResurrectionAuditMaxIssues(options.maxIssues);

    const rows = projectId
        ? db
            .prepare(
                `
            SELECT id, projectId, kind, sourceType, title, content, lastAccessedAt
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
            SELECT id, projectId, kind, sourceType, title, content, lastAccessedAt
            FROM memories
            ORDER BY lastAccessedAt DESC
            LIMIT ?
          `
            )
            .all<Record<string, unknown>>(limit);

    let compactedRows = 0;
    let plainRows = 0;
    let validCompactedRows = 0;
    const anomalies = createIntegrityAnomalies();
    const issueSamples: MemoryResurrectionAuditIssue[] = [];

    for (const row of rows) {
        const analysis = analyzeStoredContent(String(row.content ?? ""));

        if (!analysis.isCompacted) {
            plainRows += 1;
            continue;
        }

        compactedRows += 1;

        if (analysis.integrity === "invalid_checksum") {
            anomalies.invalidChecksum += 1;

            if (issueSamples.length < maxIssues) {
                issueSamples.push({
                    id: String(row.id ?? ""),
                    projectId: normalizeProjectId(row.projectId),
                    kind: String(row.kind ?? "semantic") as MemoryRecord["kind"],
                    sourceType: String(row.sourceType ?? "manual") as MemoryRecord["sourceType"],
                    title: String(row.title ?? ""),
                    integrity: "invalid_checksum",
                    preview: analysis.preview,
                    storedChars: analysis.storedChars,
                    originalChars: analysis.originalChars,
                    savedChars: analysis.savedChars,
                    lastAccessedAt: toFiniteInteger(row.lastAccessedAt) ?? 0
                });
            }

            continue;
        }

        if (analysis.integrity === "decode_error") {
            anomalies.decodeError += 1;

            if (issueSamples.length < maxIssues) {
                issueSamples.push({
                    id: String(row.id ?? ""),
                    projectId: normalizeProjectId(row.projectId),
                    kind: String(row.kind ?? "semantic") as MemoryRecord["kind"],
                    sourceType: String(row.sourceType ?? "manual") as MemoryRecord["sourceType"],
                    title: String(row.title ?? ""),
                    integrity: "decode_error",
                    preview: analysis.preview,
                    storedChars: analysis.storedChars,
                    originalChars: analysis.originalChars,
                    savedChars: analysis.savedChars,
                    lastAccessedAt: toFiniteInteger(row.lastAccessedAt) ?? 0
                });
            }

            continue;
        }

        validCompactedRows += 1;
    }

    anomalies.total = anomalies.invalidChecksum + anomalies.decodeError;
    const scannedRows = rows.length;
    const anomalyRate = compactedRows > 0 ? anomalies.total / compactedRows : 0;
    const compactionOpportunityRate = scannedRows > 0 ? plainRows / scannedRows : 0;

    return {
        projectId,
        scannedRows,
        compactedRows,
        plainRows,
        validCompactedRows,
        anomalies,
        anomalyRate,
        compactionOpportunityRate,
        issueSamples,
        recommendations: buildResurrectionAuditRecommendations({
            scannedRows,
            anomalies,
            compactionOpportunityRate
        })
    };
}

export function getMemoryCompactionOpportunities(
    options: MemoryCompactionOpportunityOptions = {}
): MemoryCompactionOpportunityReport {
    const projectId = normalizeOptionalProjectId(options.projectId);
    const limit = normalizeOpportunityLimit(options.limit);
    const scanLimit = normalizeOpportunityScanLimit(options.scanLimit, limit);
    const minContentChars = normalizeOpportunityMinContentChars(options.minContentChars);

    const rows = projectId
        ? db
            .prepare(
                `
            SELECT id, projectId, kind, sourceType, title, sourceRef, content, lastAccessedAt
            FROM memories
            WHERE projectId = ?
            ORDER BY lastAccessedAt DESC
            LIMIT ?
          `
            )
            .all<Record<string, unknown>>(projectId, scanLimit)
        : db
            .prepare(
                `
            SELECT id, projectId, kind, sourceType, title, sourceRef, content, lastAccessedAt
            FROM memories
            ORDER BY lastAccessedAt DESC
            LIMIT ?
          `
            )
            .all<Record<string, unknown>>(scanLimit);

    let plainRows = 0;
    let candidates = 0;
    let totalEstimatedSavedChars = 0;
    const items: MemoryCompactionOpportunityItem[] = [];

    for (const row of rows) {
        const storedContent = String(row.content ?? "");
        const storedAnalysis = analyzeStoredContent(storedContent);
        if (storedAnalysis.isCompacted) {
            continue;
        }

        plainRows += 1;

        const restoredContent = resurrectContentFromStorage(storedContent);
        const contentChars = restoredContent.length;
        if (contentChars < minContentChars) {
            continue;
        }

        const compactedCandidate = compactContentForStorage(restoredContent);
        if (compactedCandidate === restoredContent) {
            continue;
        }

        const estimatedStoredChars = compactedCandidate.length;
        const estimatedSavedChars = Math.max(0, contentChars - estimatedStoredChars);
        if (estimatedSavedChars <= 0) {
            continue;
        }

        const estimatedSavedPercent = contentChars > 0 ? (estimatedSavedChars / contentChars) * 100 : 0;
        const estimatedCompressionRatio = estimatedStoredChars / Math.max(1, contentChars);

        candidates += 1;
        totalEstimatedSavedChars += estimatedSavedChars;

        items.push({
            id: String(row.id ?? ""),
            projectId: normalizeProjectId(row.projectId),
            kind: String(row.kind ?? "semantic") as MemoryRecord["kind"],
            sourceType: String(row.sourceType ?? "manual") as MemoryRecord["sourceType"],
            title: String(row.title ?? ""),
            sourceRef: row.sourceRef ? String(row.sourceRef) : undefined,
            lastAccessedAt: toFiniteInteger(row.lastAccessedAt) ?? 0,
            contentChars,
            estimatedStoredChars,
            estimatedSavedChars,
            estimatedSavedPercent,
            estimatedCompressionRatio
        });
    }

    items.sort((a, b) => {
        const savedGap = b.estimatedSavedChars - a.estimatedSavedChars;
        if (savedGap !== 0) {
            return savedGap;
        }

        return b.lastAccessedAt - a.lastAccessedAt;
    });

    return {
        generatedAt: Date.now(),
        projectId,
        scannedRows: rows.length,
        plainRows,
        candidates,
        totalEstimatedSavedChars,
        items: items.slice(0, limit)
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

    const topK = clampInteger(options.topK, 10, 1, 200);
    const minScore = typeof options.minScore === "number" && Number.isFinite(options.minScore)
        ? Math.min(1, Math.max(0, options.minScore))
        : 0;
    const scoped = normalizeBranchScopedReadOptions(options.projectId, options.branch, options.asOf);

    if (scoped && (scoped.branch !== MAIN_BRANCH || typeof scoped.asOf === "number")) {
        if (typeof scoped.asOf === "number") {
            const state = loadTemporalBranchState(scoped.projectId, scoped.branch, scoped.asOf);
            const records = [...state.values()]
                .filter((snapshot) => snapshot.operation === "upsert")
                .map(snapshotToMemory)
                .filter((memory) => {
                    const text = `${memory.title}\n${memory.summary}\n${memory.content}`.toLowerCase();
                    return text.includes(q.toLowerCase());
                });

            return scoreFromLexical(records, q, topK, minScore);
        }

        const lexicalLike = `%${q}%`;
        const rows = loadCurrentBranchViewRows({
            projectId: scoped.projectId,
            branch: scoped.branch,
            lexicalLike,
            limit: topK * 8
        });

        const records = rows.map(rowToMemory);
        return scoreFromLexical(records, q, topK, minScore);
    }

    const projectFilter = scoped?.projectId;
    const now = Date.now();
    const qLower = q.toLowerCase();
    const lexicalLike = `%${q}%`;

    const lexicalRows = projectFilter
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
            .all<Record<string, unknown>>(projectFilter, lexicalLike, lexicalLike, lexicalLike, topK * 3)
            .map((row) => ({ ...row, branch: MAIN_BRANCH, logicalId: row.id }))
        : db
            .prepare(
                `
            SELECT * FROM memories
            WHERE title LIKE ? OR summary LIKE ? OR content LIKE ?
            ORDER BY lastAccessedAt DESC
            LIMIT ?
          `
            )
            .all<Record<string, unknown>>(lexicalLike, lexicalLike, lexicalLike, topK * 3)
            .map((row) => ({ ...row, branch: MAIN_BRANCH, logicalId: row.id }));

    const lexicalCandidates = new Map<string, MemoryRecord>();
    for (const row of lexicalRows) {
        const memory = rowToMemory(row);
        lexicalCandidates.set(memory.id, memory);
    }

    if (lexicalCandidates.size < topK * 3) {
        const fallbackLimit = Math.min(1500, Math.max(250, topK * 40));
        const fallbackRows = projectFilter
            ? db
                .prepare(
                    `
                SELECT * FROM memories
                WHERE projectId = ?
                ORDER BY lastAccessedAt DESC
                LIMIT ?
              `
                )
                .all<Record<string, unknown>>(projectFilter, fallbackLimit)
                .map((row) => ({ ...row, branch: MAIN_BRANCH, logicalId: row.id }))
            : db
                .prepare(
                    `
                SELECT * FROM memories
                ORDER BY lastAccessedAt DESC
                LIMIT ?
              `
                )
                .all<Record<string, unknown>>(fallbackLimit)
                .map((row) => ({ ...row, branch: MAIN_BRANCH, logicalId: row.id }));

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

    const queryEmbedding = await embedText(q);
    if (queryEmbedding.length > 0 && !isVectorRetryOnCooldown()) {
        try {
            await ensureVectorReady();
            const vectorHits = await searchVectorItems(MEMORY_COLLECTION, queryEmbedding, topK * 3);

            for (const hit of vectorHits) {
                const existing = merged.get(hit.id);
                const row = existing
                    ? null
                    : db.prepare(`SELECT * FROM memories WHERE id = ?`).get<Record<string, unknown>>(hit.id);

                const memory = existing ?? (row ? rowToMemory({ ...row, branch: MAIN_BRANCH, logicalId: row.id }) : null);
                if (!memory) continue;
                if (projectFilter && memory.projectId !== projectFilter) continue;

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
            markVectorHealthy();
        } catch (error) {
            markVectorUnavailable("search", error);
        }
    }

    return [...merged.values()]
        .filter((memory) => memory.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
}

export function listMemoryBranches(projectId: string): MemoryBranchRecord[] {
    const normalizedProjectId = normalizeProjectId(projectId);
    ensureMainBranch(normalizedProjectId);

    const rows = db
        .prepare(
            `
            SELECT *
            FROM memory_branches
            WHERE projectId = ?
            ORDER BY createdAt ASC, branch ASC
          `
        )
        .all<Record<string, unknown>>(normalizedProjectId);

    return rows.map(toBranchRecord);
}

export function createMemoryBranch(input: CreateMemoryBranchInput): MemoryBranchRecord {
    const projectId = normalizeProjectId(input.projectId);
    const branch = normalizeBranchName(input.branch);
    const fromBranch = normalizeBranchName(input.fromBranch ?? MAIN_BRANCH);

    return ensureMemoryBranch(projectId, branch, fromBranch, input.forkedFromCommit);
}

function hasTargetBranchLocalWrite(projectId: string, targetBranch: string, logicalId: string): boolean {
    if (targetBranch === MAIN_BRANCH) {
        const row = db
            .prepare(`SELECT 1 AS present FROM memories WHERE projectId = ? AND id = ? LIMIT 1`)
            .get<Record<string, unknown>>(projectId, logicalId);

        return Boolean(row?.present);
    }

    const row = db
        .prepare(
            `
            SELECT 1 AS present
            FROM memory_branch_memories
            WHERE projectId = ?
              AND branch = ?
              AND logicalId = ?
            LIMIT 1
          `
        )
        .get<Record<string, unknown>>(projectId, targetBranch, logicalId);

    return Boolean(row?.present);
}

export async function mergeMemoryBranch(input: MergeMemoryBranchInput): Promise<MergeMemoryBranchResult> {
    const projectId = normalizeProjectId(input.projectId);
    const sourceBranch = normalizeBranchName(input.sourceBranch);
    const targetBranch = normalizeBranchName(input.targetBranch);
    const strategy = input.strategy === "target-wins" ? "target-wins" : "source-wins";

    ensureMemoryBranch(projectId, sourceBranch, MAIN_BRANCH);
    ensureMemoryBranch(projectId, targetBranch, MAIN_BRANCH);

    const sourceRows = sourceBranch === MAIN_BRANCH
        ? db
            .prepare(
                `
                SELECT *
                FROM memories
                WHERE projectId = ?
                ORDER BY lastAccessedAt DESC
              `
            )
            .all<Record<string, unknown>>(projectId)
            .map((row) => ({ ...row, branch: MAIN_BRANCH, logicalId: row.id }))
        : db
            .prepare(
                `
                SELECT *
                FROM memory_branch_memories
                WHERE projectId = ?
                  AND branch = ?
                ORDER BY lastAccessedAt DESC
              `
            )
            .all<Record<string, unknown>>(projectId, sourceBranch);

    const sourceDeletes = sourceBranch === MAIN_BRANCH
        ? []
        : db
            .prepare(
                `
                SELECT logicalId
                FROM memory_branch_tombstones
                WHERE projectId = ?
                  AND branch = ?
              `
            )
            .all<Record<string, unknown>>(projectId, sourceBranch)
            .map((row) => String(row.logicalId ?? "").trim())
            .filter(Boolean);

    let appliedUpserts = 0;
    let appliedDeletes = 0;
    let skipped = 0;

    for (const row of sourceRows) {
        const memory = rowToMemory(row);
        const logicalId = memory.logicalId ?? memory.id;

        if (strategy === "target-wins" && hasTargetBranchLocalWrite(projectId, targetBranch, logicalId)) {
            skipped += 1;
            continue;
        }

        await upsertMemory({
            id: logicalId,
            logicalId,
            projectId,
            branch: targetBranch,
            kind: memory.kind,
            sourceType: memory.sourceType,
            title: memory.title,
            summary: memory.summary,
            content: memory.content,
            tags: memory.tags,
            importance: memory.importance,
            confidence: memory.confidence,
            embeddingRef: memory.embeddingRef,
            sourceRef: memory.sourceRef
        });
        appliedUpserts += 1;
    }

    for (const logicalId of sourceDeletes) {
        if (strategy === "target-wins" && hasTargetBranchLocalWrite(projectId, targetBranch, logicalId)) {
            skipped += 1;
            continue;
        }

        const before = getMemoryById(logicalId, {
            projectId,
            branch: targetBranch
        });

        await deleteMemory(logicalId, {
            projectId,
            branch: targetBranch
        });

        if (before) {
            appliedDeletes += 1;
        }
    }

    return {
        projectId,
        sourceBranch,
        targetBranch,
        strategy,
        mergedRows: sourceRows.length + sourceDeletes.length,
        appliedUpserts,
        appliedDeletes,
        skipped,
        completedAt: Date.now()
    };
}

export function diffMemoriesBetween(options: MemoryTemporalDiffOptions): MemoryTemporalDiffResult {
    const projectId = normalizeProjectId(options.projectId);
    const branch = normalizeBranchName(options.branch);
    const from = Math.trunc(options.from);
    const to = Math.trunc(options.to);
    const limit = normalizeTemporalDiffLimit(options.limit);

    const start = Math.min(from, to);
    const end = Math.max(from, to);

    const fromState = loadTemporalBranchState(projectId, branch, start);
    const toState = loadTemporalBranchState(projectId, branch, end);
    const logicalIds = new Set<string>([...fromState.keys(), ...toState.keys()]);

    const items: MemoryTemporalDiffResult["items"] = [];
    let added = 0;
    let removed = 0;
    let modified = 0;

    for (const logicalId of logicalIds) {
        const beforeSnapshot = fromState.get(logicalId);
        const afterSnapshot = toState.get(logicalId);
        const before = beforeSnapshot && beforeSnapshot.operation === "upsert" ? snapshotToMemory(beforeSnapshot) : undefined;
        const after = afterSnapshot && afterSnapshot.operation === "upsert" ? snapshotToMemory(afterSnapshot) : undefined;

        if (!before && !after) {
            continue;
        }

        if (!before && after) {
            added += 1;
            items.push({
                logicalId,
                kind: after.kind,
                sourceType: after.sourceType,
                title: after.title,
                branch: after.branch ?? branch,
                after: {
                    summary: after.summary,
                    content: after.content,
                    sourceRef: after.sourceRef,
                    confidence: after.confidence,
                    importance: after.importance
                },
                changeType: "added"
            });
            continue;
        }

        if (before && !after) {
            removed += 1;
            items.push({
                logicalId,
                kind: before.kind,
                sourceType: before.sourceType,
                title: before.title,
                branch: before.branch ?? branch,
                before: {
                    summary: before.summary,
                    content: before.content,
                    sourceRef: before.sourceRef,
                    confidence: before.confidence,
                    importance: before.importance
                },
                changeType: "removed"
            });
            continue;
        }

        if (!before || !after) {
            continue;
        }

        const changed =
            before.title !== after.title ||
            before.summary !== after.summary ||
            before.content !== after.content ||
            before.sourceRef !== after.sourceRef ||
            Math.abs(before.confidence - after.confidence) > 0.000001 ||
            Math.abs(before.importance - after.importance) > 0.000001;

        if (!changed) {
            continue;
        }

        modified += 1;
        items.push({
            logicalId,
            kind: after.kind,
            sourceType: after.sourceType,
            title: after.title,
            branch: after.branch ?? branch,
            before: {
                summary: before.summary,
                content: before.content,
                sourceRef: before.sourceRef,
                confidence: before.confidence,
                importance: before.importance
            },
            after: {
                summary: after.summary,
                content: after.content,
                sourceRef: after.sourceRef,
                confidence: after.confidence,
                importance: after.importance
            },
            changeType: "modified"
        });
    }

    const priority = new Map<MemoryTemporalDiffResult["items"][number]["changeType"], number>([
        ["modified", 0],
        ["added", 1],
        ["removed", 2]
    ]);

    items.sort((a, b) => {
        const typeGap = (priority.get(a.changeType) ?? 9) - (priority.get(b.changeType) ?? 9);
        if (typeGap !== 0) {
            return typeGap;
        }

        return a.logicalId.localeCompare(b.logicalId);
    });

    return {
        projectId,
        branch,
        from,
        to,
        totals: {
            added,
            removed,
            modified
        },
        items: items.slice(0, limit)
    };
}

export async function deleteMemory(
    id: string,
    options: {
        projectId?: string;
        branch?: string;
    } = {}
): Promise<void> {
    const normalizedId = String(id ?? "").trim();
    if (!normalizedId) {
        return;
    }

    const scoped = normalizeBranchScopedReadOptions(options.projectId, options.branch);
    if (!scoped) {
        await deleteMemoriesByIds([normalizedId]);
        return;
    }

    const projectId = scoped.projectId;
    const branch = scoped.branch;
    const now = Date.now();
    const metadata = readBranchMetadata(projectId, branch);
    const prior = getMemoryById(normalizedId, {
        projectId,
        branch
    });

    const logicalId = prior?.logicalId ?? normalizedId;

    if (branch === MAIN_BRANCH) {
        const row = db
            .prepare(`SELECT id FROM memories WHERE projectId = ? AND id = ?`)
            .get<Record<string, unknown>>(projectId, logicalId);

        if (row) {
            db.prepare(`DELETE FROM memories WHERE projectId = ? AND id = ?`).run(projectId, logicalId);

            try {
                await deleteVectorItems(MEMORY_COLLECTION, [String(row.id)]);
            } catch (error) {
                markVectorUnavailable("delete", error);
            }
        }

        writeDeleteSnapshot({
            projectId,
            branch,
            logicalId,
            deletedAt: now,
            metadata,
            prior
        });

        return;
    }

    const localRows = db
        .prepare(
            `
            SELECT id
            FROM memory_branch_memories
            WHERE projectId = ?
              AND branch = ?
              AND (logicalId = ? OR id = ?)
          `
        )
        .all<Record<string, unknown>>(projectId, branch, logicalId, normalizedId)
        .map((row) => String(row.id ?? ""))
        .filter(Boolean);

    if (localRows.length > 0) {
        const placeholders = localRows.map(() => "?").join(",");
        db.prepare(
            `
            DELETE FROM memory_branch_memories
            WHERE id IN (${placeholders})
          `
        ).run(...localRows);

        try {
            await deleteVectorItems(MEMORY_COLLECTION, localRows);
        } catch (error) {
            markVectorUnavailable("delete", error);
        }
    }

    upsertBranchTombstone(projectId, branch, logicalId, now);
    writeDeleteSnapshot({
        projectId,
        branch,
        logicalId,
        deletedAt: now,
        metadata,
        prior
    });
}

export async function deleteMemoriesByIds(
    ids: string[],
    options: {
        projectId?: string;
        branch?: string;
    } = {}
): Promise<number> {
    const uniqueIds = [...new Set(ids.map((id) => String(id ?? "").trim()).filter(Boolean))];
    if (uniqueIds.length === 0) {
        return 0;
    }

    const scoped = normalizeBranchScopedReadOptions(options.projectId, options.branch);
    if (scoped) {
        let deleted = 0;
        for (const id of uniqueIds) {
            const before = getMemoryById(id, {
                projectId: scoped.projectId,
                branch: scoped.branch
            });

            await deleteMemory(id, {
                projectId: scoped.projectId,
                branch: scoped.branch
            });

            if (before) {
                deleted += 1;
            }
        }

        return deleted;
    }

    const SQLITE_PARAM_LIMIT = 900;
    let deleted = 0;

    for (const batch of chunkIds(uniqueIds, SQLITE_PARAM_LIMIT)) {
        const placeholders = batch.map(() => "?").join(",");

        const mainRows = db
            .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
            .all<Record<string, unknown>>(...batch)
            .map((row) => ({ ...row, branch: MAIN_BRANCH, logicalId: row.id }));

        const branchRows = db
            .prepare(`SELECT * FROM memory_branch_memories WHERE id IN (${placeholders})`)
            .all<Record<string, unknown>>(...batch);

        const mainOutcome = db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...batch) as {
            changes?: unknown;
        };
        const branchOutcome = db.prepare(`DELETE FROM memory_branch_memories WHERE id IN (${placeholders})`).run(...batch) as {
            changes?: unknown;
        };

        const changedMain = Number(mainOutcome?.changes ?? 0);
        const changedBranch = Number(branchOutcome?.changes ?? 0);
        if (Number.isFinite(changedMain) && changedMain > 0) {
            deleted += changedMain;
        }
        if (Number.isFinite(changedBranch) && changedBranch > 0) {
            deleted += changedBranch;
        }

        for (const row of [...mainRows, ...branchRows]) {
            const memory = rowToMemory(row);
            const logicalId = memory.logicalId ?? memory.id;
            writeDeleteSnapshot({
                projectId: memory.projectId,
                branch: memory.branch ?? MAIN_BRANCH,
                logicalId,
                deletedAt: Date.now(),
                metadata: readBranchMetadata(memory.projectId, memory.branch ?? MAIN_BRANCH),
                prior: memory
            });
        }

        try {
            await deleteVectorItems(MEMORY_COLLECTION, batch);
        } catch (error) {
            markVectorUnavailable("delete", error);
        }
    }

    return deleted;
}

export const memoryService = {
    upsert: upsertMemory,
    search: searchMemories,
    getById: getMemoryById,
    list: listMemories,
    listBranches: listMemoryBranches,
    createBranch: createMemoryBranch,
    mergeBranch: mergeMemoryBranch,
    diffBetween: diffMemoriesBetween,
    compactionStats: getMemoryCompactionStats,
    compactionDashboard: getMemoryCompactionDashboard,
    compactionOpportunities: getMemoryCompactionOpportunities,
    backfillCompaction: backfillMemoryCompaction,
    auditResurrection: auditMemoryResurrection,
    deleteMany: deleteMemoriesByIds,
    delete: deleteMemory
};
