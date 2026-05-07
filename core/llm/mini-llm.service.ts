import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { compressorAgent } from "../../agents/compressor.agent";
import { criticAgent as legacyCriticAgent } from "../../agents/critic.agent";
import { writerAgentDraft } from "../../agents/writer.agent";
import type { LLMClient } from "../../packages/core/src/types/llm";
import { listMemories } from "../mempalace/memory.service";

const MODEL_VERSION = "cortexa-mini-ngram-q8-v1";
const DEFAULT_MODEL_FILE = path.resolve(process.cwd(), "data", "llm", "cortexa-mini-llm.q8.json");
const DEFAULT_MAX_FILES = 800;
const DEFAULT_MAX_FILE_BYTES = 300_000;
const DEFAULT_MAX_CORPUS_CHARS = 2_000_000;
const DEFAULT_MAX_VOCAB = 4_096;
const DEFAULT_MAX_TRANSITIONS = 24;
const DEFAULT_MEMORY_LIMIT = 250;
const DEFAULT_HF_ROWS = 200;
const DEFAULT_HF_SPLIT = "train";
const DEFAULT_HF_BATCH_SIZE = 100;
const DEFAULT_PROJECT_CORPUS_WEIGHT = 2;
const DEFAULT_MEMORY_CORPUS_WEIGHT = 2;
const TECHNICAL_DATASET_KEYWORDS = [
    "api",
    "json",
    "schema",
    "memory",
    "cache",
    "model",
    "prompt",
    "token",
    "retrieval",
    "context",
    "agent",
    "llm",
    "embedding",
    "vector",
    "typescript",
    "python",
    "node",
    "function",
    "class",
    "cli",
    "branch",
    "project",
    "merge",
    "critic",
    "score"
] as const;
const DATASET_CACHE_DIR = path.resolve(process.cwd(), "data", "llm", "datasets");

const FILE_EXTENSIONS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".md",
    ".txt",
    ".py",
    ".java",
    ".go",
    ".rs",
    ".c",
    ".cc",
    ".cpp",
    ".h",
    ".hpp",
    ".css",
    ".scss",
    ".html",
    ".yml",
    ".yaml",
    ".toml",
    ".ini"
]);

const SKIP_DIRECTORIES = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "out",
    "data",
    "logs",
    "tmp",
    ".tmp",
    ".venv",
    "venv",
    ".cache",
    "target",
    ".next"
]);

const TOKEN_PATTERN = /[a-z0-9_]+|[^\s]/g;
const TAG_PATTERN = /^[a-z][a-z0-9_-]{2,}$/;
const PUNCT_NO_SPACE_BEFORE = new Set([".", ",", "!", "?", ";", ":", ")", "]", "}", "%"]);
const OPENING_PUNCT = new Set(["(", "[", "{"]);
const TERMINAL_PUNCT = new Set([".", "!", "?"]);
const DEFAULT_SAMPLE_TOP_K = 12;
const DEFAULT_SAMPLE_TEMPERATURE = 0.95;
const DEFAULT_SAMPLE_RECENT_WINDOW = 28;
const DEFAULT_SAMPLE_REPEAT_DECAY = 0.9;
const DEFAULT_SAMPLE_MIN_TOKENS = 16;
const DEFAULT_AUTO_TAG_LIMIT = 6;
const DEFAULT_DOMAIN_MAX_TOKENS = 12;
const DEFAULT_DOMAIN_PREFIX_CHARS = 5;
const DOMAIN_STOPWORDS = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "while",
    "when",
    "then",
    "your",
    "you",
    "our",
    "their",
    "them",
    "they",
    "there",
    "about",
    "have",
    "has",
    "had",
    "will",
    "would",
    "should",
    "could",
    "just",
    "also",
    "more",
    "most",
    "some",
    "other",
    "using",
    "used",
    "need",
    "needs",
    "where",
    "what",
    "how",
    "why",
    "who",
    "which",
    "than",
    "over",
    "under",
    "across",
    "before",
    "after",
    "between",
    "inside",
    "outside",
    "through"
]);

type UnknownRecord = Record<string, unknown>;

interface QuantizedTransitionRow {
    from: number;
    to: number[];
    q: number[];
}

interface QuantizedMiniLlmModel {
    version: string;
    createdAt: number;
    sourceCount: number;
    corpusChars: number;
    tokenCount: number;
    maxTransitionsPerToken: number;
    vocab: string[];
    unigramQ: number[];
    rows: QuantizedTransitionRow[];
}

interface RuntimeTransition {
    tokenId: number;
    weight: number;
}

interface WeightedCandidate {
    tokenId: number;
    score: number;
}

interface RuntimeMiniLlmModel {
    path: string;
    mtimeMs: number;
    ephemeral: boolean;
    model: QuantizedMiniLlmModel;
    tokenToId: Map<string, number>;
    transitions: Map<number, RuntimeTransition[]>;
    unigramTransitions: RuntimeTransition[];
}

interface RuntimeConfig {
    mode: "mini-local" | "disabled";
    modelPath: string;
}

interface ProjectCorpusResult {
    snippets: string[];
    sourceCount: number;
    corpusChars: number;
    warnings: string[];
}

interface MemoryCorpusResult {
    snippets: string[];
    sourceCount: number;
    corpusChars: number;
    warnings: string[];
}

interface DatasetCorpusResult {
    snippets: string[];
    sourceCount: number;
    corpusChars: number;
    warnings: string[];
}

interface BuildConfig {
    maxVocab: number;
    maxTransitionsPerToken: number;
}

interface TrainConfig extends BuildConfig {
    projectPath: string;
    projectId?: string;
    branch?: string;
    modelPath: string;
    maxFiles: number;
    maxFileBytes: number;
    maxCorpusChars: number;
    includeMemoryStore: boolean;
    memoryLimit: number;
    hfDataset?: string;
    hfSplit: string;
    hfRows: number;
}

let runtimeCache: RuntimeMiniLlmModel | null = null;

export interface MiniLlmTrainOptions {
    projectPath?: string;
    projectId?: string;
    branch?: string;
    modelPath?: string;
    maxFiles?: number;
    maxFileBytes?: number;
    maxCorpusChars?: number;
    maxVocab?: number;
    maxTransitionsPerToken?: number;
    includeMemoryStore?: boolean;
    memoryLimit?: number;
    hfDataset?: string;
    hfSplit?: string;
    hfRows?: number;
}

export interface MiniLlmTrainResult {
    modelPath: string;
    sourceCount: number;
    corpusChars: number;
    tokenCount: number;
    vocabSize: number;
    transitionRows: number;
    averageBranchingFactor: number;
    durationMs: number;
    warnings: string[];
}

export interface MiniLlmStatus {
    mode: "mini-local" | "disabled";
    enabled: boolean;
    modelPath: string;
    modelExists: boolean;
    loaded: boolean;
    ephemeralLoaded: boolean;
    vocabSize?: number;
    transitionRows?: number;
    tokenCount?: number;
    sourceCount?: number;
}

export interface MiniLlmGenerateOptions {
    maxTokens?: number;
}

export interface MiniLlmTagOptions {
    maxTags?: number;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, Math.trunc(value)));
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    if (value <= 0) {
        return 0;
    }
    if (value >= 1) {
        return 1;
    }
    return value;
}

function normalizeWhitespace(input: string): string {
    return input.replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
}

function safeDatasetFileSegment(value: string): string {
    const normalized = value
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "");

    return normalized || "dataset";
}

function stableHash(text: string): number {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return hash >>> 0;
}

function resolveRuntimeConfig(modelPathOverride?: string): RuntimeConfig {
    const modeRaw = (process.env.CORTEXA_LLM_MODE ?? "mini-local").trim().toLowerCase();
    const mode: RuntimeConfig["mode"] = modeRaw === "disabled" || modeRaw === "off" ? "disabled" : "mini-local";

    const modelPathRaw = (modelPathOverride ?? process.env.CORTEXA_LLM_MODEL_PATH ?? DEFAULT_MODEL_FILE).trim();
    const modelPath = modelPathRaw ? path.resolve(modelPathRaw) : DEFAULT_MODEL_FILE;

    return {
        mode,
        modelPath
    };
}

function resolveTrainConfig(options: MiniLlmTrainOptions): TrainConfig {
    const runtime = resolveRuntimeConfig(options.modelPath);

    return {
        projectPath: path.resolve((options.projectPath ?? process.cwd()).trim() || process.cwd()),
        projectId: options.projectId?.trim() || undefined,
        branch: options.branch?.trim() || undefined,
        modelPath: runtime.modelPath,
        maxFiles: clampInt(options.maxFiles, DEFAULT_MAX_FILES, 20, 20_000),
        maxFileBytes: clampInt(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 8_000, 2_000_000),
        maxCorpusChars: clampInt(options.maxCorpusChars, DEFAULT_MAX_CORPUS_CHARS, 20_000, 20_000_000),
        maxVocab: clampInt(options.maxVocab, DEFAULT_MAX_VOCAB, 128, 32_768),
        maxTransitionsPerToken: clampInt(options.maxTransitionsPerToken, DEFAULT_MAX_TRANSITIONS, 2, 256),
        includeMemoryStore: options.includeMemoryStore !== false,
        memoryLimit: clampInt(options.memoryLimit, DEFAULT_MEMORY_LIMIT, 0, 10_000),
        hfDataset: options.hfDataset?.trim() || undefined,
        hfSplit: options.hfSplit?.trim() || DEFAULT_HF_SPLIT,
        hfRows: clampInt(options.hfRows, DEFAULT_HF_ROWS, 1, 2_000)
    };
}

function tokenize(text: string, maxTokens = 4_096): string[] {
    const lowered = text.toLowerCase();
    const matches = lowered.match(TOKEN_PATTERN) ?? [];
    if (matches.length <= maxTokens) {
        return matches;
    }

    return matches.slice(0, maxTokens);
}

function detokenize(tokens: string[]): string {
    let output = "";

    for (const token of tokens) {
        if (!token) {
            continue;
        }

        if (!output) {
            output = token;
            continue;
        }

        const lastChar = output[output.length - 1] ?? "";
        if (PUNCT_NO_SPACE_BEFORE.has(token) || OPENING_PUNCT.has(lastChar)) {
            output += token;
            continue;
        }

        output += ` ${token}`;
    }

    return output.trim();
}

function collectProjectCorpus(config: TrainConfig): ProjectCorpusResult {
    const snippets: string[] = [];
    const warnings: string[] = [];
    const stack = [config.projectPath];

    let sourceCount = 0;
    let corpusChars = 0;

    while (stack.length > 0 && sourceCount < config.maxFiles && corpusChars < config.maxCorpusChars) {
        const currentPath = stack.pop()!;
        let entries: fs.Dirent[];

        try {
            entries = fs.readdirSync(currentPath, { withFileTypes: true });
        } catch {
            warnings.push(`skipped unreadable directory: ${currentPath}`);
            continue;
        }

        for (const entry of entries) {
            if (sourceCount >= config.maxFiles || corpusChars >= config.maxCorpusChars) {
                break;
            }

            const absolutePath = path.join(currentPath, entry.name);

            if (entry.isDirectory()) {
                if (SKIP_DIRECTORIES.has(entry.name)) {
                    continue;
                }
                stack.push(absolutePath);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            const extension = path.extname(entry.name).toLowerCase();
            if (!FILE_EXTENSIONS.has(extension)) {
                continue;
            }

            let stat: fs.Stats;
            try {
                stat = fs.statSync(absolutePath);
            } catch {
                warnings.push(`skipped unreadable file metadata: ${absolutePath}`);
                continue;
            }

            if (stat.size <= 0 || stat.size > config.maxFileBytes) {
                continue;
            }

            let fileContent: string;
            try {
                fileContent = fs.readFileSync(absolutePath, "utf8");
            } catch {
                warnings.push(`skipped unreadable file: ${absolutePath}`);
                continue;
            }

            const normalized = normalizeWhitespace(fileContent);
            if (!normalized || normalized.length < 32) {
                continue;
            }

            const remainingChars = config.maxCorpusChars - corpusChars;
            if (remainingChars <= 0) {
                break;
            }

            const relative = path.relative(config.projectPath, absolutePath).replace(/\\/g, "/");
            const content = normalized.slice(0, remainingChars);
            snippets.push(`# file:${relative}\n${content}`);

            sourceCount += 1;
            corpusChars += content.length;
        }
    }

    return {
        snippets,
        sourceCount,
        corpusChars,
        warnings
    };
}

async function collectMemoryCorpus(config: TrainConfig): Promise<MemoryCorpusResult> {
    if (!config.includeMemoryStore || config.memoryLimit <= 0) {
        return {
            snippets: [],
            sourceCount: 0,
            corpusChars: 0,
            warnings: []
        };
    }

    try {
        const rows = listMemories(config.projectId, config.memoryLimit, {
            branch: config.branch
        });

        const snippets: string[] = [];
        let corpusChars = 0;

        for (const row of rows) {
            const summary = normalizeWhitespace(`${row.title}\n${row.summary}\n${row.content}`);
            if (!summary) {
                continue;
            }

            snippets.push(`# memory:${row.id}\n${summary.slice(0, 4000)}`);
            corpusChars += summary.length;
        }

        return {
            snippets,
            sourceCount: snippets.length,
            corpusChars,
            warnings: []
        };
    } catch (error) {
        return {
            snippets: [],
            sourceCount: 0,
            corpusChars: 0,
            warnings: [`memory corpus unavailable: ${error instanceof Error ? error.message : String(error)}`]
        };
    }
}

function collectTextNodes(value: unknown, sink: string[], depth = 0): void {
    if (depth > 4) {
        return;
    }

    if (typeof value === "string") {
        const trimmed = normalizeWhitespace(value);
        if (trimmed.length >= 24) {
            sink.push(trimmed);
        }
        return;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectTextNodes(item, sink, depth + 1);
        }
        return;
    }

    if (!value || typeof value !== "object") {
        return;
    }

    const record = value as UnknownRecord;
    for (const key of Object.keys(record)) {
        collectTextNodes(record[key], sink, depth + 1);
    }
}

async function collectDatasetCorpus(config: TrainConfig): Promise<DatasetCorpusResult> {
    if (!config.hfDataset) {
        return {
            snippets: [],
            sourceCount: 0,
            corpusChars: 0,
            warnings: []
        };
    }

    const token = (process.env.CORTEXA_LLM_HF_TOKEN ?? process.env.HUGGINGFACE_TOKEN ?? process.env.HF_TOKEN ?? "").trim();
    const headers: Record<string, string> = {};
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    const warnings: string[] = [];
    const fetchedRows: Array<{ row?: UnknownRecord }> = [];
    const batchSize = Math.min(DEFAULT_HF_BATCH_SIZE, config.hfRows);

    try {
        for (let offset = 0; offset < config.hfRows; offset += batchSize) {
            const length = Math.min(batchSize, config.hfRows - offset);
            const params = new URLSearchParams({
                dataset: config.hfDataset,
                config: "default",
                split: config.hfSplit,
                offset: String(offset),
                length: String(length)
            });

            const endpoint = `https://datasets-server.huggingface.co/rows?${params.toString()}`;
            const response = await fetch(endpoint, {
                headers
            });

            if (!response.ok) {
                if (fetchedRows.length === 0) {
                    return {
                        snippets: [],
                        sourceCount: 0,
                        corpusChars: 0,
                        warnings: [`dataset fetch failed (${response.status}) for ${config.hfDataset}`]
                    };
                }

                warnings.push(
                    `dataset fetch stopped at offset ${offset} (${response.status}); continuing with ${fetchedRows.length} downloaded rows`
                );
                break;
            }

            const payload = (await response.json()) as {
                rows?: Array<{ row?: UnknownRecord }>;
                error?: string;
            };

            if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
                warnings.push(`dataset returned no rows at offset ${offset}; stopping early`);
                break;
            }

            fetchedRows.push(...payload.rows);

            if (payload.rows.length < length) {
                warnings.push(
                    `dataset ended early at offset ${offset}; requested=${length} received=${payload.rows.length}`
                );
                break;
            }
        }

        if (fetchedRows.length === 0) {
            return {
                snippets: [],
                sourceCount: 0,
                corpusChars: 0,
                warnings: [`dataset did not return rows for ${config.hfDataset}`]
            };
        }

        const snippets: string[] = [];
        let corpusChars = 0;
        let filteredRows = 0;

        for (const row of fetchedRows) {
            const textParts: string[] = [];
            collectTextNodes(row.row, textParts);
            if (textParts.length === 0) {
                continue;
            }

            const joined = textParts.join("\n").slice(0, 3000);
            if (!joined.trim()) {
                continue;
            }

            const lowered = joined.toLowerCase();
            const hasTechnicalKeyword = TECHNICAL_DATASET_KEYWORDS.some((keyword) => lowered.includes(keyword));
            const hasCodePattern = /\b(function|class|const|let|var|return|async|await|import|export)\b|=>|\{\s*\"/.test(lowered);
            if (!hasTechnicalKeyword && !hasCodePattern) {
                filteredRows += 1;
                continue;
            }

            snippets.push(`# dataset:${config.hfDataset}\n${joined}`);
            corpusChars += joined.length;
        }

        if (filteredRows > 0) {
            warnings.push(`dataset filter kept ${snippets.length}/${fetchedRows.length} rows (filtered ${filteredRows} non-technical rows)`);
        }

        try {
            const cacheFileName = `${safeDatasetFileSegment(config.hfDataset)}__${safeDatasetFileSegment(config.hfSplit)}.rows.jsonl`;
            const cachePath = path.join(DATASET_CACHE_DIR, cacheFileName);
            await fsp.mkdir(DATASET_CACHE_DIR, { recursive: true });

            const cacheContent = fetchedRows
                .map((row) => JSON.stringify(row.row ?? {}))
                .join("\n");

            await fsp.writeFile(cachePath, cacheContent, "utf8");
            warnings.push(`dataset snapshot cached: ${cachePath}`);
        } catch (error) {
            warnings.push(
                `dataset cache write failed for ${config.hfDataset}: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        if (fetchedRows.length < config.hfRows) {
            warnings.push(`dataset rows fetched ${fetchedRows.length}/${config.hfRows}`);
        }

        return {
            snippets,
            sourceCount: snippets.length,
            corpusChars,
            warnings
        };
    } catch (error) {
        return {
            snippets: [],
            sourceCount: 0,
            corpusChars: 0,
            warnings: [`dataset fetch failed for ${config.hfDataset}: ${error instanceof Error ? error.message : String(error)}`]
        };
    }
}

function applyCorpusWeight(snippets: string[], weight: number): string[] {
    if (!Array.isArray(snippets) || snippets.length === 0) {
        return [];
    }

    const safeWeight = Math.min(4, Math.max(1, Math.trunc(weight)));
    if (safeWeight <= 1) {
        return snippets;
    }

    const weighted: string[] = [];
    for (let copy = 0; copy < safeWeight; copy += 1) {
        weighted.push(...snippets);
    }

    return weighted;
}

function quantizeWeight(part: number, total: number): number {
    if (total <= 0 || part <= 0) {
        return 0;
    }

    const probability = part / total;
    return Math.max(1, Math.min(127, Math.round(probability * 127)));
}

function buildModel(corpus: string[], sourceCount: number, corpusChars: number, config: BuildConfig): QuantizedMiniLlmModel {
    const tokenFrequency = new Map<string, number>();
    const tokenizedSources: string[][] = [];
    let tokenCount = 0;

    for (const snippet of corpus) {
        const tokens = tokenize(snippet, 8_000);
        if (tokens.length < 2) {
            continue;
        }

        tokenizedSources.push(tokens);

        for (const token of tokens) {
            tokenFrequency.set(token, (tokenFrequency.get(token) ?? 0) + 1);
            tokenCount += 1;
        }
    }

    const sortedVocabulary = [...tokenFrequency.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, Math.max(1, config.maxVocab - 1))
        .map(([token]) => token);

    const vocab = ["<unk>", ...sortedVocabulary];
    const tokenToId = new Map<string, number>(vocab.map((token, index) => [token, index]));

    const unigramCounts = new Array<number>(vocab.length).fill(0);
    const transitions = new Map<number, Map<number, number>>();

    for (const tokens of tokenizedSources) {
        for (let index = 0; index < tokens.length; index += 1) {
            const token = tokens[index] ?? "";
            const tokenId = tokenToId.get(token) ?? 0;
            unigramCounts[tokenId] += 1;

            if (index === 0) {
                continue;
            }

            const previousToken = tokens[index - 1] ?? "";
            const previousId = tokenToId.get(previousToken) ?? 0;
            const row = transitions.get(previousId) ?? new Map<number, number>();
            row.set(tokenId, (row.get(tokenId) ?? 0) + 1);
            transitions.set(previousId, row);
        }
    }

    const rows: QuantizedTransitionRow[] = [];

    for (const [from, row] of transitions.entries()) {
        const sorted = [...row.entries()]
            .sort((left, right) => right[1] - left[1])
            .slice(0, config.maxTransitionsPerToken);

        const total = sorted.reduce((acc, [, count]) => acc + count, 0);
        const to = sorted.map(([tokenId]) => tokenId);
        const q = sorted.map(([, count]) => quantizeWeight(count, total));

        rows.push({ from, to, q });
    }

    rows.sort((left, right) => left.from - right.from);

    const maxUnigramCount = Math.max(1, ...unigramCounts);
    const unigramQ = unigramCounts.map((count) => {
        if (count <= 0) {
            return 0;
        }

        return Math.max(1, Math.min(127, Math.round((count / maxUnigramCount) * 127)));
    });

    return {
        version: MODEL_VERSION,
        createdAt: Date.now(),
        sourceCount,
        corpusChars,
        tokenCount,
        maxTransitionsPerToken: config.maxTransitionsPerToken,
        vocab,
        unigramQ,
        rows
    };
}

function hydrateRuntime(model: QuantizedMiniLlmModel, modelPath: string, mtimeMs: number, ephemeral: boolean): RuntimeMiniLlmModel {
    const transitions = new Map<number, RuntimeTransition[]>();

    for (const row of model.rows) {
        const items: RuntimeTransition[] = [];

        for (let index = 0; index < row.to.length; index += 1) {
            const tokenId = row.to[index];
            const weight = row.q[index] ?? 0;
            if (typeof tokenId !== "number" || !Number.isFinite(tokenId) || tokenId < 0) {
                continue;
            }
            if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
                continue;
            }
            items.push({ tokenId: Math.trunc(tokenId), weight: Math.trunc(weight) });
        }

        if (items.length > 0) {
            transitions.set(Math.trunc(row.from), items);
        }
    }

    const tokenToId = new Map<string, number>(model.vocab.map((token, index) => [token, index]));
    const unigramTransitions: RuntimeTransition[] = model.unigramQ
        .map((weight, tokenId) => ({ tokenId, weight }))
        .filter((entry) => entry.weight > 0)
        .sort((left, right) => right.weight - left.weight)
        .slice(0, 64);

    return {
        path: modelPath,
        mtimeMs,
        ephemeral,
        model,
        tokenToId,
        transitions,
        unigramTransitions
    };
}

async function loadModelFromDisk(modelPath: string): Promise<RuntimeMiniLlmModel | null> {
    if (!fs.existsSync(modelPath)) {
        return null;
    }

    const stat = await fsp.stat(modelPath);
    if (runtimeCache && !runtimeCache.ephemeral && runtimeCache.path === modelPath && runtimeCache.mtimeMs === stat.mtimeMs) {
        return runtimeCache;
    }

    const raw = await fsp.readFile(modelPath, "utf8");
    const parsed = JSON.parse(raw) as QuantizedMiniLlmModel;

    if (!parsed || parsed.version !== MODEL_VERSION || !Array.isArray(parsed.vocab) || !Array.isArray(parsed.rows)) {
        throw new Error(`Unsupported mini-LLM model format at ${modelPath}`);
    }

    const hydrated = hydrateRuntime(parsed, modelPath, stat.mtimeMs, false);
    runtimeCache = hydrated;
    return hydrated;
}

function buildEphemeralModel(seedText: string): RuntimeMiniLlmModel {
    const seeds = [seedText, compressorAgent(seedText, { maxChars: 280 })].filter(Boolean);
    const model = buildModel(seeds, seeds.length, seeds.reduce((acc, value) => acc + value.length, 0), {
        maxVocab: 512,
        maxTransitionsPerToken: 16
    });

    const hydrated = hydrateRuntime(model, "<ephemeral>", Date.now(), true);
    runtimeCache = hydrated;
    return hydrated;
}

async function ensureRuntime(seedText: string): Promise<RuntimeMiniLlmModel | null> {
    const runtimeConfig = resolveRuntimeConfig();

    if (runtimeConfig.mode === "disabled") {
        return null;
    }

    try {
        const persisted = await loadModelFromDisk(runtimeConfig.modelPath);
        if (persisted) {
            return persisted;
        }
    } catch {
        // If a persisted model fails to load, continue with ephemeral fallback.
    }

    if (runtimeCache && runtimeCache.ephemeral) {
        return runtimeCache;
    }

    const normalizedSeed = normalizeWhitespace(seedText);
    if (!normalizedSeed) {
        return null;
    }

    return buildEphemeralModel(normalizedSeed);
}

function selectToken(transitions: RuntimeTransition[], seed: number): number {
    if (transitions.length === 0) {
        return 0;
    }

    const width = Math.min(3, transitions.length);
    const index = width <= 1 ? 0 : seed % width;
    return transitions[index]?.tokenId ?? transitions[0]!.tokenId;
}

function createDeterministicRng(seed: number): () => number {
    let state = seed >>> 0;

    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

function wouldRepeatNgram(history: number[], candidateTokenId: number, n: number): boolean {
    if (n <= 1) {
        return false;
    }

    if (history.length < n - 1) {
        return false;
    }

    const needle = [...history.slice(-(n - 1)), candidateTokenId];

    for (let index = 0; index <= history.length - n; index += 1) {
        let matches = true;
        for (let offset = 0; offset < n; offset += 1) {
            if (history[index + offset] !== needle[offset]) {
                matches = false;
                break;
            }
        }

        if (matches) {
            return true;
        }
    }

    return false;
}

function hasLowLexicalDiversity(tokenIds: number[], lookback = 14, minUnique = 4): boolean {
    if (tokenIds.length < lookback) {
        return false;
    }

    const recent = tokenIds.slice(-lookback);
    return new Set(recent).size < minUnique;
}

function isPunctuationToken(token: string): boolean {
    return /^[^a-z0-9_]+$/.test(token);
}

function extractDomainContext(seedText: string): {
    terms: Set<string>;
    prefixes: string[];
} {
    const orderedTerms: string[] = [];

    for (const token of tokenize(seedText, 256)) {
        if (!TAG_PATTERN.test(token)) {
            continue;
        }
        if (token.length < 4) {
            continue;
        }
        if (DOMAIN_STOPWORDS.has(token)) {
            continue;
        }
        if (!orderedTerms.includes(token)) {
            orderedTerms.push(token);
        }
        if (orderedTerms.length >= DEFAULT_DOMAIN_MAX_TOKENS) {
            break;
        }
    }

    const prefixes: string[] = [];
    for (const term of orderedTerms) {
        if (term.length <= DEFAULT_DOMAIN_PREFIX_CHARS + 1) {
            continue;
        }

        const prefix = term.slice(0, DEFAULT_DOMAIN_PREFIX_CHARS);
        if (!prefixes.includes(prefix)) {
            prefixes.push(prefix);
        }
    }

    return {
        terms: new Set(orderedTerms),
        prefixes
    };
}

function scoreDomainRelevance(token: string, domainTerms: Set<string>, domainPrefixes: string[]): number {
    if (!token || token === "<unk>") {
        return 1;
    }

    if (domainTerms.has(token)) {
        return 1.9;
    }

    for (const prefix of domainPrefixes) {
        if (token.startsWith(prefix)) {
            return 1.28;
        }
    }

    return 1;
}

function trimUnsafeTokenEdges(tokens: string[]): string[] {
    let start = 0;
    while (start < tokens.length) {
        const token = tokens[start] ?? "";
        if (isPunctuationToken(token) && !OPENING_PUNCT.has(token)) {
            start += 1;
            continue;
        }
        break;
    }

    let end = tokens.length;
    while (end > start) {
        const token = tokens[end - 1] ?? "";
        if (isPunctuationToken(token) && !TERMINAL_PUNCT.has(token) && !/[)\]}]/.test(token)) {
            end -= 1;
            continue;
        }
        break;
    }

    return tokens.slice(start, end);
}

function weightedSample(candidates: WeightedCandidate[], rng: () => number): number {
    if (candidates.length === 0) {
        return 0;
    }

    let total = 0;
    for (const candidate of candidates) {
        total += candidate.score;
    }

    if (total <= 0) {
        return candidates[0]!.tokenId;
    }

    const threshold = rng() * total;
    let cursor = 0;

    for (const candidate of candidates) {
        cursor += candidate.score;
        if (cursor >= threshold) {
            return candidate.tokenId;
        }
    }

    return candidates[candidates.length - 1]!.tokenId;
}

function selectTokenWithPolicy(params: {
    runtime: RuntimeMiniLlmModel;
    transitions: RuntimeTransition[];
    generatedTokenIds: number[];
    recentCounts: Map<number, number>;
    domainTerms: Set<string>;
    domainPrefixes: string[];
    openPunctuationBalance: number;
    previousTokenId: number;
    punctuationStreak: number;
    index: number;
    rng: () => number;
}): number {
    const lexicalPreferred = params.transitions.filter((entry) => {
        const token = params.runtime.model.vocab[entry.tokenId] ?? "";
        return /[a-z0-9_]/.test(token);
    });

    const candidatePool = lexicalPreferred.length > 0 && params.index % 6 !== 0
        ? lexicalPreferred
        : params.transitions;

    const topK = candidatePool.slice(0, Math.min(DEFAULT_SAMPLE_TOP_K, candidatePool.length));
    const weighted: WeightedCandidate[] = [];

    for (const candidate of topK) {
        const tokenId = candidate.tokenId;
        const token = params.runtime.model.vocab[tokenId] ?? "";
        if (!token || token === "<unk>") {
            continue;
        }

        if (params.generatedTokenIds.length === 0 && isPunctuationToken(token)) {
            continue;
        }

        if (/[)\]}]/.test(token) && params.openPunctuationBalance <= 0) {
            continue;
        }

        if (wouldRepeatNgram(params.generatedTokenIds, tokenId, 3)) {
            continue;
        }

        const base = Math.max(0.0001, candidate.weight / 127);
        const temperatureScore = Math.pow(base, 1 / DEFAULT_SAMPLE_TEMPERATURE);
        const repeatedCount = params.recentCounts.get(tokenId) ?? 0;
        const repeatPenalty = 1 / (1 + repeatedCount * DEFAULT_SAMPLE_REPEAT_DECAY);

        const repeatedImmediatePenalty = tokenId === params.previousTokenId ? 0.14 : 1;
        const punctuationPenalty = isPunctuationToken(token)
            ? params.punctuationStreak >= 2
                ? TERMINAL_PUNCT.has(token)
                    ? 0.55
                    : 0.18
                : 0.92
            : 1;
        const earlyTerminalPenalty = TERMINAL_PUNCT.has(token) && params.generatedTokenIds.length < 8 ? 0.45 : 1;
        const lexicalBoost = /[a-z0-9_]/.test(token) ? 1.15 : 0.9;
        const domainBoost = scoreDomainRelevance(token, params.domainTerms, params.domainPrefixes);

        const score =
            temperatureScore *
            repeatPenalty *
            repeatedImmediatePenalty *
            punctuationPenalty *
            earlyTerminalPenalty *
            lexicalBoost *
            domainBoost;
        if (score > 0.000001) {
            weighted.push({
                tokenId,
                score
            });
        }
    }

    if (weighted.length > 0) {
        return weightedSample(weighted, params.rng);
    }

    if (topK.length > 0) {
        const fallback = topK.find((entry) => entry.tokenId !== params.previousTokenId) ?? topK[0];
        return fallback?.tokenId ?? 0;
    }

    return 0;
}

function generateContinuation(runtime: RuntimeMiniLlmModel, seedText: string, maxTokens: number): string {
    const seedTokens = tokenize(seedText, 256);
    const fallbackTokenId = runtime.unigramTransitions[0]?.tokenId ?? 0;
    let previousId = runtime.tokenToId.get(seedTokens[seedTokens.length - 1] ?? "") ?? fallbackTokenId;
    const domainContext = extractDomainContext(seedText);

    const generatedTokens: string[] = [];
    const generatedTokenIds: number[] = [];
    const recentWindow: number[] = [];
    const recentCounts = new Map<number, number>();
    let domainHits = 0;
    let terminalPunctCount = 0;
    const seed = stableHash(seedText || "cortexa-mini-llm");
    const rng = createDeterministicRng(seed || 1);
    let punctuationStreak = 0;
    let openPunctuationBalance = 0;

    for (let index = 0; index < maxTokens; index += 1) {
        const transitions = runtime.transitions.get(previousId) ?? runtime.unigramTransitions;
        if (transitions.length === 0) {
            break;
        }

        const nextId = selectTokenWithPolicy({
            runtime,
            transitions,
            generatedTokenIds,
            recentCounts,
            domainTerms: domainContext.terms,
            domainPrefixes: domainContext.prefixes,
            openPunctuationBalance,
            previousTokenId: previousId,
            punctuationStreak,
            index,
            rng
        });

        const safeNextId = nextId > 0 ? nextId : selectToken(transitions, seed + index * 31);
        const token = runtime.model.vocab[safeNextId] ?? "<unk>";
        if (!token || token === "<unk>") {
            previousId = fallbackTokenId;
            continue;
        }

        generatedTokens.push(token);
        generatedTokenIds.push(safeNextId);
        previousId = safeNextId;

        if (OPENING_PUNCT.has(token)) {
            openPunctuationBalance += 1;
        } else if (/[)\]}]/.test(token) && openPunctuationBalance > 0) {
            openPunctuationBalance -= 1;
        }

        if (domainContext.terms.has(token)) {
            domainHits += 1;
        }
        if (TERMINAL_PUNCT.has(token)) {
            terminalPunctCount += 1;
        }

        recentWindow.push(safeNextId);
        recentCounts.set(safeNextId, (recentCounts.get(safeNextId) ?? 0) + 1);
        if (recentWindow.length > DEFAULT_SAMPLE_RECENT_WINDOW) {
            const removed = recentWindow.shift();
            if (typeof removed === "number") {
                const nextCount = (recentCounts.get(removed) ?? 1) - 1;
                if (nextCount <= 0) {
                    recentCounts.delete(removed);
                } else {
                    recentCounts.set(removed, nextCount);
                }
            }
        }

        if (/^[^a-z0-9_]+$/.test(token)) {
            punctuationStreak += 1;
        } else {
            punctuationStreak = 0;
        }

        if (punctuationStreak >= 6 && generatedTokens.length >= DEFAULT_SAMPLE_MIN_TOKENS) {
            break;
        }

        const domainSatisfied = domainContext.terms.size === 0 || domainHits > 0;
        if (
            generatedTokens.length >= DEFAULT_SAMPLE_MIN_TOKENS &&
            TERMINAL_PUNCT.has(token) &&
            domainSatisfied &&
            terminalPunctCount >= 1
        ) {
            break;
        }

        if (generatedTokenIds.length >= 8 && wouldRepeatNgram(generatedTokenIds.slice(0, -1), generatedTokenIds[generatedTokenIds.length - 1]!, 4)) {
            break;
        }

        if (hasLowLexicalDiversity(generatedTokenIds) && generatedTokens.length >= DEFAULT_SAMPLE_MIN_TOKENS) {
            if (/^[.!?]$/.test(token)) {
                break;
            }
        }
    }

    const trimmedTokens = trimUnsafeTokenEdges(generatedTokens);
    const outputTokens = trimmedTokens.length > 0 ? trimmedTokens : generatedTokens;
    return detokenize(outputTokens);
}

function toRecord(value: unknown): UnknownRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }

    return value as UnknownRecord;
}

function parseUserPayload(raw: string): UnknownRecord {
    const trimmed = raw.trim();
    if (!trimmed) {
        return {};
    }

    try {
        return toRecord(JSON.parse(trimmed));
    } catch {
        // continue with substring parsing
    }

    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");

    if (firstBrace >= 0 && lastBrace > firstBrace) {
        const candidate = trimmed.slice(firstBrace, lastBrace + 1);
        try {
            return toRecord(JSON.parse(candidate));
        } catch {
            return {};
        }
    }

    return {};
}

function readString(value: unknown, maxChars = 8_000): string {
    if (typeof value !== "string") {
        return "";
    }

    return value.trim().slice(0, maxChars);
}

function readStringArray(value: unknown, maxItems = 32, maxChars = 600): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((item) => readString(item, maxChars))
        .filter(Boolean)
        .slice(0, maxItems);
}

function readNumber(value: unknown, fallback = 0): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return fallback;
}

function extractTopTags(text: string, maxTags = 6): string[] {
    const counts = new Map<string, number>();

    for (const token of tokenize(text, 128)) {
        if (!TAG_PATTERN.test(token) || token.length > 24) {
            continue;
        }

        counts.set(token, (counts.get(token) ?? 0) + 1);
    }

    return [...counts.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([token]) => token)
        .slice(0, maxTags);
}

function isTagCandidate(token: string): boolean {
    if (!token || token.length > 24) {
        return false;
    }

    if (!TAG_PATTERN.test(token)) {
        return false;
    }

    return !DOMAIN_STOPWORDS.has(token);
}

function addTagScore(scores: Map<string, number>, token: string, weight: number): void {
    const normalized = token.trim().toLowerCase();
    if (!isTagCandidate(normalized)) {
        return;
    }

    scores.set(normalized, (scores.get(normalized) ?? 0) + Math.max(0.0001, weight));
}

function rankTagScores(scores: Map<string, number>, maxTags: number): string[] {
    return [...scores.entries()]
        .sort((left, right) => {
            const scoreGap = right[1] - left[1];
            if (Math.abs(scoreGap) > 0.0001) {
                return scoreGap;
            }

            if (left[0].length !== right[0].length) {
                return left[0].length - right[0].length;
            }

            return left[0].localeCompare(right[0]);
        })
        .map(([tag]) => tag)
        .slice(0, maxTags);
}

export async function suggestMiniLlmTags(seedText: string, options: MiniLlmTagOptions = {}): Promise<string[]> {
    const normalized = readString(seedText, 24_000).toLowerCase();
    if (!normalized) {
        return [];
    }

    const maxTags = clampInt(options.maxTags, DEFAULT_AUTO_TAG_LIMIT, 1, 24);
    const tagScores = new Map<string, number>();

    const lexicalTags = extractTopTags(normalized, Math.min(24, maxTags * 4));
    lexicalTags.forEach((tag, index) => {
        addTagScore(tagScores, tag, 1.4 - index * 0.08);
    });

    const domainContext = extractDomainContext(normalized);
    let domainIndex = 0;
    for (const term of domainContext.terms) {
        addTagScore(tagScores, term, 2.6 - domainIndex * 0.1);
        domainIndex += 1;
        if (domainIndex >= DEFAULT_DOMAIN_MAX_TOKENS) {
            break;
        }
    }

    const runtime = await ensureRuntime(normalized);
    if (runtime) {
        const seedTokens = [...new Set(tokenize(normalized, 192))];

        for (const seedToken of seedTokens) {
            const seedTokenId = runtime.tokenToId.get(seedToken);
            if (typeof seedTokenId !== "number" || seedTokenId < 0) {
                continue;
            }

            const transitions = runtime.transitions.get(seedTokenId);
            if (!transitions || transitions.length === 0) {
                continue;
            }

            const capped = transitions.slice(0, 10);
            const strongestWeight = Math.max(1, ...capped.map((entry) => entry.weight));

            for (const entry of capped) {
                const candidate = (runtime.model.vocab[entry.tokenId] ?? "").toLowerCase();
                if (!isTagCandidate(candidate)) {
                    continue;
                }

                const normalizedWeight = entry.weight / strongestWeight;
                const domainBoost = domainContext.terms.has(candidate)
                    ? 1.35
                    : domainContext.prefixes.some((prefix) => candidate.startsWith(prefix))
                        ? 1.15
                        : 1;

                addTagScore(tagScores, candidate, 0.8 + normalizedWeight * domainBoost);
            }
        }
    }

    return rankTagScores(tagScores, maxTags);
}

function estimateNovelty(runtime: RuntimeMiniLlmModel | null, text: string): number {
    if (!runtime) {
        return 0.5;
    }

    const tokens = tokenize(text, 512);
    if (tokens.length < 2) {
        return 0.5;
    }

    let noveltyTotal = 0;
    let measuredPairs = 0;

    for (let index = 1; index < tokens.length; index += 1) {
        const previousId = runtime.tokenToId.get(tokens[index - 1] ?? "") ?? 0;
        const currentId = runtime.tokenToId.get(tokens[index] ?? "") ?? 0;
        const transitions = runtime.transitions.get(previousId);

        let familiarity = 0;
        if (transitions) {
            const match = transitions.find((entry) => entry.tokenId === currentId);
            familiarity = match ? clamp01(match.weight / 127) : 0;
        }

        noveltyTotal += 1 - familiarity;
        measuredPairs += 1;
    }

    return clamp01(noveltyTotal / Math.max(1, measuredPairs));
}

function buildWriterOutput(runtime: RuntimeMiniLlmModel | null, payload: UnknownRecord): UnknownRecord {
    const text = readString(payload.text, 18_000);
    const context = readString(payload.context, 18_000);
    const projectId = readString(payload.projectId, 256) || "default";

    const source = [text, context].filter(Boolean).join("\n").trim() || "generated memory candidate";
    const draft = writerAgentDraft(source);
    const generated = runtime ? generateContinuation(runtime, `${draft.title}\n${draft.summary}\n${text}\n${context}`, 80) : "";

    const summary = compressorAgent([draft.summary, generated].filter(Boolean).join(" "), {
        maxChars: 220,
        preserveLineBreaks: false
    });

    const tags = [...new Set([...draft.tags, ...extractTopTags(generated), "mini-llm"])].slice(0, 16);
    const content = generated
        ? `${draft.content}\n\nModel-guided continuation:\n${generated}`
        : draft.content;

    return {
        candidates: [
            {
                kind: "semantic",
                title: draft.title,
                summary,
                content,
                tags,
                sourceRef: projectId
            }
        ],
        confidence: runtime ? 0.72 : 0.46
    };
}

function buildCriticOutput(runtime: RuntimeMiniLlmModel | null, payload: UnknownRecord): UnknownRecord {
    const title = readString(payload.title, 160);
    const summary = readString(payload.summary, 3_000);
    const existingSnippets = readStringArray(payload.existingSnippets, 40, 500);

    const base = legacyCriticAgent(`${title}\n${summary}`.trim(), existingSnippets);
    const noveltyEstimate = estimateNovelty(runtime, `${title}\n${summary}`);

    const novelty = clamp01(base.novelty * 0.7 + noveltyEstimate * 0.3);
    const clarity = clamp01(base.clarity * 0.9 + Math.min(1, summary.length / 300) * 0.1);
    const redundancy = clamp01(1 - novelty);
    const score = clamp01(novelty * 0.62 + clarity * 0.38);

    const action: "store" | "merge" | "reject" | "compress" =
        score >= 0.8 ? "merge" : score >= 0.6 ? "store" : score >= 0.42 ? "compress" : "reject";

    return {
        accepted: action !== "reject",
        score,
        novelty,
        redundancy,
        clarity,
        action,
        reason: action === "reject" ? base.reason || "low-signal" : "mini-llm-review",
        mergeKey: action === "merge" ? title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : undefined
    };
}

function buildConsolidatorOutput(runtime: RuntimeMiniLlmModel | null, payload: UnknownRecord): UnknownRecord {
    const candidate = toRecord(payload.candidate);
    const neighbors = Array.isArray(payload.neighbors) ? payload.neighbors.map((entry) => toRecord(entry)) : [];

    const title = readString(candidate.title, 180) || "Generated Memory";
    const summary = readString(candidate.summary, 5_000) || title;
    const content = readString(candidate.content, 24_000) || summary;
    const candidateConfidence = clamp01(readNumber(candidate.confidence, 0.55));
    const tags = readStringArray(candidate.tags, 24, 48);

    const neighborDigest = neighbors
        .slice(0, 4)
        .map((neighbor) => readString(neighbor.summary, 500) || readString(neighbor.title, 160))
        .filter(Boolean)
        .join(" ");

    const generated = runtime ? generateContinuation(runtime, `${title}\n${summary}\n${neighborDigest}`, 72) : "";

    const mergedSummary = compressorAgent([summary, neighborDigest, generated].filter(Boolean).join(" "), {
        maxChars: 220,
        preserveLineBreaks: false
    });

    const mergedTags = [...new Set([...tags, ...extractTopTags(neighborDigest), ...extractTopTags(generated), "consolidated"])].slice(
        0,
        20
    );

    const mergedContent = [
        content,
        neighborDigest ? `Neighbor overlap summary:\n${neighborDigest}` : "",
        generated ? `Model synthesis:\n${generated}` : ""
    ]
        .filter(Boolean)
        .join("\n\n");

    const confidenceBoost = Math.min(0.2, neighbors.length * 0.02 + (generated ? 0.04 : 0));

    return {
        title,
        summary: mergedSummary,
        content: mergedContent,
        tags: mergedTags,
        confidence: clamp01(candidateConfidence + confidenceBoost)
    };
}

function extractSchemaKeys(schemaHint: string): string[] {
    const matches = schemaHint.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? [];
    const blocked = new Set(["true", "false", "null", "undefined"]);

    const keys: string[] = [];
    for (const token of matches) {
        const lowered = token.toLowerCase();
        if (blocked.has(lowered)) {
            continue;
        }
        if (!keys.includes(token)) {
            keys.push(token);
        }
    }

    return keys.slice(0, 32);
}

function buildGenericOutput(runtime: RuntimeMiniLlmModel | null, user: string, schemaHint: string): UnknownRecord {
    const generated = runtime ? generateContinuation(runtime, user, 80) : compressorAgent(user, { maxChars: 160 });
    const keys = extractSchemaKeys(schemaHint);

    if (keys.length === 0) {
        return {
            content: generated,
            confidence: runtime ? 0.63 : 0.4
        };
    }

    const output: UnknownRecord = {};

    for (const key of keys) {
        const lowered = key.toLowerCase();

        if (lowered.includes("accepted") || lowered === "ok" || lowered.endsWith("enabled")) {
            output[key] = true;
            continue;
        }

        if (
            lowered.includes("score") ||
            lowered.includes("confidence") ||
            lowered.includes("novelty") ||
            lowered.includes("clarity") ||
            lowered.includes("redundancy")
        ) {
            output[key] = 0.58;
            continue;
        }

        if (lowered.includes("tags")) {
            output[key] = extractTopTags(generated, 6);
            continue;
        }

        if (lowered.includes("action")) {
            output[key] = "store";
            continue;
        }

        if (lowered.includes("reason")) {
            output[key] = "mini-llm-generic";
            continue;
        }

        if (lowered.includes("title")) {
            output[key] = compressorAgent(generated, { maxChars: 80, preserveLineBreaks: false });
            continue;
        }

        output[key] = generated;
    }

    return output;
}

const cortexaMiniLlmClient: LLMClient = {
    async completeJson<T>(params: {
        system: string;
        user: string;
        schemaHint: string;
    }): Promise<T> {
        const runtimeConfig = resolveRuntimeConfig();
        if (runtimeConfig.mode === "disabled") {
            throw new Error("mini-llm-disabled");
        }

        const runtime = await ensureRuntime(`${params.system}\n${params.user}`);
        const payload = parseUserPayload(params.user);
        const schema = params.schemaHint.toLowerCase();

        let output: UnknownRecord;

        if (schema.includes("candidates")) {
            output = buildWriterOutput(runtime, payload);
        } else if (schema.includes("accepted") && schema.includes("novelty") && schema.includes("clarity")) {
            output = buildCriticOutput(runtime, payload);
        } else if (schema.includes("title") && schema.includes("summary") && schema.includes("content") && schema.includes("confidence")) {
            output = buildConsolidatorOutput(runtime, payload);
        } else {
            output = buildGenericOutput(runtime, params.user, params.schemaHint);
        }

        return output as T;
    }
};

export function getCortexaLlmClient(): LLMClient {
    return cortexaMiniLlmClient;
}

export async function trainMiniLlm(options: MiniLlmTrainOptions = {}): Promise<MiniLlmTrainResult> {
    const startedAt = Date.now();
    const config = resolveTrainConfig(options);

    const project = collectProjectCorpus(config);
    const memory = await collectMemoryCorpus(config);
    const dataset = await collectDatasetCorpus(config);

    const snippets = [
        ...applyCorpusWeight(project.snippets, DEFAULT_PROJECT_CORPUS_WEIGHT),
        ...applyCorpusWeight(memory.snippets, DEFAULT_MEMORY_CORPUS_WEIGHT),
        ...dataset.snippets
    ];
    const sourceCount = project.sourceCount + memory.sourceCount + dataset.sourceCount;
    const corpusChars = project.corpusChars + memory.corpusChars + dataset.corpusChars;

    if (snippets.length === 0) {
        throw new Error("No training corpus discovered. Add files or enable memory/dataset sources.");
    }

    const model = buildModel(snippets, sourceCount, corpusChars, {
        maxVocab: config.maxVocab,
        maxTransitionsPerToken: config.maxTransitionsPerToken
    });

    await fsp.mkdir(path.dirname(config.modelPath), { recursive: true });
    await fsp.writeFile(config.modelPath, JSON.stringify(model), "utf8");

    const stat = await fsp.stat(config.modelPath);
    runtimeCache = hydrateRuntime(model, config.modelPath, stat.mtimeMs, false);

    const totalBranching = model.rows.reduce((acc, row) => acc + row.to.length, 0);
    const averageBranchingFactor = model.rows.length > 0 ? totalBranching / model.rows.length : 0;

    return {
        modelPath: config.modelPath,
        sourceCount: model.sourceCount,
        corpusChars: model.corpusChars,
        tokenCount: model.tokenCount,
        vocabSize: model.vocab.length,
        transitionRows: model.rows.length,
        averageBranchingFactor,
        durationMs: Date.now() - startedAt,
        warnings: [...project.warnings, ...memory.warnings, ...dataset.warnings]
    };
}

export async function generateMiniLlmText(seedText: string, options: MiniLlmGenerateOptions = {}): Promise<string> {
    const normalized = readString(seedText, 20_000);
    if (!normalized) {
        throw new Error("Missing required seed text");
    }

    const runtime = await ensureRuntime(normalized);
    if (!runtime) {
        throw new Error("mini-llm-runtime-unavailable");
    }

    const maxTokens = clampInt(options.maxTokens, 72, 8, 256);
    return generateContinuation(runtime, normalized, maxTokens);
}

export function getMiniLlmStatus(): MiniLlmStatus {
    const runtimeConfig = resolveRuntimeConfig();
    const modelExists = fs.existsSync(runtimeConfig.modelPath);

    return {
        mode: runtimeConfig.mode,
        enabled: runtimeConfig.mode !== "disabled",
        modelPath: runtimeConfig.modelPath,
        modelExists,
        loaded: Boolean(runtimeCache && !runtimeCache.ephemeral && runtimeCache.path === runtimeConfig.modelPath),
        ephemeralLoaded: Boolean(runtimeCache?.ephemeral),
        vocabSize: runtimeCache?.model.vocab.length,
        transitionRows: runtimeCache?.model.rows.length,
        tokenCount: runtimeCache?.model.tokenCount,
        sourceCount: runtimeCache?.model.sourceCount
    };
}

export function resetMiniLlmRuntimeCacheForTests(): void {
    runtimeCache = null;
}
