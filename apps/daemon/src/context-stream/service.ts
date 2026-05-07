import fs from "node:fs";
import path from "node:path";
import { compileContext } from "../../../../core/context/compiler";
import { buildProactiveContextSuggestion, shouldEmitProactiveSuggestion } from "../../../../core/context/proactive";
import { getMemoryCompactionStats } from "../../../../core/mempalace/memory.service";
import { resolveProjectRisk } from "../../../../core/mempalace/risk";
import { extractEntitiesFromFile } from "../../../../packages/core/src/ast/extractor";
import { startWatcher, type WatcherEvent, type WatcherHandle } from "../../../../packages/core/src/ast/watcher";
import { sha256 } from "../../../../packages/core/src/utils/hash";
import { randomId } from "../../../../packages/core/src/utils/ids";
import {
    recordContextStreamEventMetric,
    recordContextStreamSuppressionMetric,
    setContextStreamActiveStreams
} from "../observability/metrics";
import { emitDaemonStreamEvent } from "../stream/events";

interface ContextStreamConfig {
    debounceMs: number;
    minConfidence: number;
    maxSuggestionsPerMinute: number;
    topK: number;
    maxTokens: number;
    previewChars: number;
    suggestionTtlMs: number;
    dedupeWindowMs: number;
    includeUnknownLanguages: boolean;
    suppressOnCriticalRisk: boolean;
}

interface ContextStreamStartInput {
    rootPath: string;
    projectId: string;
    branch: string;
    config?: Partial<ContextStreamConfig>;
}

interface ContextStreamEventPayload {
    eventId: string;
    suggestionHash: string;
    projectId: string;
    branch: string;
    sourcePath: string;
    sourceScope: string;
    fileKind?: string;
    matchedEntities?: string[];
    reason: string;
    confidence: number;
    topK: number;
    maxTokens: number;
    memoryIds: string[];
    contextPreview: string;
    context: string;
    createdAt: number;
    expiresAt: number;
    suppressionReason?: string;
}

interface ContextStreamSuggestionRecord {
    payload: ContextStreamEventPayload;
    timeout?: NodeJS.Timeout;
}

interface ContextStreamRuntime {
    id: string;
    rootPath: string;
    projectId: string;
    branch: string;
    watcher: WatcherHandle;
    config: ContextStreamConfig;
    createdAt: number;
    lastEventAt?: number;
    lastSuggestionAt?: number;
    lastSuppressedAt?: number;
    debounceTimer?: NodeJS.Timeout;
    processing: boolean;
    pendingEvents: WatcherEvent[];
    recentSuggestionHashes: Map<string, number>;
    recentSuggestionWindow: number[];
    activeSuggestions: Map<string, ContextStreamSuggestionRecord>;
    processedEvents: number;
    lastSuggestionHash?: string;
    lastSuppressionReason?: string;
}

interface ContextStreamStatusItem {
    id: string;
    rootPath: string;
    projectId: string;
    branch: string;
    createdAt: number;
    lastEventAt?: number;
    lastSuggestionAt?: number;
    lastSuppressedAt?: number;
    activeSuggestions: number;
    queuedEvents: number;
    processedEvents: number;
    lastSuggestionHash?: string;
    lastSuppressionReason?: string;
}

interface ContextStreamStatus {
    enabled: boolean;
    running: boolean;
    streams: ContextStreamStatusItem[];
}

export interface ContextStreamControllerApi {
    start(input: ContextStreamStartInput): Promise<ContextStreamStatusItem>;
    stop(projectId: string, branch?: string): Promise<boolean>;
    stopAll(): Promise<void>;
    status(): ContextStreamStatus;
    ack(input: {
        projectId: string;
        branch?: string;
        suggestionHash: string;
        action: "ack" | "applied" | "suppressed";
        reason?: string;
    }): Promise<ContextStreamEventPayload | undefined>;
    autoStartFromEnv(): Promise<ContextStreamStatusItem | null>;
}

const DEFAULT_CONFIG: ContextStreamConfig = {
    debounceMs: 1400,
    minConfidence: 0.6,
    maxSuggestionsPerMinute: 6,
    topK: 10,
    maxTokens: 1800,
    previewChars: 1400,
    suggestionTtlMs: 60_000,
    dedupeWindowMs: 20_000,
    includeUnknownLanguages: false,
    suppressOnCriticalRisk: true
};

const MAIN_BRANCH = "main";

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

function toBoundedNumber(value: unknown, fallback: number, min: number, max: number): number {
    const numeric = typeof value === "string" ? Number(value) : value;
    if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, numeric));
}

function toBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
    return Math.trunc(toBoundedNumber(value, fallback, min, max));
}

function toBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["1", "true", "yes", "on"].includes(normalized)) return true;
        if (["0", "false", "no", "off"].includes(normalized)) return false;
    }
    return fallback;
}

function normalizeBranch(value?: string): string {
    const trimmed = (value ?? "").trim();
    return trimmed || MAIN_BRANCH;
}

function resolveConfig(overrides?: Partial<ContextStreamConfig>): ContextStreamConfig {
    return {
        debounceMs: toBoundedInt(overrides?.debounceMs ?? readEnv("CORTEXA_CONTEXT_STREAM_DEBOUNCE_MS"), DEFAULT_CONFIG.debounceMs, 250, 20_000),
        minConfidence: toBoundedNumber(overrides?.minConfidence ?? readEnv("CORTEXA_CONTEXT_STREAM_MIN_CONFIDENCE"), DEFAULT_CONFIG.minConfidence, 0.1, 1),
        maxSuggestionsPerMinute: toBoundedInt(
            overrides?.maxSuggestionsPerMinute ?? readEnv("CORTEXA_CONTEXT_STREAM_MAX_PER_MIN"),
            DEFAULT_CONFIG.maxSuggestionsPerMinute,
            1,
            120
        ),
        topK: toBoundedInt(overrides?.topK ?? readEnv("CORTEXA_CONTEXT_STREAM_TOPK"), DEFAULT_CONFIG.topK, 1, 40),
        maxTokens: toBoundedInt(overrides?.maxTokens ?? readEnv("CORTEXA_CONTEXT_STREAM_MAX_TOKENS"), DEFAULT_CONFIG.maxTokens, 256, 12_000),
        previewChars: toBoundedInt(overrides?.previewChars ?? readEnv("CORTEXA_CONTEXT_STREAM_PREVIEW_CHARS"), DEFAULT_CONFIG.previewChars, 240, 8_000),
        suggestionTtlMs: toBoundedInt(
            overrides?.suggestionTtlMs ?? readEnv("CORTEXA_CONTEXT_STREAM_TTL_MS"),
            DEFAULT_CONFIG.suggestionTtlMs,
            5_000,
            300_000
        ),
        dedupeWindowMs: toBoundedInt(
            overrides?.dedupeWindowMs ?? readEnv("CORTEXA_CONTEXT_STREAM_DEDUPE_MS"),
            DEFAULT_CONFIG.dedupeWindowMs,
            2_000,
            120_000
        ),
        includeUnknownLanguages: toBoolean(
            overrides?.includeUnknownLanguages ?? readEnv("CORTEXA_CONTEXT_STREAM_INCLUDE_UNKNOWN"),
            DEFAULT_CONFIG.includeUnknownLanguages
        ),
        suppressOnCriticalRisk: toBoolean(
            overrides?.suppressOnCriticalRisk ?? readEnv("CORTEXA_CONTEXT_STREAM_SUPPRESS_ON_RISK"),
            DEFAULT_CONFIG.suppressOnCriticalRisk
        )
    };
}

function resolveRootPath(inputPath: string): string {
    const resolved = path.resolve(inputPath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`Context stream root path does not exist: ${resolved}`);
    }
    return resolved;
}

function buildStreamKey(projectId: string, branch: string): string {
    return `${projectId}::${branch}`;
}

function buildEventQuery(
    event: WatcherEvent,
    projectId: string,
    rootPath: string
): { query: string; sourcePath: string; fileKind?: string; matchedEntities: string[] } {
    const relative = path.relative(rootPath, event.filePath);
    const sourcePath = relative.startsWith("..") ? event.filePath : relative.replace(/\\/g, "/");
    const fileLabel = sourcePath.split("/").slice(-1)[0] ?? path.basename(event.filePath);

    let entityNames: string[] = [];
    let fileKind: string | undefined;
    try {
        const extracted = extractEntitiesFromFile(event.filePath, projectId);
        fileKind = extracted.language || undefined;
        entityNames = extracted.entities.map((entity) => entity.name).filter(Boolean).slice(0, 4);
    } catch {
        entityNames = [];
    }

    const entityHint = entityNames.length > 0 ? `symbols ${entityNames.join(", ")}` : "file";
    const verb = event.type === "add" ? "new file" : event.type === "unlink" ? "removed file" : "file change";
    const query = `${verb} in ${fileLabel}; review ${entityHint}`.trim();

    return { query: query.slice(0, 400), sourcePath, fileKind, matchedEntities: entityNames };
}

function trimPreview(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function cleanSuggestionWindow(window: number[], now: number, windowMs: number): number[] {
    return window.filter((timestamp) => now - timestamp <= windowMs);
}

class ContextStreamController implements ContextStreamControllerApi {
    private readonly streams = new Map<string, ContextStreamRuntime>();

    async start(input: ContextStreamStartInput): Promise<ContextStreamStatusItem> {
        const projectId = input.projectId.trim() || "default";
        const branch = normalizeBranch(input.branch);
        const rootPath = resolveRootPath(input.rootPath);
        const config = resolveConfig(input.config);
        const key = buildStreamKey(projectId, branch);

        await this.stop(projectId, branch);

        const watcher = startWatcher(
            rootPath,
            (event) => this.handleWatcherEvent(key, event),
            { includeUnknownLanguages: config.includeUnknownLanguages }
        );

        const runtime: ContextStreamRuntime = {
            id: randomId("ctx_stream"),
            rootPath,
            projectId,
            branch,
            watcher,
            config,
            createdAt: Date.now(),
            processing: false,
            pendingEvents: [],
            recentSuggestionHashes: new Map<string, number>(),
            recentSuggestionWindow: [],
            activeSuggestions: new Map<string, ContextStreamSuggestionRecord>(),
            processedEvents: 0
        };

        this.streams.set(key, runtime);
        setContextStreamActiveStreams(this.streams.size);

        return this.buildStatusItem(runtime);
    }

    async stop(projectId: string, branch?: string): Promise<boolean> {
        const key = buildStreamKey(projectId.trim() || "default", normalizeBranch(branch));
        const runtime = this.streams.get(key);
        if (!runtime) {
            return false;
        }

        if (runtime.debounceTimer) {
            clearTimeout(runtime.debounceTimer);
            runtime.debounceTimer = undefined;
        }

        for (const record of runtime.activeSuggestions.values()) {
            if (record.timeout) {
                clearTimeout(record.timeout);
            }
        }

        runtime.activeSuggestions.clear();
        runtime.pendingEvents = [];

        await runtime.watcher.close();
        this.streams.delete(key);
        setContextStreamActiveStreams(this.streams.size);
        return true;
    }

    async stopAll(): Promise<void> {
        const keys = [...this.streams.keys()];
        for (const key of keys) {
            const runtime = this.streams.get(key);
            if (!runtime) continue;
            await this.stop(runtime.projectId, runtime.branch);
        }
    }

    status(): ContextStreamStatus {
        const streams = [...this.streams.values()].map((runtime) => this.buildStatusItem(runtime));
        return {
            enabled: this.isAutoStartEnabled(),
            running: streams.length > 0,
            streams
        };
    }

    async ack(input: {
        projectId: string;
        branch?: string;
        suggestionHash: string;
        action: "ack" | "applied" | "suppressed";
        reason?: string;
    }): Promise<ContextStreamEventPayload | undefined> {
        const key = buildStreamKey(input.projectId.trim() || "default", normalizeBranch(input.branch));
        const runtime = this.streams.get(key);
        if (!runtime) {
            return undefined;
        }

        const record = runtime.activeSuggestions.get(input.suggestionHash);
        if (!record) {
            return undefined;
        }

        const payload = record.payload;
        const action = input.action;
        const reason = input.reason ?? "client_ack";

        if (action === "applied") {
            emitDaemonStreamEvent({
                projectId: payload.projectId,
                eventType: "contextDeltaApplied",
                payload: {
                    ...payload,
                    reason
                }
            });
            recordContextStreamEventMetric("contextDeltaApplied");
            runtime.activeSuggestions.delete(input.suggestionHash);
        } else if (action === "suppressed") {
            emitDaemonStreamEvent({
                projectId: payload.projectId,
                eventType: "contextDeltaSuppressed",
                payload: {
                    ...payload,
                    suppressionReason: reason
                }
            });
            recordContextStreamSuppressionMetric(reason);
            recordContextStreamEventMetric("contextDeltaSuppressed");
            runtime.activeSuggestions.delete(input.suggestionHash);
        } else {
            emitDaemonStreamEvent({
                projectId: payload.projectId,
                eventType: "contextDeltaAcked",
                payload: {
                    ...payload,
                    reason
                }
            });
            recordContextStreamEventMetric("contextDeltaAcked");
        }

        return payload;
    }

    async autoStartFromEnv(): Promise<ContextStreamStatusItem | null> {
        if (!this.isAutoStartEnabled()) {
            return null;
        }

        const rootPath = readEnv("CORTEXA_CONTEXT_STREAM_ROOT");
        if (!rootPath) {
            return null;
        }

        const projectId = readEnv("CORTEXA_CONTEXT_STREAM_PROJECT_ID") ?? path.basename(rootPath);
        const branch = readEnv("CORTEXA_CONTEXT_STREAM_BRANCH") ?? MAIN_BRANCH;

        try {
            return await this.start({
                rootPath,
                projectId: projectId || "default",
                branch
            });
        } catch {
            return null;
        }
    }

    private isAutoStartEnabled(): boolean {
        return toBoolean(readEnv("CORTEXA_CONTEXT_STREAM_ENABLED"), false);
    }

    private buildStatusItem(runtime: ContextStreamRuntime): ContextStreamStatusItem {
        return {
            id: runtime.id,
            rootPath: runtime.rootPath,
            projectId: runtime.projectId,
            branch: runtime.branch,
            createdAt: runtime.createdAt,
            lastEventAt: runtime.lastEventAt,
            lastSuggestionAt: runtime.lastSuggestionAt,
            lastSuppressedAt: runtime.lastSuppressedAt,
            activeSuggestions: runtime.activeSuggestions.size,
            queuedEvents: runtime.pendingEvents.length,
            processedEvents: runtime.processedEvents,
            lastSuggestionHash: runtime.lastSuggestionHash,
            lastSuppressionReason: runtime.lastSuppressionReason
        };
    }

    private handleWatcherEvent(key: string, event: WatcherEvent): void {
        const runtime = this.streams.get(key);
        if (!runtime) {
            return;
        }

        if (event.type === "unlink") {
            return;
        }

        runtime.lastEventAt = event.timestamp;
        runtime.pendingEvents.push(event);

        if (runtime.debounceTimer) {
            clearTimeout(runtime.debounceTimer);
        }

        runtime.debounceTimer = setTimeout(() => {
            void this.processQueuedEvents(runtime);
        }, runtime.config.debounceMs);
    }

    private async processQueuedEvents(runtime: ContextStreamRuntime): Promise<void> {
        if (runtime.processing) {
            return;
        }

        const nextEvent = runtime.pendingEvents.shift();
        if (!nextEvent) {
            return;
        }

        runtime.processing = true;
        runtime.debounceTimer = undefined;

        try {
            const now = Date.now();
            const { query, sourcePath, fileKind, matchedEntities } = buildEventQuery(nextEvent, runtime.projectId, runtime.rootPath);
            const sourceScope = `file:${sourcePath}`;

            if (!query.trim()) {
                this.emitSuppressed(runtime, {
                    sourcePath,
                    sourceScope,
                    reason: "empty_query"
                });
                return;
            }

            if (runtime.config.suppressOnCriticalRisk) {
                const stats = getMemoryCompactionStats(runtime.projectId);
                const risk = resolveProjectRisk(stats);
                if (risk === "critical") {
                    this.emitSuppressed(runtime, {
                        sourcePath,
                        sourceScope,
                        reason: "memory_risk_critical"
                    });
                    return;
                }
            }

            const suggestion = buildProactiveContextSuggestion({
                query,
                projectId: runtime.projectId,
                branch: runtime.branch
            });

            if (!shouldEmitProactiveSuggestion(suggestion, runtime.config.minConfidence)) {
                this.emitSuppressed(runtime, {
                    sourcePath,
                    sourceScope,
                    reason: "low_confidence"
                });
                return;
            }

            runtime.recentSuggestionWindow = cleanSuggestionWindow(runtime.recentSuggestionWindow, now, 60_000);
            if (runtime.recentSuggestionWindow.length >= runtime.config.maxSuggestionsPerMinute) {
                this.emitSuppressed(runtime, {
                    sourcePath,
                    sourceScope,
                    reason: "rate_limited"
                });
                return;
            }

            const suggestionHash = sha256(`${runtime.projectId}:${runtime.branch}:${query}:${sourcePath}`);
            const lastSeen = runtime.recentSuggestionHashes.get(suggestionHash);
            if (lastSeen && now - lastSeen < runtime.config.dedupeWindowMs) {
                this.emitSuppressed(runtime, {
                    sourcePath,
                    sourceScope,
                    reason: "duplicate"
                });
                return;
            }

            const topK = Math.min(runtime.config.topK, suggestion.recommendedTopK);
            const maxTokens = Math.min(runtime.config.maxTokens, suggestion.recommendedMaxTokens);

            const compiled = await compileContext(query, {
                projectId: runtime.projectId,
                branch: runtime.branch,
                topK,
                maxTokens,
                constraints: suggestion.recommendedConstraints,
                scope: suggestion.recommendedScope
            });

            if (!compiled.context.trim() || compiled.memoriesUsed === 0) {
                this.emitSuppressed(runtime, {
                    sourcePath,
                    sourceScope,
                    reason: "no_context"
                });
                return;
            }

            const contextPreview = trimPreview(compiled.context, runtime.config.previewChars);
            const eventId = randomId("ctx_delta");
            const createdAt = Date.now();
            const expiresAt = createdAt + runtime.config.suggestionTtlMs;

            const payload: ContextStreamEventPayload = {
                eventId,
                suggestionHash,
                projectId: runtime.projectId,
                branch: runtime.branch,
                sourcePath,
                sourceScope,
                fileKind,
                matchedEntities,
                reason: "file_change",
                confidence: suggestion.intent.confidence,
                topK,
                maxTokens,
                memoryIds: compiled.memories.map((memory) => memory.id),
                contextPreview,
                context: compiled.context,
                createdAt,
                expiresAt
            };

            emitDaemonStreamEvent({
                projectId: runtime.projectId,
                eventType: "contextDeltaSuggested",
                payload: payload as unknown as Record<string, unknown>
            });
            recordContextStreamEventMetric("contextDeltaSuggested");

            runtime.lastSuggestionAt = createdAt;
            runtime.lastSuggestionHash = suggestionHash;
            runtime.recentSuggestionHashes.set(suggestionHash, createdAt);
            runtime.recentSuggestionWindow.push(createdAt);
            runtime.processedEvents += 1;

            const expiry = setTimeout(() => {
                const record = runtime.activeSuggestions.get(suggestionHash);
                if (!record) {
                    return;
                }

                emitDaemonStreamEvent({
                    projectId: runtime.projectId,
                    eventType: "contextDeltaExpired",
                    payload: {
                        ...record.payload,
                        reason: "expired"
                    }
                });
                recordContextStreamEventMetric("contextDeltaExpired");
                runtime.activeSuggestions.delete(suggestionHash);
            }, runtime.config.suggestionTtlMs);

            runtime.activeSuggestions.set(suggestionHash, {
                payload,
                timeout: expiry
            });
        } catch (error) {
            const fallbackPath = nextEvent.filePath;
            this.emitSuppressed(runtime, {
                sourcePath: fallbackPath,
                sourceScope: `file:${fallbackPath}`,
                reason: error instanceof Error ? error.message : "stream_error"
            });
        } finally {
            runtime.processing = false;
            if (runtime.pendingEvents.length > 0) {
                void this.processQueuedEvents(runtime);
            }
        }
    }

    private emitSuppressed(
        runtime: ContextStreamRuntime,
        params: { sourcePath: string; sourceScope: string; reason: string }
    ): void {
        const createdAt = Date.now();
        runtime.lastSuppressedAt = createdAt;

        const payload: ContextStreamEventPayload = {
            eventId: randomId("ctx_delta"),
            suggestionHash: sha256(`${runtime.projectId}:${runtime.branch}:${params.sourcePath}:${createdAt}`),
            projectId: runtime.projectId,
            branch: runtime.branch,
            sourcePath: params.sourcePath,
            sourceScope: params.sourceScope,
            reason: "suppressed",
            confidence: 0,
            topK: runtime.config.topK,
            maxTokens: runtime.config.maxTokens,
            memoryIds: [],
            contextPreview: "",
            context: "",
            createdAt,
            expiresAt: createdAt,
            suppressionReason: params.reason
        };

        runtime.lastSuppressionReason = params.reason;
        emitDaemonStreamEvent({
            projectId: runtime.projectId,
            eventType: "contextDeltaSuppressed",
            payload: payload as unknown as Record<string, unknown>
        });
        recordContextStreamSuppressionMetric(params.reason);
        recordContextStreamEventMetric("contextDeltaSuppressed");
    }
}

const controller = new ContextStreamController();

export function getContextStreamController(): ContextStreamControllerApi {
    return controller;
}
