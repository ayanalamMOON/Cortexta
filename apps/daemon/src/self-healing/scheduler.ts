import {
    auditMemoryResurrection,
    backfillMemoryCompaction
} from "../../../../core/mempalace/memory.service";
import type {
    BackfillMemoryCompactionResult,
    MemoryResurrectionAuditReport
} from "../../../../core/mempalace/memory.types";
import { connectSqlite, initializeSqlite, type SqliteDatabase } from "../../../../storage/sqlite/db";

export type SelfHealingTrigger = "scheduled" | "manual" | "startup";
export type SelfHealingRunOutcome = "applied" | "dry-run-only" | "skipped" | "error";

interface SelfHealingOutcomeCounters {
    total: number;
    applied: number;
    dryRunOnly: number;
    skipped: number;
    error: number;
}

export interface SelfHealingSloWindowCounters extends SelfHealingOutcomeCounters {
    windowMinutes: number;
    windowMs: number;
    sinceMs: number;
    successRate: number;
    errorRate: number;
    applyRate: number;
}

export interface SelfHealingSloSnapshot {
    generatedAt: number;
    windows: SelfHealingSloWindowCounters[];
}

interface SelfHealingPersistedHistorySnapshot {
    totalRuns: number;
    recentRuns: SelfHealingRunReport[];
    consecutiveFailures: number;
}

export interface SelfHealingConfig {
    enabled: boolean;
    projectId?: string;
    intervalMs: number;
    jitterMs: number;
    runOnStart: boolean;
    auditLimit: number;
    auditMaxIssues: number;
    backfillLimit: number;
    applyEnabled: boolean;
    maxAllowedAnomalies: number;
    minCompactionOpportunityRate: number;
    minDryRunCompactedRows: number;
    maxApplyRows: number;
    applyWindowStartHour: number;
    applyWindowEndHour: number;
    historyLimit: number;
    persistHistory: boolean;
    persistedHistoryLimit: number;
    backoffEnabled: boolean;
    backoffMultiplier: number;
    maxBackoffIntervalMs: number;
    sloWindowsMinutes: number[];
}

export interface SelfHealingRunOptions {
    dryRunOnly?: boolean;
    reason?: string;
}

export interface SelfHealingApplyDecision {
    allowApply: boolean;
    applyLimit: number;
    reasons: string[];
}

export interface SelfHealingRunReport {
    runId: string;
    trigger: SelfHealingTrigger;
    reason?: string;
    dryRunOnly: boolean;
    startedAt: number;
    completedAt: number;
    durationMs: number;
    outcome: SelfHealingRunOutcome;
    decision: SelfHealingApplyDecision;
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

export interface SelfHealingStatus {
    enabled: boolean;
    started: boolean;
    running: boolean;
    nextRunAt?: number;
    lastScheduledDelayMs?: number;
    consecutiveFailures: number;
    runCount: number;
    config: SelfHealingConfig;
    lastRun?: SelfHealingRunReport;
    recentRuns: SelfHealingRunReport[];
    slo: SelfHealingSloSnapshot;
}

export interface SelfHealingRunLifecycleState {
    consecutiveFailures: number;
    runCount: number;
}

export interface SelfHealingServices {
    audit: (options: { projectId?: string; limit?: number; maxIssues?: number }) => MemoryResurrectionAuditReport;
    backfill: (options: { projectId?: string; limit?: number; dryRun?: boolean }) => BackfillMemoryCompactionResult;
    loadHistory: (options: { projectId?: string; historyLimit: number }) => SelfHealingPersistedHistorySnapshot;
    persistRun: (options: { projectId?: string; run: SelfHealingRunReport; retentionLimit: number }) => void;
    countOutcomesSince: (options: { projectId?: string; sinceMs: number }) => SelfHealingOutcomeCounters;
    now: () => number;
    random: () => number;
    log: (level: "info" | "warn" | "error", message: string, payload?: Record<string, unknown>) => void;
    onRunCompleted: (run: SelfHealingRunReport, state: SelfHealingRunLifecycleState) => void;
}

const DEFAULT_CONFIG: SelfHealingConfig = {
    enabled: false,
    projectId: undefined,
    intervalMs: 30 * 60 * 1000,
    jitterMs: 60 * 1000,
    runOnStart: false,
    auditLimit: 5000,
    auditMaxIssues: 20,
    backfillLimit: 5000,
    applyEnabled: false,
    maxAllowedAnomalies: 0,
    minCompactionOpportunityRate: 0.2,
    minDryRunCompactedRows: 50,
    maxApplyRows: 2000,
    applyWindowStartHour: 1,
    applyWindowEndHour: 5,
    historyLimit: 50,
    persistHistory: true,
    persistedHistoryLimit: 2000,
    backoffEnabled: true,
    backoffMultiplier: 2,
    maxBackoffIntervalMs: 6 * 60 * 60 * 1000,
    sloWindowsMinutes: [60, 24 * 60, 7 * 24 * 60]
};

const HISTORY_SCOPE_ALL_PROJECTS = "__all_projects__";
const HISTORY_RETENTION_MAX = 50_000;

let historyDb: SqliteDatabase | null = null;
let historyDbInitialized = false;

function createEmptyOutcomeCounters(): SelfHealingOutcomeCounters {
    return {
        total: 0,
        applied: 0,
        dryRunOnly: 0,
        skipped: 0,
        error: 0
    };
}

function outcomeFromUnknown(value: unknown): SelfHealingRunOutcome | undefined {
    if (value === "applied" || value === "dry-run-only" || value === "skipped" || value === "error") {
        return value;
    }

    return undefined;
}

function incrementOutcomeCounter(counters: SelfHealingOutcomeCounters, outcome: SelfHealingRunOutcome): void {
    counters.total += 1;

    if (outcome === "applied") {
        counters.applied += 1;
        return;
    }

    if (outcome === "dry-run-only") {
        counters.dryRunOnly += 1;
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

function resolveHistoryScope(projectId?: string): string {
    return projectId?.trim() || HISTORY_SCOPE_ALL_PROJECTS;
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

function parseRunPayload(payload: unknown): SelfHealingRunReport | undefined {
    if (typeof payload !== "string" || !payload.trim()) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(payload) as Partial<SelfHealingRunReport>;
        if (typeof parsed.runId !== "string") {
            return undefined;
        }

        const outcome = outcomeFromUnknown(parsed.outcome);
        if (!outcome) {
            return undefined;
        }

        if (parsed.trigger !== "scheduled" && parsed.trigger !== "manual" && parsed.trigger !== "startup") {
            return undefined;
        }

        return {
            runId: parsed.runId,
            trigger: parsed.trigger,
            reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
            dryRunOnly: parsed.dryRunOnly === true,
            startedAt: Number(parsed.startedAt ?? 0),
            completedAt: Number(parsed.completedAt ?? 0),
            durationMs: Number(parsed.durationMs ?? 0),
            outcome,
            decision: {
                allowApply: parsed.decision?.allowApply === true,
                applyLimit: Number(parsed.decision?.applyLimit ?? 0),
                reasons: Array.isArray(parsed.decision?.reasons)
                    ? parsed.decision?.reasons
                        .map((reason) => String(reason))
                        .filter((reason) => reason.trim().length > 0)
                    : []
            },
            audit: parsed.audit,
            dryRunBackfill: parsed.dryRunBackfill,
            applyBackfill: parsed.applyBackfill,
            error: typeof parsed.error === "string" ? parsed.error : undefined
        };
    } catch {
        return undefined;
    }
}

function computeConsecutiveFailuresFromRuns(runs: SelfHealingRunReport[]): number {
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

function loadPersistedHistory(options: { projectId?: string; historyLimit: number }): SelfHealingPersistedHistorySnapshot {
    const db = getHistoryDb();
    const scope = resolveHistoryScope(options.projectId);

    const totalRow = db
        .prepare(
            `
            SELECT COUNT(1) AS total
            FROM self_healing_run_history
            WHERE schedulerScope = ?
          `
        )
        .get<{ total?: number }>(scope);

    const rows = db
        .prepare(
            `
            SELECT payload
            FROM self_healing_run_history
            WHERE schedulerScope = ?
            ORDER BY startedAt DESC
            LIMIT ?
          `
        )
        .all<Record<string, unknown>>(scope, options.historyLimit);

    const recentRuns = rows
        .map((row) => parseRunPayload(row.payload))
        .filter((run): run is SelfHealingRunReport => Boolean(run));

    return {
        totalRuns: Math.max(0, Number(totalRow?.total ?? 0)),
        recentRuns,
        consecutiveFailures: computeConsecutiveFailuresFromRuns(recentRuns)
    };
}

function persistRunToHistory(options: { projectId?: string; run: SelfHealingRunReport; retentionLimit: number }): void {
    const db = getHistoryDb();
    const scope = resolveHistoryScope(options.projectId);
    const payload = JSON.stringify(options.run);

    db.prepare(
        `
        INSERT OR REPLACE INTO self_healing_run_history (
            id,
            schedulerScope,
            projectId,
            trigger,
            outcome,
            dryRunOnly,
            reason,
            startedAt,
            completedAt,
            durationMs,
            payload,
            createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
        options.run.runId,
        scope,
        options.projectId ?? null,
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
            FROM self_healing_run_history
            WHERE schedulerScope = ?
            ORDER BY startedAt DESC
            LIMIT -1 OFFSET ?
          `
        )
        .all<Record<string, unknown>>(scope, retentionLimit);

    if (staleRows.length === 0) {
        return;
    }

    const staleIds = staleRows.map((row) => String(row.id ?? "")).filter(Boolean);
    for (const batch of chunkStrings(staleIds, 900)) {
        const placeholders = batch.map(() => "?").join(",");
        db.prepare(`DELETE FROM self_healing_run_history WHERE id IN (${placeholders})`).run(...batch);
    }
}

function countPersistedOutcomesSince(options: { projectId?: string; sinceMs: number }): SelfHealingOutcomeCounters {
    const db = getHistoryDb();
    const scope = resolveHistoryScope(options.projectId);

    const rows = db
        .prepare(
            `
            SELECT outcome, COUNT(1) AS total
            FROM self_healing_run_history
            WHERE schedulerScope = ?
              AND startedAt >= ?
            GROUP BY outcome
          `
        )
        .all<Record<string, unknown>>(scope, options.sinceMs);

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
        if (outcome === "applied") {
            counters.applied += count;
            continue;
        }

        if (outcome === "dry-run-only") {
            counters.dryRunOnly += count;
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

function normalizeProjectId(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed || undefined;
}

function defaultLog(level: "info" | "warn" | "error", message: string, payload?: Record<string, unknown>): void {
    if (payload) {
        console[level](`[cortexa:self-heal] ${message}`, payload);
        return;
    }

    console[level](`[cortexa:self-heal] ${message}`);
}

export function readSelfHealingConfigFromEnv(): SelfHealingConfig {
    const intervalMs = parseBoundedInt(
        readEnv("CORTEXA_SELF_HEAL_INTERVAL_MS"),
        DEFAULT_CONFIG.intervalMs,
        30_000,
        24 * 60 * 60 * 1000
    );
    const historyLimit = parseBoundedInt(readEnv("CORTEXA_SELF_HEAL_HISTORY_LIMIT"), DEFAULT_CONFIG.historyLimit, 1, 500);
    const persistedHistoryLimit = parseBoundedInt(
        readEnv("CORTEXA_SELF_HEAL_PERSISTED_HISTORY_LIMIT"),
        DEFAULT_CONFIG.persistedHistoryLimit,
        historyLimit,
        HISTORY_RETENTION_MAX
    );
    const maxBackoffFallback = Math.min(24 * 60 * 60 * 1000, Math.max(intervalMs, intervalMs * 8));

    return {
        enabled: parseBoolean(readEnv("CORTEXA_SELF_HEAL_ENABLED"), DEFAULT_CONFIG.enabled),
        projectId: normalizeProjectId(readEnv("CORTEXA_SELF_HEAL_PROJECT_ID")),
        intervalMs,
        jitterMs: parseBoundedInt(
            readEnv("CORTEXA_SELF_HEAL_JITTER_MS"),
            DEFAULT_CONFIG.jitterMs,
            0,
            60 * 60 * 1000
        ),
        runOnStart: parseBoolean(readEnv("CORTEXA_SELF_HEAL_RUN_ON_START"), DEFAULT_CONFIG.runOnStart),
        auditLimit: parseBoundedInt(readEnv("CORTEXA_SELF_HEAL_AUDIT_LIMIT"), DEFAULT_CONFIG.auditLimit, 1, 50_000),
        auditMaxIssues: parseBoundedInt(
            readEnv("CORTEXA_SELF_HEAL_AUDIT_MAX_ISSUES"),
            DEFAULT_CONFIG.auditMaxIssues,
            0,
            100
        ),
        backfillLimit: parseBoundedInt(
            readEnv("CORTEXA_SELF_HEAL_BACKFILL_LIMIT"),
            DEFAULT_CONFIG.backfillLimit,
            1,
            20_000
        ),
        applyEnabled: parseBoolean(readEnv("CORTEXA_SELF_HEAL_APPLY_ENABLED"), DEFAULT_CONFIG.applyEnabled),
        maxAllowedAnomalies: parseBoundedInt(
            readEnv("CORTEXA_SELF_HEAL_MAX_ALLOWED_ANOMALIES"),
            DEFAULT_CONFIG.maxAllowedAnomalies,
            0,
            10_000
        ),
        minCompactionOpportunityRate: parseBoundedNumber(
            readEnv("CORTEXA_SELF_HEAL_MIN_OPPORTUNITY_RATE"),
            DEFAULT_CONFIG.minCompactionOpportunityRate,
            0,
            1
        ),
        minDryRunCompactedRows: parseBoundedInt(
            readEnv("CORTEXA_SELF_HEAL_MIN_DRY_RUN_COMPACTED_ROWS"),
            DEFAULT_CONFIG.minDryRunCompactedRows,
            0,
            20_000
        ),
        maxApplyRows: parseBoundedInt(
            readEnv("CORTEXA_SELF_HEAL_MAX_APPLY_ROWS"),
            DEFAULT_CONFIG.maxApplyRows,
            1,
            20_000
        ),
        applyWindowStartHour: parseBoundedInt(
            readEnv("CORTEXA_SELF_HEAL_APPLY_WINDOW_START_HOUR"),
            DEFAULT_CONFIG.applyWindowStartHour,
            0,
            23
        ),
        applyWindowEndHour: parseBoundedInt(
            readEnv("CORTEXA_SELF_HEAL_APPLY_WINDOW_END_HOUR"),
            DEFAULT_CONFIG.applyWindowEndHour,
            0,
            23
        ),
        historyLimit,
        persistHistory: parseBoolean(readEnv("CORTEXA_SELF_HEAL_PERSIST_HISTORY"), DEFAULT_CONFIG.persistHistory),
        persistedHistoryLimit,
        backoffEnabled: parseBoolean(readEnv("CORTEXA_SELF_HEAL_BACKOFF_ENABLED"), DEFAULT_CONFIG.backoffEnabled),
        backoffMultiplier: parseBoundedNumber(
            readEnv("CORTEXA_SELF_HEAL_BACKOFF_MULTIPLIER"),
            DEFAULT_CONFIG.backoffMultiplier,
            1.1,
            8
        ),
        maxBackoffIntervalMs: parseBoundedInt(
            readEnv("CORTEXA_SELF_HEAL_BACKOFF_MAX_INTERVAL_MS"),
            maxBackoffFallback,
            intervalMs,
            24 * 60 * 60 * 1000
        ),
        sloWindowsMinutes: parseSloWindowMinutes(
            readEnv("CORTEXA_SELF_HEAL_SLO_WINDOWS_MINUTES"),
            DEFAULT_CONFIG.sloWindowsMinutes
        )
    };
}

function defaultServices(): SelfHealingServices {
    return {
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

export function isWithinApplyWindow(nowMs: number, startHour: number, endHour: number): boolean {
    const hour = new Date(nowMs).getHours();

    if (startHour === endHour) {
        return true;
    }

    if (startHour < endHour) {
        return hour >= startHour && hour < endHour;
    }

    return hour >= startHour || hour < endHour;
}

export function evaluateSelfHealingApplyDecision(params: {
    config: SelfHealingConfig;
    audit: MemoryResurrectionAuditReport;
    dryRun: BackfillMemoryCompactionResult;
    nowMs: number;
    dryRunOnly?: boolean;
}): SelfHealingApplyDecision {
    const reasons: string[] = [];

    if (params.dryRunOnly) {
        reasons.push("Manual dry-run only mode requested.");
    }

    if (!params.config.applyEnabled) {
        reasons.push("Apply mode is disabled by configuration.");
    }

    if (params.audit.anomalies.total > params.config.maxAllowedAnomalies) {
        reasons.push(
            `Anomaly guardrail blocked apply (${params.audit.anomalies.total} > ${params.config.maxAllowedAnomalies}).`
        );
    }

    if (params.audit.compactionOpportunityRate < params.config.minCompactionOpportunityRate) {
        reasons.push(
            `Compaction opportunity below threshold (${params.audit.compactionOpportunityRate.toFixed(4)} < ${params.config.minCompactionOpportunityRate.toFixed(4)}).`
        );
    }

    if (params.dryRun.compacted < params.config.minDryRunCompactedRows) {
        reasons.push(
            `Dry-run compacted rows below threshold (${params.dryRun.compacted} < ${params.config.minDryRunCompactedRows}).`
        );
    }

    if (!isWithinApplyWindow(params.nowMs, params.config.applyWindowStartHour, params.config.applyWindowEndHour)) {
        reasons.push(
            `Current time is outside apply window [${params.config.applyWindowStartHour}:00-${params.config.applyWindowEndHour}:00).`
        );
    }

    const applyLimit = Math.min(params.config.backfillLimit, params.config.maxApplyRows);
    if (applyLimit <= 0) {
        reasons.push("Apply limit resolved to 0 rows.");
    }

    return {
        allowApply: reasons.length === 0,
        applyLimit: Math.max(0, applyLimit),
        reasons
    };
}

interface ExecuteOptions {
    reschedule: boolean;
    runOptions?: SelfHealingRunOptions;
}

export class SelfHealingScheduler {
    private readonly services: SelfHealingServices;
    private readonly config: SelfHealingConfig;

    private started = false;
    private running = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private nextRunAt: number | undefined;
    private lastScheduledDelayMs: number | undefined;
    private consecutiveFailures = 0;
    private runCount = 0;
    private runSequence = 0;
    private lastRun: SelfHealingRunReport | undefined;
    private readonly recentRuns: SelfHealingRunReport[] = [];

    constructor(config: SelfHealingConfig, services?: Partial<SelfHealingServices>) {
        this.config = {
            ...config,
            sloWindowsMinutes: [...config.sloWindowsMinutes]
        };
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
            this.services.log("info", "Self-healing scheduler is disabled.", {
                enabled: this.config.enabled
            });
            return;
        }

        this.services.log("info", "Starting self-healing scheduler.", {
            intervalMs: this.config.intervalMs,
            jitterMs: this.config.jitterMs,
            runOnStart: this.config.runOnStart,
            projectId: this.config.projectId ?? "all",
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

    getStatus(): SelfHealingStatus {
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

    async triggerNow(runOptions: SelfHealingRunOptions = {}): Promise<SelfHealingRunReport> {
        return this.execute("manual", {
            reschedule: false,
            runOptions
        });
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
            this.services.log("warn", "Self-healing scheduler backoff is active due to recent failures.", {
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
        return `selfheal_${nowMs.toString(36)}_${this.runSequence.toString(36)}`;
    }

    private summarizeAudit(report: MemoryResurrectionAuditReport): SelfHealingRunReport["audit"] {
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

    private hydratePersistedState(): void {
        if (!this.config.persistHistory) {
            return;
        }

        try {
            const snapshot = this.services.loadHistory({
                projectId: this.config.projectId,
                historyLimit: this.config.historyLimit
            });

            this.runCount = Math.max(0, Math.trunc(snapshot.totalRuns));
            this.runSequence = Math.max(this.runSequence, this.runCount);
            this.consecutiveFailures = Math.max(0, Math.trunc(snapshot.consecutiveFailures));

            this.recentRuns.length = 0;
            this.recentRuns.push(...snapshot.recentRuns.slice(0, this.config.historyLimit));
            this.lastRun = this.recentRuns[0];
        } catch (error) {
            this.services.log("warn", "Failed to hydrate persisted self-healing run history; continuing in-memory only.", {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private persistRun(run: SelfHealingRunReport): void {
        if (!this.config.persistHistory) {
            return;
        }

        try {
            this.services.persistRun({
                projectId: this.config.projectId,
                run,
                retentionLimit: this.config.persistedHistoryLimit
            });
        } catch (error) {
            this.services.log("warn", "Failed to persist self-healing run history row.", {
                runId: run.runId,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private updateFailureState(run: SelfHealingRunReport): void {
        if (run.outcome === "error") {
            this.consecutiveFailures += 1;
            return;
        }

        if (run.outcome === "skipped") {
            return;
        }

        this.consecutiveFailures = 0;
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

    private countOutcomesSince(sinceMs: number): SelfHealingOutcomeCounters {
        if (this.config.persistHistory) {
            try {
                return this.services.countOutcomesSince({
                    projectId: this.config.projectId,
                    sinceMs
                });
            } catch (error) {
                this.services.log("warn", "Failed to read persisted self-healing SLO counters; falling back to in-memory history.", {
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

    private buildSloSnapshot(nowMs: number): SelfHealingSloSnapshot {
        const windows = this.config.sloWindowsMinutes.map((windowMinutes) => {
            const windowMs = windowMinutes * 60 * 1000;
            const sinceMs = nowMs - windowMs;
            const counters = this.countOutcomesSince(sinceMs);
            const successCount = counters.total - counters.error;

            return {
                ...counters,
                windowMinutes,
                windowMs,
                sinceMs,
                successRate: counters.total > 0 ? successCount / counters.total : 1,
                errorRate: counters.total > 0 ? counters.error / counters.total : 0,
                applyRate: counters.total > 0 ? counters.applied / counters.total : 0
            };
        });

        return {
            generatedAt: nowMs,
            windows
        };
    }

    private pushRun(run: SelfHealingRunReport): void {
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
            this.services.log("warn", "self-healing lifecycle callback failed", {
                runId: run.runId,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private async execute(trigger: SelfHealingTrigger, options: ExecuteOptions): Promise<SelfHealingRunReport> {
        const nowMs = this.services.now();
        const runId = this.buildRunId(nowMs);

        if (this.running) {
            const skipped: SelfHealingRunReport = {
                runId,
                trigger,
                reason: options.runOptions?.reason,
                dryRunOnly: options.runOptions?.dryRunOnly === true,
                startedAt: nowMs,
                completedAt: nowMs,
                durationMs: 0,
                outcome: "skipped",
                decision: {
                    allowApply: false,
                    applyLimit: 0,
                    reasons: ["Another self-healing run is already in progress."]
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

        const run: SelfHealingRunReport = {
            runId,
            trigger,
            reason: options.runOptions?.reason,
            dryRunOnly,
            startedAt,
            completedAt: startedAt,
            durationMs: 0,
            outcome: "dry-run-only",
            decision: {
                allowApply: false,
                applyLimit: 0,
                reasons: []
            }
        };

        try {
            const audit = this.services.audit({
                projectId: this.config.projectId,
                limit: this.config.auditLimit,
                maxIssues: this.config.auditMaxIssues
            });
            run.audit = this.summarizeAudit(audit);

            const dryRunBackfill = this.services.backfill({
                projectId: this.config.projectId,
                limit: this.config.backfillLimit,
                dryRun: true
            });
            run.dryRunBackfill = dryRunBackfill;

            const decision = evaluateSelfHealingApplyDecision({
                config: this.config,
                audit,
                dryRun: dryRunBackfill,
                nowMs: this.services.now(),
                dryRunOnly
            });
            run.decision = decision;

            if (!decision.allowApply) {
                run.outcome = "dry-run-only";
            } else {
                const applyBackfill = this.services.backfill({
                    projectId: this.config.projectId,
                    limit: decision.applyLimit,
                    dryRun: false
                });
                run.applyBackfill = applyBackfill;
                run.outcome = applyBackfill.compacted > 0 ? "applied" : "dry-run-only";
            }

            this.services.log("info", "Self-healing run finished.", {
                runId: run.runId,
                trigger: run.trigger,
                outcome: run.outcome,
                dryRunCompacted: run.dryRunBackfill?.compacted ?? 0,
                applyCompacted: run.applyBackfill?.compacted ?? 0,
                reasons: run.decision.reasons
            });
        } catch (error) {
            run.outcome = "error";
            run.error = error instanceof Error ? error.message : String(error);

            this.services.log("error", "Self-healing run failed.", {
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

export function createSelfHealingScheduler(
    config: SelfHealingConfig = readSelfHealingConfigFromEnv(),
    services?: Partial<SelfHealingServices>
): SelfHealingScheduler {
    return new SelfHealingScheduler(config, services);
}
