import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { LLMClient } from "../../packages/core/src/types/llm";
import {
    getCortexaLlmClient as getMiniLlmClient,
    getMiniLlmStatus,
    suggestMiniLlmTags,
    type MiniLlmTagOptions
} from "./mini-llm.service";

type CortexaLlmMode = "mini-local" | "qwen-http" | "auto" | "disabled";

interface CortexaLlmConfig {
    mode: CortexaLlmMode;
    qwenServiceUrl: string;
    timeoutMs: number;
    strictRemote: boolean;
    maxJsonTokens: number;
    autoStartLocalService: boolean;
    autoStartWaitMs: number;
}

interface QwenTagRequest {
    text: string;
    project_id?: string;
    max_tags: number;
}

export interface CortexaLlmRuntimeStatus {
    mode: CortexaLlmMode;
    strictRemote: boolean;
    effectiveTimeoutMs: number;
    effectiveJsonMaxTokens: number;
    serviceUrl: string;
    serviceReachable: boolean;
    modelPathDetected?: string;
    lastSuccessAt?: number;
    lastError?: string;
    diagnosticHints: string[];
}

const DEFAULT_QWEN_SERVICE_URL = "http://127.0.0.1:8000";
const DEFAULT_QWEN_TIMEOUT_MS = 60_000;
const DEFAULT_QWEN_MAX_JSON_TOKENS = 160;
const DEFAULT_QWEN_AUTOSTART_WAIT_MS = 45_000;
const TAG_PATTERN = /^[a-z][a-z0-9_-]{1,23}$/;

const miniClient = getMiniLlmClient();
let localServiceStartPromise: Promise<void> | null = null;
let lastSuccessAt: number | null = null;
let lastError: string | null = null;
let lastErrorAt: number | null = null;

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
    if (typeof value !== "string") {
        return fallback;
    }

    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
        return true;
    }

    if (["0", "false", "no", "off"].includes(normalized)) {
        return false;
    }

    return fallback;
}

function parseBoundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function recordLlmSuccess(): void {
    lastSuccessAt = Date.now();
}

function recordLlmError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    lastError = message;
    lastErrorAt = Date.now();
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveLlmMode(value: string | undefined): CortexaLlmMode {
    const normalized = (value ?? "mini-local").trim().toLowerCase();
    if (["qwen-http", "qwen", "remote", "qwen_remote"].includes(normalized)) {
        return "qwen-http";
    }

    if (normalized === "auto") {
        return "auto";
    }

    if (normalized === "disabled" || normalized === "off") {
        return "disabled";
    }

    return "mini-local";
}

function normalizeBaseUrl(value: string | undefined): string {
    const candidate = (value ?? DEFAULT_QWEN_SERVICE_URL).trim();
    const fallback = DEFAULT_QWEN_SERVICE_URL;
    if (!candidate) {
        return fallback;
    }

    return candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
}

function readConfig(): CortexaLlmConfig {
    return {
        mode: resolveLlmMode(readEnv("CORTEXA_LLM_MODE")),
        qwenServiceUrl: normalizeBaseUrl(readEnv("CORTEXA_QWEN_SERVICE_URL") ?? readEnv("CORTEXA_ML_BASE_URL")),
        timeoutMs: parseBoundedInt(readEnv("CORTEXA_QWEN_TIMEOUT_MS"), DEFAULT_QWEN_TIMEOUT_MS, 1_000, 300_000),
        strictRemote: parseBooleanEnv(readEnv("CORTEXA_QWEN_STRICT"), true),
        maxJsonTokens: parseBoundedInt(
            readEnv("CORTEXA_QWEN_JSON_MAX_TOKENS"),
            DEFAULT_QWEN_MAX_JSON_TOKENS,
            32,
            1024
        ),
        autoStartLocalService: parseBooleanEnv(readEnv("CORTEXA_QWEN_AUTO_START"), true),
        autoStartWaitMs: parseBoundedInt(
            readEnv("CORTEXA_QWEN_AUTO_START_WAIT_MS"),
            DEFAULT_QWEN_AUTOSTART_WAIT_MS,
            1_000,
            180_000
        )
    };
}

function parseServiceUrl(baseUrl: string): { hostname: string; port: number; isLocal: boolean } {
    const url = new URL(baseUrl);
    const port = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
    const hostname = url.hostname;
    const isLocal = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";

    return {
        hostname,
        port,
        isLocal
    };
}

function resolvePythonExecutable(): string {
    const configured = (readEnv("CORTEXA_QWEN_PYTHON") ?? "").trim();
    if (configured) {
        return configured;
    }

    const cwd = process.cwd();
    const venvCandidate = process.platform === "win32"
        ? path.join(cwd, ".venv", "Scripts", "python.exe")
        : path.join(cwd, ".venv", "bin", "python");

    if (fs.existsSync(venvCandidate)) {
        return venvCandidate;
    }

    return process.platform === "win32" ? "python.exe" : "python";
}

function isConnectivityError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("fetch failed")) {
        return true;
    }

    if (message.toLowerCase().includes("econnrefused") || message.toLowerCase().includes("enotfound")) {
        return true;
    }

    return false;
}

async function isQwenServiceReachable(baseUrl: string, timeoutMs: number): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(`${baseUrl}/openapi.json`, {
            method: "GET",
            signal: controller.signal
        });

        return response.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

function buildDiagnosticHints(
    config: CortexaLlmConfig,
    miniStatus: ReturnType<typeof getMiniLlmStatus>,
    serviceReachable: boolean
): string[] {
    const hints: string[] = [];
    const { isLocal } = parseServiceUrl(config.qwenServiceUrl);

    if (config.mode === "disabled") {
        hints.push("LLM mode is disabled. Set CORTEXA_LLM_MODE=mini-local|qwen-http|auto to enable.");
    }

    if ((config.mode === "mini-local" || config.mode === "auto") && miniStatus.enabled && !miniStatus.modelExists) {
        hints.push("Mini LLM model not found. Run `cortexa llm train` to create a local model.");
    }

    if ((config.mode === "qwen-http" || config.mode === "auto") && !serviceReachable) {
        hints.push(`Qwen service is not reachable at ${config.qwenServiceUrl}.`);
    }

    if ((config.mode === "qwen-http" || config.mode === "auto") && isLocal && !config.autoStartLocalService) {
        hints.push("Auto-start for local Qwen service is disabled. Start it manually or set CORTEXA_QWEN_AUTO_START=true.");
    }

    if (config.mode === "auto" && config.strictRemote) {
        hints.push("Strict remote is enabled; auto mode will not fall back to mini-local on Qwen failure.");
    }

    if (lastError) {
        const errorSuffix = lastErrorAt ? ` (at ${new Date(lastErrorAt).toISOString()})` : "";
        hints.push(`Last error: ${lastError}${errorSuffix}`);

        if (lastSuccessAt && lastErrorAt && lastSuccessAt > lastErrorAt) {
            hints.push("A successful LLM call occurred after the last error; the failure may have been transient.");
        }
    }

    return hints;
}

function resolveSpawnTimeoutSeconds(config: CortexaLlmConfig): number {
    const inherited = Number(readEnv("CORTEXA_QWEN_TIMEOUT_SECONDS"));
    const inheritedSeconds = Number.isFinite(inherited) ? inherited : 0;
    const derivedFromHttpTimeout = Math.ceil(config.timeoutMs / 1000);
    return Math.min(180, Math.max(15, inheritedSeconds, derivedFromHttpTimeout));
}

function spawnLocalQwenService(config: CortexaLlmConfig): void {
    const { hostname, port } = parseServiceUrl(config.qwenServiceUrl);
    const python = resolvePythonExecutable();
    const timeoutSeconds = resolveSpawnTimeoutSeconds(config);

    const args = [
        "-m",
        "uvicorn",
        "apps.ml.serve:app",
        "--host",
        hostname,
        "--port",
        String(port)
    ];

    const child = spawn(python, args, {
        cwd: process.cwd(),
        env: {
            ...process.env,
            CORTEXA_QWEN_TIMEOUT_SECONDS: String(timeoutSeconds),
            CORTEXA_QWEN_STRICT: config.strictRemote ? "true" : "false",
        },
        detached: true,
        stdio: "ignore",
        windowsHide: true
    });

    child.unref();
}

async function ensureLocalQwenService(config: CortexaLlmConfig): Promise<void> {
    if (!config.autoStartLocalService) {
        return;
    }

    const { isLocal } = parseServiceUrl(config.qwenServiceUrl);
    if (!isLocal) {
        return;
    }

    if (await isQwenServiceReachable(config.qwenServiceUrl, 900)) {
        return;
    }

    if (!localServiceStartPromise) {
        localServiceStartPromise = (async () => {
            spawnLocalQwenService(config);

            const deadline = Date.now() + config.autoStartWaitMs;
            while (Date.now() < deadline) {
                if (await isQwenServiceReachable(config.qwenServiceUrl, 900)) {
                    return;
                }

                await delay(450);
            }

            throw new Error(
                `Qwen service auto-start timed out after ${config.autoStartWaitMs}ms at ${config.qwenServiceUrl}`
            );
        })().finally(() => {
            localServiceStartPromise = null;
        });
    }

    return localServiceStartPromise;
}

function toObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }

    return value as Record<string, unknown>;
}

function normalizeTag(tag: string): string {
    return tag
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "")
        .replace(/[_-]{2,}/g, "-")
        .replace(/^[-_]+|[-_]+$/g, "");
}

function normalizeTagList(value: unknown, maxTags: number): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const tags: string[] = [];

    for (const item of value) {
        if (typeof item !== "string") {
            continue;
        }

        const normalized = normalizeTag(item);
        if (!normalized || !TAG_PATTERN.test(normalized)) {
            continue;
        }

        if (!tags.includes(normalized)) {
            tags.push(normalized);
        }

        if (tags.length >= maxTags) {
            break;
        }
    }

    return tags;
}

async function postJson(url: string, payload: unknown, config: CortexaLlmConfig): Promise<unknown> {
    let autoStartAttempted = false;

    while (true) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "content-type": "application/json"
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            const text = await response.text();
            let parsed: unknown = {};

            if (text.trim()) {
                try {
                    parsed = JSON.parse(text);
                } catch {
                    parsed = { raw: text };
                }
            }

            if (!response.ok) {
                const detail = typeof parsed === "object" && parsed !== null
                    ? JSON.stringify(parsed)
                    : String(parsed);
                throw new Error(`Qwen service request failed (${response.status}): ${detail}`);
            }

            return parsed;
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                throw new Error(`Qwen service request timed out after ${config.timeoutMs}ms`);
            }

            if (!autoStartAttempted && isConnectivityError(error)) {
                autoStartAttempted = true;
                await ensureLocalQwenService(config);
                continue;
            }

            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }
}

async function requestQwenTags(req: QwenTagRequest, config: CortexaLlmConfig): Promise<string[]> {
    const payload = await postJson(`${config.qwenServiceUrl}/tags`, req, config);
    const body = toObject(payload);

    if (body.fallback === true) {
        const reason = typeof body.error === "string" ? body.error : "qwen_returned_fallback";
        throw new Error(`Qwen tags fallback is not allowed: ${reason}`);
    }

    if (typeof body.error === "string") {
        throw new Error(`Qwen tags error: ${body.error}`);
    }

    const tags = normalizeTagList(body.tags, req.max_tags);
    if (tags.length === 0) {
        throw new Error("Qwen tags response was empty or invalid.");
    }

    return tags;
}

async function requestQwenJson<T>(params: {
    system: string;
    user: string;
    schemaHint: string;
    temperature?: number;
}, config: CortexaLlmConfig): Promise<T> {
    const payload = await postJson(
        `${config.qwenServiceUrl}/complete-json`,
        {
            system: params.system,
            user: params.user,
            schema_hint: params.schemaHint,
            max_tokens: config.maxJsonTokens
        },
        config
    );

    const body = toObject(payload);
    if (typeof body.error === "string") {
        throw new Error(`Qwen complete-json error: ${body.error}`);
    }

    if (body.parse_failed === true) {
        throw new Error("Qwen complete-json parse failed.");
    }

    if (body.fallback === true) {
        throw new Error("Qwen complete-json returned fallback payload.");
    }

    return body as T;
}

export async function suggestCortexaTags(
    seedText: string,
    options: MiniLlmTagOptions & { projectId?: string } = {}
): Promise<string[]> {
    const config = readConfig();
    const maxTags = parseBoundedInt(String(options.maxTags ?? 6), 6, 1, 24);
    const text = String(seedText ?? "").trim();

    if (!text || config.mode === "disabled") {
        return [];
    }

    const shouldUseQwen = config.mode === "qwen-http" || config.mode === "auto";
    if (shouldUseQwen) {
        try {
            const tags = await requestQwenTags(
                {
                    text,
                    project_id: options.projectId,
                    max_tags: maxTags
                },
                config
            );
            recordLlmSuccess();
            return tags;
        } catch (error) {
            recordLlmError(error);
            if (config.mode === "qwen-http" || config.strictRemote) {
                throw error;
            }
        }
    }

    const tags = suggestMiniLlmTags(text, {
        maxTags
    });
    recordLlmSuccess();
    return tags;
}

const unifiedClient: LLMClient = {
    async completeJson<T>(params: {
        system: string;
        user: string;
        schemaHint: string;
        temperature?: number;
    }): Promise<T> {
        const config = readConfig();

        if (config.mode === "disabled") {
            const error = new Error("cortexa-llm-disabled");
            recordLlmError(error);
            throw error;
        }

        if (config.mode === "qwen-http") {
            try {
                const result = await requestQwenJson<T>(params, config);
                recordLlmSuccess();
                return result;
            } catch (error) {
                recordLlmError(error);
                throw error;
            }
        }

        if (config.mode === "auto") {
            try {
                const result = await requestQwenJson<T>(params, config);
                recordLlmSuccess();
                return result;
            } catch (error) {
                recordLlmError(error);
                if (config.strictRemote) {
                    throw error;
                }
            }
        }

        try {
            const result = await miniClient.completeJson<T>(params);
            recordLlmSuccess();
            return result;
        } catch (error) {
            recordLlmError(error);
            throw error;
        }
    }
};

export async function getCortexaLlmRuntimeStatus(): Promise<CortexaLlmRuntimeStatus> {
    const config = readConfig();
    const miniStatus = getMiniLlmStatus();
    const shouldCheckService = config.mode === "qwen-http" || config.mode === "auto";
    const serviceReachable = shouldCheckService
        ? await isQwenServiceReachable(config.qwenServiceUrl, Math.min(1500, config.timeoutMs))
        : false;

    return {
        mode: config.mode,
        strictRemote: config.strictRemote,
        effectiveTimeoutMs: config.timeoutMs,
        effectiveJsonMaxTokens: config.maxJsonTokens,
        serviceUrl: config.qwenServiceUrl,
        serviceReachable,
        modelPathDetected: miniStatus.modelPath,
        lastSuccessAt: lastSuccessAt ?? undefined,
        lastError: lastError ?? undefined,
        diagnosticHints: buildDiagnosticHints(config, miniStatus, serviceReachable)
    };
}

export function getCortexaLlmClient(): LLMClient {
    return unifiedClient;
}
