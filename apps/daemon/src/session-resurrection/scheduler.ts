import path from "node:path";
import { indexMemoryGraph, type GraphMemoryIndexResult } from "../../../../core/graph/memory.graph.indexer";
import { runIngestion, type IngestionResult } from "../../../../core/ingestion/ingest.pipeline";
import {
    auditMemoryResurrection,
    backfillMemoryCompaction
} from "../../../../core/mempalace/memory.service";
import type {
    BackfillMemoryCompactionResult,
    MemoryResurrectionAuditReport
} from "../../../../core/mempalace/memory.types";
import { connectSqlite, initializeSqlite, type SqliteDatabase } from "../../../../storage/sqlite/db";

export type SessionResurrectionTrigger = "scheduled" | "manual" | "startup";
export type SessionResurrectionRunOutcome = "indexed" | "applied" | "skipped" | "error";

interface SessionResurrectionOutcomeCounters {
    total: number;
    indexed: number;
    applied: number;
    skipped: number;
    error: number;
}

export interface SessionResurrectionSloWindowCounters extends SessionResurrectionOutcomeCounters {
    windowMinutes: number;
    windowMs: number;
    sinceMs: number;
    successRate: number;
    errorRate: number;
    applyRate: number;
    indexRate: number;
}

export interface SessionResurrectionSloSnapshot {
    generatedAt: number;
    windows: SessionResurrectionSloWindowCounters[];
}

interface SessionResurrectionPersistedHistorySnapshot {
    totalRuns: number;
    recentRuns: SessionResurrectionRunReport[];
    consecutiveFailures: number;
}

export interface SessionResurrectionConfig {
    enabled: boolean;
    projectPath?: string;
    projectId?: string;
    branch: string;
    intervalMs: number;
    jitterMs: number;
    runOnStart: boolean;
    includeChats: boolean;
    skipUnchanged: boolean;
    maxFiles?: number;
    maxChatFiles: number;
    chatSearchRoot?: string;
    graphIndexLookbackHours: number;
    graphIndexLimit: number;
    graphSnapshotLimit: number;
    auditLimit: number;
    auditMaxIssues: number;
    backfillLimit: number;
    applyEnabled: boolean;
    maxAllowedAnomalies: number;
    historyLimit: number;
    persistHistory: boolean;
    persistedHistoryLimit: number;
    backoffEnabled: boolean;
    backoffMultiplier: number;
    maxBackoffIntervalMs: number;
    sloWindowsMinutes: number[];
}

export interface SessionResurrectionRunOptions {
    dryRunOnly?: boolean;
    reason?: string;
    projectPath?: string;
    includeChats?: boolean;
}

export interface SessionResurrectionApplyDecision {
    allowApply: boolean;
    applyLimit: number;
    reasons: string[];
}

export interface SessionResurrectionRunReport {
    runId: string;
    trigger: SessionResurrectionTrigger;
    reason?: string;
    dryRunOnly: boolean;
    projectPath?: string;
    projectId?: string;
    branch: string;
    startedAt: number;
    completedAt: number;
    durationMs: number;
    outcome: SessionResurrectionRunOutcome;
    decision: SessionResurrectionApplyDecision;
    ingestion?: IngestionResult;
    graphIndex?: GraphMemoryIndexResult;
    audit?: {
        scannedRows: number;
        compactedRows: number;
        plainRows: number;
        anomalies: {
            invalidChecksum: number;
            decodeError: number;
            total: number;
        };
        anomalyRate: number;
        compactionOpportunityRate: number;
        recommendationCount: number;
    };
    dryRunBackfill?: BackfillMemoryCompactionResult;
    applyBackfill?: BackfillMemoryCompactionResult;
    error?: string;
}

export interface SessionResurrectionStatus {
    enabled: boolean;
    started: boolean;
    running: boolean;
    nextRunAt?: number;
    lastScheduledDelayMs?: number;
    consecutiveFailures: number;
    runCount: number;
    config: SessionResurrectionConfig;
    lastRun?: SessionResurrectionRunReport;
    recentRuns: SessionResurrectionRunReport[];
    slo: SessionResurrectionSloSnapshot;
}

export interface SessionResurrectionRunLifecycleState {
    consecutiveFailures: number;
    runCount: number;
}

export interface SessionResurrectionServices {
    ingest: (input: {
        projectPath: string;
        projectId?: string;
        branch?: string;
        includeChats?: boolean;
        skipUnchanged?: boolean;
        maxFiles?: number;
        maxChatFiles?: number;
        chatSearchRoots?: string[];
    }) => Promise<IngestionResult>;
    indexGraph: (input: {
        projectId: string;
        branch?: string;
        lookbackHours?: number;
        limit?: number;
        snapshotLimit?: number;
    }) => GraphMemoryIndexResult;
    audit: (options: { projectId?: string; limit?: number; maxIssues?: number }) => MemoryResurrectionAuditReport;
    backfill: (options: { projectId?: string; limit?: number; dryRun?: boolean }) => BackfillMemoryCompactionResult;
    loadHistory: (options: { scope: string; historyLimit: number }) => SessionResurrectionPersistedHistorySnapshot;
    persistRun: (options: { scope: string; projectId?: string; branch: string; run: SessionResurrectionRunReport; retentionLimit: number }) => void;
    countOutcomesSince: (options: { scope: string; sinceMs: number }) => SessionResurrectionOutcomeCounters;
    now: () => number;
    random: () => number;
    log: (level: "info" | "warn" | "error", message: string, payload?: Record<string, unknown>) => void;
    onRunCompleted: (run: SessionResurrectionRunReport, state: SessionResurrectionRunLifecycleState) => void;
}

const MAIN_BRANCH = "main";
const HISTORY_SCOPE_FALLBACK = "__session_resurrection_default__";
const HISTORY_RETENTION_MAX = 50_000;

const DEFAULT_CONFIG: SessionResurrectionConfig = {
    enabled: false,
    projectPath: undefined,
    projectId: undefined,
    branch: MAIN_BRANCH,
    intervalMs: 15 * 60 * 1000,
    jitterMs: 30 * 1000,
    runOnStart: false,
    includeChats: true,
    skipUnchanged: true,
    maxFiles: undefined,
    maxChatFiles: 400,
    chatSearchRoot: undefined,
    graphIndexLookbackHours: 24 * 14,
    graphIndexLimit: 5000,
    graphSnapshotLimit: 5000,
    auditLimit: 5000,
    auditMaxIssues: 20,
    backfillLimit: 2000,
    applyEnabled: false,
    maxAllowedAnomalies: 0,
    historyLimit: 50,
    persistHistory: true,
    persistedHistoryLimit: 2000,
    backoffEnabled: true,
    backoffMultiplier: 2,
    maxBackoffIntervalMs: 6 * 60 * 60 * 1000,
    sloWindowsMinutes: [60, 24 * 60, 7 * 24 * 60]
};

let historyDb: SqliteDatabase | null = null;
let historyDbInitialized = false;

function createEmptyOutcomeCounters(): SessionResurrectionOutcomeCounters {
    return {
        total: 0,
        indexed: 0,
        applied: 0,
        skipped: 0,
        error: 0
    };
}

function outcomeFromUnknown(value: unknown): SessionResurrectionRunOutcome | undefined {
    if (value === "indexed" || value === "applied" || value === "skipped" || value === "error") {
        return value;
    }

    return undefined;
}

function incrementOutcomeCounter(counters: SessionResurrectionOutcomeCounters, outcome: SessionResurrectionRunOutcome): void {
    counters.total += 1;

    if (outcome === "indexed") {
        counters.indexed += 1;
        return;
    }

    if (outcome === "applied") {
        counters.applied += 1;
        return;
    }

    if (outcome === "skipped") {
        counters.skipped += 1;
        return;
    }

    counters.error += 1;
}

function parseSloWindowMinutes(value: unknown, fallback: number[]): number[] {
    if (typeof value !== "string") {
        return [...fallback];
    }

    const parsed = value
        .split(/[;,\s]+/)
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isFinite(item))
        .map((item) => Math.trunc(item))
        .filter((item) => item >= 1 && item <= 60 * 24 * 30);

    if (parsed.length === 0) {
        return [...fallback];
    }

    return [...new Set(parsed)].sort((a, b) => a - b).slice(0, 8);
}

function chunkStrings(values: string[], chunkSize: number): string[][] {
    if (values.length === 0 || chunkSize <= 0) {
        return [];
    }

    const result: string[][] = [];
    for (let index = 0; index < values.length; index += chunkSize) {
        result.push(values.slice(index, index + chunkSize));
    }

    return result;
}

function getHistoryDb(): SqliteDatabase {
    if (!historyDb) {
        historyDb = connectSqlite();
    }

    if (!historyDbInitialized) {
        initializeSqlite(historyDb);
        historyDbInitialized = true;
    }

    return historyDb;
}

function normalizePath(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }

    return path.resolve(trimmed);
}

function normalizeProjectId(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed || undefined;
}

function resolveProjectId(projectPath: string | undefined, projectId: string | undefined): string {
    if (projectId) {
        return projectId;
    }

    if (projectPath) {
        const basename = path.basename(projectPath).trim();
        if (basename) {
            return basename;
        }
    }

    return "default";
}

function normalizeBranchName(value: unknown): string {
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized || MAIN_BRANCH;
}

function resolveScope(projectId: string | undefined, branch: string): string {
    return `${projectId?.trim() || HISTORY_SCOPE_FALLBACK}::${branch}`;
}

function parseRunPayload(payload: unknown): SessionResurrectionRunReport | undefined {
    if (typeof payload !== "string" || !payload.trim()) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(payload) as Partial<SessionResurrectionRunReport>;
        if (typeof parsed.runId !== "string") {
            return undefined;
        }

        if (parsed.trigger !== "scheduled" && parsed.trigger !== "manual" && parsed.trigger !== "startup") {
            return undefined;
        }

        const outcome = outcomeFromUnknown(parsed.outcome);
        if (!outcome) {
            return undefined;
        }

        return {
            runId: parsed.runId,
            trigger: parsed.trigger,
            reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
            dryRunOnly: parsed.dryRunOnly === true,
            projectPath: typeof parsed.projectPath === "string" ? parsed.projectPath : undefined,
            projectId: typeof parsed.projectId === "string" ? parsed.projectId : undefined,
            branch: typeof parsed.branch === "string" ? parsed.branch : MAIN_BRANCH,
            startedAt: Number(parsed.startedAt ?? 0),
            completedAt: Number(parsed.completedAt ?? 0),
            durationMs: Number(parsed.durationMs ?? 0),
            outcome,
            decision: {
                allowApply: parsed.decision?.allowApply === true,
                applyLimit: Number(parsed.decision?.applyLimit ?? 0),
                reasons: Array.isArray(parsed.decision?.reasons)
                    ? parsed.decision.reasons.map((reason) => String(reason)).filter((reason) => reason.trim().length > 0)
                    : []
            },
            ingestion: parsed.ingestion,
            graphIndex: parsed.graphIndex,
            audit: parsed.audit,
            dryRunBackfill: parsed.dryRunBackfill,
            applyBackfill: parsed.applyBackfill,
            error: typeof parsed.error === "string" ? parsed.error : undefined
        };
    } catch {
        return undefined;
    }
}

function computeConsecutiveFailuresFromRuns(runs: SessionResurrectionRunReport[]): number {
    let consecutiveFailures = 0;

    for (const run of runs) {
        if (run.outcome === "error") {
            consecutiveFailures += 1;
            continue;
        }

        if (run.outcome === "skipped") {
            continue;
        }

        break;
    }

    return consecutiveFailures;
}

function loadPersistedHistory(options: { scope: string; historyLimit: number }): SessionResurrectionPersistedHistorySnapshot {
    const db = getHistoryDb();

    const totalRow = db
        .prepare(
            `
            SELECT COUNT(1) AS total
            FROM session_resurrection_run_history
            WHERE schedulerScope = ?
          `
        )
        .get<{ total?: number }>(options.scope);

    const rows = db
        .prepare(
            `
            SELECT payload
            FROM session_resurrection_run_history
            WHERE schedulerScope = ?
            ORDER BY startedAt DESC
            LIMIT ?
          `
        )
        .all<Record<string, unknown>>(options.scope, options.historyLimit);

    const recentRuns = rows
        .map((row) => parseRunPayload(row.payload))
        .filter((run): run is SessionResurrectionRunReport => Boolean(run));

    return {
        totalRuns: Math.max(0, Number(totalRow?.total ?? 0)),
        recentRuns,
        consecutiveFailures: computeConsecutiveFailuresFromRuns(recentRuns)
    };
}

function persistRunToHistory(options: {
    scope: string;
    projectId?: string;
    branch: string;
    run: SessionResurrectionRunReport;
    retentionLimit: number;
}): void {
    const db = getHistoryDb();
    const payload = JSON.stringify(options.run);

    db.prepare(
        `
        INSERT OR REPLACE INTO session_resurrection_run_history (
            id,
            schedulerScope,
            projectId,
            branch,
            trigger,
            outcome,
            dryRunOnly,
            reason,
            startedAt,
            completedAt,
            durationMs,
            payload,
            createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
        options.run.runId,
        options.scope,
        options.projectId ?? null,
        options.branch,
        options.run.trigger,
        options.run.outcome,
        options.run.dryRunOnly ? 1 : 0,
        options.run.reason ?? null,
        options.run.startedAt,
        options.run.completedAt,
        options.run.durationMs,
        payload,
        options.run.completedAt
    );

    const retentionLimit = Math.min(HISTORY_RETENTION_MAX, Math.max(0, Math.trunc(options.retentionLimit)));
    if (retentionLimit <= 0) {
        return;
    }

    const staleRows = db
        .prepare(
            `
            SELECT id
            FROM session_resurrection_run_history
            WHERE schedulerScope = ?
            ORDER BY startedAt DESC
            LIMIT -1 OFFSET ?
          `
        )
        .all<Record<string, unknown>>(options.scope, retentionLimit);

    if (staleRows.length === 0) {
        return;
    }

    const staleIds = staleRows.map((row) => String(row.id ?? "")).filter(Boolean);
    for (const batch of chunkStrings(staleIds, 900)) {
        const placeholders = batch.map(() => "?").join(",");
        db.prepare(`DELETE FROM session_resurrection_run_history WHERE id IN (${placeholders})`).run(...batch);
    }
}

function countPersistedOutcomesSince(options: { scope: string; sinceMs: number }): SessionResurrectionOutcomeCounters {
    const db = getHistoryDb();

    const rows = db
        .prepare(
            `
            SELECT outcome, COUNT(1) AS total
            FROM session_resurrection_run_history
            WHERE schedulerScope = ?
              AND startedAt >= ?
            GROUP BY outcome
          `
        )
        .all<Record<string, unknown>>(options.scope, options.sinceMs);

    const counters = createEmptyOutcomeCounters();

    for (const row of rows) {
        const outcome = outcomeFromUnknown(row.outcome);
        if (!outcome) {
            continue;
        }

        const count = Math.max(0, Math.trunc(Number(row.total ?? 0)));
        if (count <= 0) {
            continue;
        }

        counters.total += count;
        if (outcome === "indexed") {
            counters.indexed += count;
            continue;
        }

        if (outcome === "applied") {
            counters.applied += count;
            continue;
        }

        if (outcome === "skipped") {
            counters.skipped += count;
            continue;
        }

        counters.error += count;
    }

    return counters;
}

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") {
        return value;
    }

    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["1", "true", "yes", "on"].includes(normalized)) {
            return true;
        }
        if (["0", "false", "no", "off"].includes(normalized)) {
            return false;
        }
    }

    return fallback;
}

function parseBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function parseBoundedNumber(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
}

function defaultLog(level: "info" | "warn" | "error", message: string, payload?: Record<string, unknown>): void {
    if (payload) {
        console[level](`[cortexa:session-resurrection] ${message}`, payload);
        return;
    }

    console[level](`[cortexa:session-resurrection] ${message}`);
}

function summarizeAudit(report: MemoryResurrectionAuditReport): SessionResurrectionRunReport["audit"] {
    return {
        scannedRows: report.scannedRows,
        compactedRows: report.compactedRows,
        plainRows: report.plainRows,
        anomalies: {
            invalidChecksum: report.anomalies.invalidChecksum,
            decodeError: report.anomalies.decodeError,
            total: report.anomalies.total
        },
        anomalyRate: report.anomalyRate,
        compactionOpportunityRate: report.compactionOpportunityRate,
        recommendationCount: report.recommendations.length
    };
}

export function evaluateSessionResurrectionApplyDecision(params: {
    config: SessionResurrectionConfig;
    audit: MemoryResurrectionAuditReport;
    dryRun: BackfillMemoryCompactionResult;
    ingestion: IngestionResult;
    dryRunOnly?: boolean;
}): SessionResurrectionApplyDecision {
    const reasons: string[] = [];

    if (params.dryRunOnly) {
        reasons.push("Manual dry-run only mode requested.");
    }

    if (!params.config.applyEnabled) {
        reasons.push("Apply mode is disabled by configuration.");
    }

    if (params.ingestion.errors.length > 0) {
        reasons.push(`Ingestion produced ${params.ingestion.errors.length} errors; apply mode blocked.`);
    }

    if (params.audit.anomalies.total > params.config.maxAllowedAnomalies) {
        reasons.push(
            `Anomaly guardrail blocked apply (${params.audit.anomalies.total} > ${params.config.maxAllowedAnomalies}).`
        );
    }

    const applyLimit = Math.max(0, Math.trunc(params.config.backfillLimit));
    if (applyLimit <= 0) {
        reasons.push("Apply limit resolved to 0 rows.");
    }

    if (params.dryRun.compacted <= 0) {
        reasons.push("Dry-run detected no compactable rows.");
    }

    return {
        allowApply: reasons.length === 0,
        applyLimit,
        reasons
    };
}

function defaultServices(): SessionResurrectionServices {
    return {
        ingest: runIngestion,
        indexGraph: indexMemoryGraph,
        audit: auditMemoryResurrection,
        backfill: backfillMemoryCompaction,
        loadHistory: loadPersistedHistory,
        persistRun: persistRunToHistory,
        countOutcomesSince: countPersistedOutcomesSince,
        now: () => Date.now(),
        random: () => Math.random(),
        log: defaultLog,
        onRunCompleted: () => undefined
    };
}

function resolveHistoryScopeFromConfig(config: SessionResurrectionConfig): string {
    return resolveScope(config.projectId, config.branch);
}

interface ExecuteOptions {
    reschedule: boolean;
    runOptions?: SessionResurrectionRunOptions;
}

export function readSessionResurrectionConfigFromEnv(): SessionResurrectionConfig {
    const intervalMs = parseBoundedInt(
        readEnv("CORTEXA_SESSION_RESURRECTION_INTERVAL_MS"),
        DEFAULT_CONFIG.intervalMs,
        30_000,
        24 * 60 * 60 * 1000
    );
    const historyLimit = parseBoundedInt(
        readEnv("CORTEXA_SESSION_RESURRECTION_HISTORY_LIMIT"),
        DEFAULT_CONFIG.historyLimit,
        1,
        500
    );
    const persistedHistoryLimit = parseBoundedInt(
        readEnv("CORTEXA_SESSION_RESURRECTION_PERSISTED_HISTORY_LIMIT"),
        DEFAULT_CONFIG.persistedHistoryLimit,
        historyLimit,
        HISTORY_RETENTION_MAX
    );
    const maxBackoffFallback = Math.min(24 * 60 * 60 * 1000, Math.max(intervalMs, intervalMs * 8));

    const projectPath = normalizePath(readEnv("CORTEXA_SESSION_RESURRECTION_PROJECT_PATH"));
    const configuredProjectId = normalizeProjectId(readEnv("CORTEXA_SESSION_RESURRECTION_PROJECT_ID"));
    const projectId = configuredProjectId ?? resolveProjectId(projectPath, undefined);

    return {
        enabled: parseBoolean(readEnv("CORTEXA_SESSION_RESURRECTION_ENABLED"), DEFAULT_CONFIG.enabled),
        projectPath,
        projectId,
        branch: normalizeBranchName(readEnv("CORTEXA_SESSION_RESURRECTION_BRANCH") ?? DEFAULT_CONFIG.branch),
        intervalMs,
        jitterMs: parseBoundedInt(
            readEnv("CORTEXA_SESSION_RESURRECTION_JITTER_MS"),
            DEFAULT_CONFIG.jitterMs,
            0,
            60 * 60 * 1000
        ),
        runOnStart: parseBoolean(
            readEnv("CORTEXA_SESSION_RESURRECTION_RUN_ON_START"),
            DEFAULT_CONFIG.runOnStart
        ),
        includeChats: parseBoolean(
            readEnv("CORTEXA_SESSION_RESURRECTION_INCLUDE_CHATS"),
            DEFAULT_CONFIG.includeChats
        ),
        skipUnchanged: parseBoolean(
            readEnv("CORTEXA_SESSION_RESURRECTION_SKIP_UNCHANGED"),
            DEFAULT_CONFIG.skipUnchanged
        ),
        maxFiles: (() => {
            const raw = readEnv("CORTEXA_SESSION_RESURRECTION_MAX_FILES");
            if (!raw) {
                return DEFAULT_CONFIG.maxFiles;
            }

            const parsed = parseBoundedInt(raw, Number.POSITIVE_INFINITY, 0, 200_000);
            return Number.isFinite(parsed) ? parsed : undefined;
        })(),
        maxChatFiles: parseBoundedInt(
            readEnv("CORTEXA_SESSION_RESURRECTION_MAX_CHAT_FILES"),
            DEFAULT_CONFIG.maxChatFiles,
            1,
            50_000
        ),
        chatSearchRoot: normalizePath(readEnv("CORTEXA_SESSION_RESURRECTION_CHAT_ROOT")),
        graphIndexLookbackHours: parseBoundedInt(
            readEnv("CORTEXA_SESSION_RESURRECTION_GRAPH_LOOKBACK_HOURS"),
            DEFAULT_CONFIG.graphIndexLookbackHours,
            1,
            24 * 365
        ),
        graphIndexLimit: parseBoundedInt(
            readEnv("CORTEXA_SESSION_RESURRECTION_GRAPH_LIMIT"),
            DEFAULT_CONFIG.graphIndexLimit,
            1,
            20_000
        ),
        graphSnapshotLimit: parseBoundedInt(
            readEnv("CORTEXA_SESSION_RESURRECTION_GRAPH_SNAPSHOT_LIMIT"),
            DEFAULT_CONFIG.graphSnapshotLimit,
            1,
            20_000
        ),
        auditLimit: parseBoundedInt(
            readEnv("CORTEXA_SESSION_RESURRECTION_AUDIT_LIMIT"),
            DEFAULT_CONFIG.auditLimit,
            1,
            50_000
        ),
        auditMaxIssues: parseBoundedInt(
            readEnv("CORTEXA_SESSION_RESURRECTION_AUDIT_MAX_ISSUES"),
            DEFAULT_CONFIG.auditMaxIssues,
            0,
            100
        ),
        backfillLimit: parseBoundedInt(
            readEnv("CORTEXA_SESSION_RESURRECTION_BACKFILL_LIMIT"),
            DEFAULT_CONFIG.backfillLimit,
            1,
            20_000
        ),
        applyEnabled: parseBoolean(
            readEnv("CORTEXA_SESSION_RESURRECTION_APPLY_ENABLED"),
            DEFAULT_CONFIG.applyEnabled
        ),
        maxAllowedAnomalies: parseBoundedInt(
            readEnv("CORTEXA_SESSION_RESURRECTION_MAX_ALLOWED_ANOMALIES"),
            DEFAULT_CONFIG.maxAllowedAnomalies,
            0,
            10_000
        ),
        historyLimit,
        persistHistory: parseBoolean(
            readEnv("CORTEXA_SESSION_RESURRECTION_PERSIST_HISTORY"),
            DEFAULT_CONFIG.persistHistory
        ),
        persistedHistoryLimit,
        backoffEnabled: parseBoolean(
            readEnv("CORTEXA_SESSION_RESURRECTION_BACKOFF_ENABLED"),
            DEFAULT_CONFIG.backoffEnabled
        ),
        backoffMultiplier: parseBoundedNumber(
            readEnv("CORTEXA_SESSION_RESURRECTION_BACKOFF_MULTIPLIER"),
            DEFAULT_CONFIG.backoffMultiplier,
            1.1,
            8
        ),
        maxBackoffIntervalMs: parseBoundedInt(
            readEnv("CORTEXA_SESSION_RESURRECTION_BACKOFF_MAX_INTERVAL_MS"),
            maxBackoffFallback,
            intervalMs,
            24 * 60 * 60 * 1000
        ),
        sloWindowsMinutes: parseSloWindowMinutes(
            readEnv("CORTEXA_SESSION_RESURRECTION_SLO_WINDOWS_MINUTES"),
            DEFAULT_CONFIG.sloWindowsMinutes
        )
    };
}

export class SessionResurrectionScheduler {
    private readonly services: SessionResurrectionServices;
    private readonly config: SessionResurrectionConfig;
    private readonly historyScope: string;

    private started = false;
    private running = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private nextRunAt: number | undefined;
    private lastScheduledDelayMs: number | undefined;
    private consecutiveFailures = 0;
    private runCount = 0;
    private runSequence = 0;
    private lastRun: SessionResurrectionRunReport | undefined;
    private readonly recentRuns: SessionResurrectionRunReport[] = [];

    constructor(config: SessionResurrectionConfig, services?: Partial<SessionResurrectionServices>) {
        this.config = {
            ...config,
            branch: normalizeBranchName(config.branch),
            projectPath: normalizePath(config.projectPath),
            projectId: normalizeProjectId(config.projectId) ?? resolveProjectId(config.projectPath, undefined),
            sloWindowsMinutes: [...config.sloWindowsMinutes]
        };
        this.historyScope = resolveHistoryScopeFromConfig(this.config);
        this.services = {
            ...defaultServices(),
            ...services
        };

        this.hydratePersistedState();
    }

    start(): void {
        if (this.started) {
            return;
        }

        this.started = true;

        if (!this.config.enabled) {
            this.services.log("info", "Session-resurrection scheduler is disabled.", {
                enabled: this.config.enabled
            });
            return;
        }

        this.services.log("info", "Starting session-resurrection scheduler.", {
            intervalMs: this.config.intervalMs,
            jitterMs: this.config.jitterMs,
            runOnStart: this.config.runOnStart,
            projectPath: this.config.projectPath,
            projectId: this.config.projectId,
            branch: this.config.branch,
            includeChats: this.config.includeChats,
            persistHistory: this.config.persistHistory,
            backoffEnabled: this.config.backoffEnabled
        });

        if (this.config.runOnStart) {
            void this.execute("startup", {
                reschedule: true,
                runOptions: {
                    reason: "startup"
                }
            });
            return;
        }

        this.scheduleNext();
    }

    stop(): void {
        this.started = false;
        this.nextRunAt = undefined;
        this.lastScheduledDelayMs = undefined;

        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    getStatus(): SessionResurrectionStatus {
        const nowMs = this.services.now();

        return {
            enabled: this.config.enabled,
            started: this.started,
            running: this.running,
            nextRunAt: this.nextRunAt,
            lastScheduledDelayMs: this.lastScheduledDelayMs,
            consecutiveFailures: this.consecutiveFailures,
            runCount: this.runCount,
            config: {
                ...this.config,
                sloWindowsMinutes: [...this.config.sloWindowsMinutes]
            },
            lastRun: this.lastRun,
            recentRuns: [...this.recentRuns],
            slo: this.buildSloSnapshot(nowMs)
        };
    }

    async triggerNow(runOptions: SessionResurrectionRunOptions = {}): Promise<SessionResurrectionRunReport> {
        return this.execute("manual", {
            reschedule: false,
            runOptions
        });
    }

    private hydratePersistedState(): void {
        if (!this.config.persistHistory) {
            return;
        }

        try {
            const snapshot = this.services.loadHistory({
                scope: this.historyScope,
                historyLimit: this.config.historyLimit
            });

            this.runCount = Math.max(0, Math.trunc(snapshot.totalRuns));
            this.runSequence = Math.max(this.runSequence, this.runCount);
            this.consecutiveFailures = Math.max(0, Math.trunc(snapshot.consecutiveFailures));

            this.recentRuns.length = 0;
            this.recentRuns.push(...snapshot.recentRuns.slice(0, this.config.historyLimit));
            this.lastRun = this.recentRuns[0];
        } catch (error) {
            this.services.log("warn", "Failed to hydrate persisted session-resurrection run history; continuing in-memory only.", {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private persistRun(run: SessionResurrectionRunReport): void {
        if (!this.config.persistHistory) {
            return;
        }

        try {
            this.services.persistRun({
                scope: this.historyScope,
                projectId: run.projectId,
                branch: run.branch,
                run,
                retentionLimit: this.config.persistedHistoryLimit
            });
        } catch (error) {
            this.services.log("warn", "Failed to persist session-resurrection run history row.", {
                runId: run.runId,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private updateFailureState(run: SessionResurrectionRunReport): void {
        if (run.outcome === "error") {
            this.consecutiveFailures += 1;
            return;
        }

        if (run.outcome === "skipped") {
            return;
        }

        this.consecutiveFailures = 0;
    }

    private pushRun(run: SessionResurrectionRunReport): void {
        this.updateFailureState(run);

        this.lastRun = run;
        this.runCount += 1;
        this.recentRuns.unshift(run);
        if (this.recentRuns.length > this.config.historyLimit) {
            this.recentRuns.length = this.config.historyLimit;
        }

        this.persistRun(run);

        try {
            this.services.onRunCompleted(run, {
                consecutiveFailures: this.consecutiveFailures,
                runCount: this.runCount
            });
        } catch (error) {
            this.services.log("warn", "session-resurrection lifecycle callback failed", {
                runId: run.runId,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private countOutcomesSince(sinceMs: number): SessionResurrectionOutcomeCounters {
        if (this.config.persistHistory) {
            try {
                return this.services.countOutcomesSince({
                    scope: this.historyScope,
                    sinceMs
                });
            } catch (error) {
                this.services.log("warn", "Failed to read persisted session-resurrection SLO counters; falling back to in-memory history.", {
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }

        const counters = createEmptyOutcomeCounters();
        for (const run of this.recentRuns) {
            if (run.startedAt < sinceMs) {
                continue;
            }

            incrementOutcomeCounter(counters, run.outcome);
        }

        return counters;
    }

    private buildSloSnapshot(nowMs: number): SessionResurrectionSloSnapshot {
        const windows = this.config.sloWindowsMinutes.map((windowMinutes) => {
            const windowMs = windowMinutes * 60 * 1000;
            const sinceMs = nowMs - windowMs;
            const counters = this.countOutcomesSince(sinceMs);
            const successCount = counters.total - counters.error;
            const indexCount = counters.indexed + counters.applied;

            return {
                ...counters,
                windowMinutes,
                windowMs,
                sinceMs,
                successRate: counters.total > 0 ? successCount / counters.total : 1,
                errorRate: counters.total > 0 ? counters.error / counters.total : 0,
                applyRate: counters.total > 0 ? counters.applied / counters.total : 0,
                indexRate: counters.total > 0 ? indexCount / counters.total : 0
            };
        });

        return {
            generatedAt: nowMs,
            windows
        };
    }

    private computeBackoffBaseDelayMs(): number {
        if (!this.config.backoffEnabled || this.consecutiveFailures <= 0) {
            return this.config.intervalMs;
        }

        const exponent = Math.max(0, this.consecutiveFailures - 1);
        const scaled = this.config.intervalMs * Math.pow(this.config.backoffMultiplier, exponent);
        if (!Number.isFinite(scaled)) {
            return this.config.maxBackoffIntervalMs;
        }

        return Math.min(this.config.maxBackoffIntervalMs, Math.max(this.config.intervalMs, Math.trunc(scaled)));
    }

    private scheduleNext(): void {
        if (!this.started || !this.config.enabled) {
            return;
        }

        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        const baseDelayMs = this.computeBackoffBaseDelayMs();
        const jitter = this.config.jitterMs > 0 ? Math.floor(this.services.random() * (this.config.jitterMs + 1)) : 0;
        const delayMs = Math.max(1_000, baseDelayMs + jitter);

        this.lastScheduledDelayMs = delayMs;
        this.nextRunAt = this.services.now() + delayMs;

        if (this.config.backoffEnabled && this.consecutiveFailures > 0) {
            this.services.log("warn", "Session-resurrection scheduler backoff is active due to recent failures.", {
                consecutiveFailures: this.consecutiveFailures,
                backoffMultiplier: this.config.backoffMultiplier,
                baseDelayMs,
                scheduledDelayMs: delayMs,
                maxBackoffIntervalMs: this.config.maxBackoffIntervalMs
            });
        }

        this.timer = setTimeout(() => {
            this.timer = null;
            void this.execute("scheduled", {
                reschedule: true,
                runOptions: {
                    reason: "scheduled"
                }
            });
        }, delayMs);
    }

    private buildRunId(nowMs: number): string {
        this.runSequence += 1;
        return `sessres_${nowMs.toString(36)}_${this.runSequence.toString(36)}`;
    }

    private async execute(trigger: SessionResurrectionTrigger, options: ExecuteOptions): Promise<SessionResurrectionRunReport> {
        const nowMs = this.services.now();
        const runId = this.buildRunId(nowMs);

        if (this.running) {
            const skipped: SessionResurrectionRunReport = {
                runId,
                trigger,
                reason: options.runOptions?.reason,
                dryRunOnly: options.runOptions?.dryRunOnly === true,
                projectPath: this.config.projectPath,
                projectId: this.config.projectId,
                branch: this.config.branch,
                startedAt: nowMs,
                completedAt: nowMs,
                durationMs: 0,
                outcome: "skipped",
                decision: {
                    allowApply: false,
                    applyLimit: 0,
                    reasons: ["Another session-resurrection run is already in progress."]
                }
            };

            this.pushRun(skipped);
            if (options.reschedule) {
                this.scheduleNext();
            }

            return skipped;
        }

        this.running = true;
        this.nextRunAt = undefined;

        const startedAt = nowMs;
        const dryRunOnly = options.runOptions?.dryRunOnly === true;
        const projectPath = normalizePath(options.runOptions?.projectPath) ?? this.config.projectPath;
        const projectId = resolveProjectId(projectPath, this.config.projectId);

        const run: SessionResurrectionRunReport = {
            runId,
            trigger,
            reason: options.runOptions?.reason,
            dryRunOnly,
            projectPath,
            projectId,
            branch: this.config.branch,
            startedAt,
            completedAt: startedAt,
            durationMs: 0,
            outcome: "indexed",
            decision: {
                allowApply: false,
                applyLimit: 0,
                reasons: []
            }
        };

        try {
            if (!projectPath) {
                throw new Error("Session-resurrection scheduler requires CORTEXA_SESSION_RESURRECTION_PROJECT_PATH.");
            }

            const includeChats = options.runOptions?.includeChats ?? this.config.includeChats;

            const ingestion = await this.services.ingest({
                projectPath,
                projectId,
                branch: this.config.branch,
                includeChats,
                skipUnchanged: this.config.skipUnchanged,
                maxFiles: this.config.maxFiles,
                maxChatFiles: this.config.maxChatFiles,
                chatSearchRoots: this.config.chatSearchRoot ? [this.config.chatSearchRoot] : undefined
            });
            run.ingestion = ingestion;

            const graphIndex = this.services.indexGraph({
                projectId,
                branch: this.config.branch,
                lookbackHours: this.config.graphIndexLookbackHours,
                limit: this.config.graphIndexLimit,
                snapshotLimit: this.config.graphSnapshotLimit
            });
            run.graphIndex = graphIndex;

            const audit = this.services.audit({
                projectId,
                limit: this.config.auditLimit,
                maxIssues: this.config.auditMaxIssues
            });
            run.audit = summarizeAudit(audit);

            const dryRunBackfill = this.services.backfill({
                projectId,
                limit: this.config.backfillLimit,
                dryRun: true
            });
            run.dryRunBackfill = dryRunBackfill;

            const decision = evaluateSessionResurrectionApplyDecision({
                config: this.config,
                audit,
                dryRun: dryRunBackfill,
                ingestion,
                dryRunOnly
            });
            run.decision = decision;

            if (decision.allowApply) {
                const applyBackfill = this.services.backfill({
                    projectId,
                    limit: decision.applyLimit,
                    dryRun: false
                });

                run.applyBackfill = applyBackfill;
                run.outcome = applyBackfill.compacted > 0 ? "applied" : "indexed";
            } else {
                run.outcome = "indexed";
            }

            this.services.log("info", "Session-resurrection run finished.", {
                runId: run.runId,
                trigger: run.trigger,
                outcome: run.outcome,
                filesScanned: run.ingestion.filesScanned,
                chatFilesScanned: run.ingestion.chatFilesScanned,
                graphNodesUpserted: run.graphIndex.nodesUpserted,
                graphEdgesUpserted: run.graphIndex.edgesUpserted,
                dryRunCompacted: run.dryRunBackfill?.compacted ?? 0,
                applyCompacted: run.applyBackfill?.compacted ?? 0,
                reasons: run.decision.reasons
            });
        } catch (error) {
            run.outcome = "error";
            run.error = error instanceof Error ? error.message : String(error);

            this.services.log("error", "Session-resurrection run failed.", {
                runId: run.runId,
                trigger: run.trigger,
                error: run.error
            });
        } finally {
            run.completedAt = this.services.now();
            run.durationMs = Math.max(0, run.completedAt - run.startedAt);

            this.running = false;
            this.pushRun(run);

            if (options.reschedule) {
                this.scheduleNext();
            }
        }

        return run;
    }
}

export function createSessionResurrectionScheduler(
    config: SessionResurrectionConfig = readSessionResurrectionConfigFromEnv(),
    services?: Partial<SessionResurrectionServices>
): SessionResurrectionScheduler {
    return new SessionResurrectionScheduler(config, services);
}
