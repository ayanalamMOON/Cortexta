import { minimatch, type MinimatchOptions } from "minimatch";
import fs from "node:fs";
import path from "node:path";

export interface IngestPolicyChat {
    enabled?: boolean;
    roots?: string[];
    maxFiles?: number;
}

export interface IngestPolicyRedaction {
    maskSecrets?: boolean;
    maskPII?: boolean;
    customPatterns?: string[];
}

export interface IngestPolicy {
    includeGlobs?: string[];
    excludeGlobs?: string[];
    maxFileBytes?: number;
    languages?: string[];
    chat?: IngestPolicyChat;
    redaction?: IngestPolicyRedaction;
}

export interface IngestPolicyResolution {
    policyPath?: string;
    policy?: IngestPolicy;
    errors: string[];
    warnings: string[];
}

export interface IngestPolicyRuntime {
    policyPath?: string;
    policy?: IngestPolicy;
    errors: string[];
    warnings: string[];
    maxFileBytes?: number;
    allowedExtensions?: Set<string>;
    shouldIncludePath: (filePath: string) => boolean;
    chatEnabled?: boolean;
    chatRoots?: string[];
    maxChatFiles?: number;
    redact: (value: string) => { text: string; redacted: boolean };
}

const DEFAULT_POLICY_FILE = "cortexa.policy.json";
const DEFAULT_GLOB_OPTIONS: MinimatchOptions = {
    dot: true,
    nocase: true,
    matchBase: true
};

const LANGUAGE_EXTENSION_MAP: Record<string, string[]> = {
    typescript: [".ts", ".tsx"],
    javascript: [".js", ".jsx"],
    python: [".py"],
    java: [".java"],
    go: [".go"],
    rust: [".rs"],
    cpp: [".cpp", ".cc", ".cxx", ".hpp", ".h"],
    c: [".c", ".h"],
    csharp: [".cs"],
    ruby: [".rb"],
    php: [".php"],
    kotlin: [".kt", ".kts"],
    swift: [".swift"]
};

const SECRET_REDACTIONS: Array<{ pattern: RegExp; replace: string | ((match: string, key?: string) => string) }> = [
    { pattern: /\bsk-[a-z0-9]{20,}\b/gi, replace: "[REDACTED_SECRET]" },
    { pattern: /\bghp_[a-z0-9]{20,}\b/gi, replace: "[REDACTED_SECRET]" },
    { pattern: /\bgho_[a-z0-9]{20,}\b/gi, replace: "[REDACTED_SECRET]" },
    { pattern: /\bgithub_pat_[a-z0-9_]{20,}\b/gi, replace: "[REDACTED_SECRET]" },
    { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[REDACTED_SECRET]" },
    { pattern: /\bASIA[0-9A-Z]{16}\b/g, replace: "[REDACTED_SECRET]" },
    { pattern: /\bAIza[0-9A-Za-z\-_]{20,}\b/g, replace: "[REDACTED_SECRET]" },
    { pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, replace: "[REDACTED_SECRET]" },
    {
        pattern: /\b(api[-_]?key|token|secret|password)\s*[:=]\s*([^\s'"`]{6,})/gi,
        replace: (_match: string, key?: string) => `${key ?? "secret"}=[REDACTED_SECRET]`
    }
];

const PII_REDACTIONS: RegExp[] = [
    /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
    /\b(?:\+?\d{1,3}[\s-]?)?(?:\(\d{2,4}\)[\s-]?)?\d{3}[\s-]?\d{4}\b/g
];

function normalizeSlashes(value: string): string {
    return value.replace(/\\/g, "/");
}

function toPositiveInteger(value: unknown): number | undefined {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return undefined;
    }
    return Math.floor(parsed);
}

function normalizeStringArray(value: unknown, field: string, errors: string[]): string[] | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (!Array.isArray(value)) {
        errors.push(`${field} must be an array of strings.`);
        return undefined;
    }

    const normalized = value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean);

    return normalized.length > 0 ? normalized : [];
}

function resolvePolicyPath(projectPath: string, policyPath?: string): string | undefined {
    if (policyPath) {
        return path.isAbsolute(policyPath)
            ? policyPath
            : path.resolve(projectPath, policyPath);
    }

    const candidate = path.join(projectPath, DEFAULT_POLICY_FILE);
    return fs.existsSync(candidate) ? candidate : undefined;
}

function validateIngestPolicy(raw: unknown): { policy?: IngestPolicy; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        errors.push("Policy must be a JSON object.");
        return { errors, warnings };
    }

    const record = raw as Record<string, unknown>;
    const policy: IngestPolicy = {};

    const includeGlobs = normalizeStringArray(record.includeGlobs, "includeGlobs", errors);
    if (includeGlobs) {
        policy.includeGlobs = includeGlobs;
    }

    const excludeGlobs = normalizeStringArray(record.excludeGlobs, "excludeGlobs", errors);
    if (excludeGlobs) {
        policy.excludeGlobs = excludeGlobs;
    }

    if (record.maxFileBytes !== undefined) {
        const parsed = toPositiveInteger(record.maxFileBytes);
        if (!parsed) {
            errors.push("maxFileBytes must be a positive integer.");
        } else {
            policy.maxFileBytes = parsed;
        }
    }

    const languages = normalizeStringArray(record.languages, "languages", errors);
    if (languages) {
        policy.languages = languages;
    }

    if (record.chat !== undefined) {
        if (!record.chat || typeof record.chat !== "object" || Array.isArray(record.chat)) {
            errors.push("chat must be an object when provided.");
        } else {
            const chatRecord = record.chat as Record<string, unknown>;
            const chat: IngestPolicyChat = {};

            if (chatRecord.enabled !== undefined) {
                if (typeof chatRecord.enabled !== "boolean") {
                    errors.push("chat.enabled must be a boolean.");
                } else {
                    chat.enabled = chatRecord.enabled;
                }
            }

            const roots = normalizeStringArray(chatRecord.roots, "chat.roots", errors);
            if (roots) {
                chat.roots = roots;
            }

            if (chatRecord.maxFiles !== undefined) {
                const parsed = toPositiveInteger(chatRecord.maxFiles);
                if (!parsed) {
                    errors.push("chat.maxFiles must be a positive integer.");
                } else {
                    chat.maxFiles = parsed;
                }
            }

            policy.chat = chat;
        }
    }

    if (record.redaction !== undefined) {
        if (!record.redaction || typeof record.redaction !== "object" || Array.isArray(record.redaction)) {
            errors.push("redaction must be an object when provided.");
        } else {
            const redactionRecord = record.redaction as Record<string, unknown>;
            const redaction: IngestPolicyRedaction = {};

            if (redactionRecord.maskSecrets !== undefined) {
                if (typeof redactionRecord.maskSecrets !== "boolean") {
                    errors.push("redaction.maskSecrets must be a boolean.");
                } else {
                    redaction.maskSecrets = redactionRecord.maskSecrets;
                }
            }

            if (redactionRecord.maskPII !== undefined) {
                if (typeof redactionRecord.maskPII !== "boolean") {
                    errors.push("redaction.maskPII must be a boolean.");
                } else {
                    redaction.maskPII = redactionRecord.maskPII;
                }
            }

            const patterns = normalizeStringArray(redactionRecord.customPatterns, "redaction.customPatterns", errors);
            if (patterns) {
                for (const pattern of patterns) {
                    try {
                        new RegExp(pattern);
                    } catch {
                        errors.push(`redaction.customPatterns contains invalid regex: ${pattern}`);
                    }
                }
                redaction.customPatterns = patterns;
            }

            policy.redaction = redaction;
        }
    }

    return { policy, errors, warnings };
}

function resolveLanguageExtensions(languages: string[] | undefined, warnings: string[]): Set<string> | undefined {
    if (!languages || languages.length === 0) {
        return undefined;
    }

    const resolved = new Set<string>();

    for (const entry of languages) {
        const normalized = entry.trim().toLowerCase();
        if (!normalized) {
            continue;
        }

        if (normalized.startsWith(".")) {
            resolved.add(normalized);
            continue;
        }

        if (normalized === "c++") {
            for (const ext of LANGUAGE_EXTENSION_MAP.cpp ?? []) {
                resolved.add(ext);
            }
            continue;
        }

        const shorthand = normalized.replace(/[^a-z0-9]/g, "");
        const matchedByExtension = shorthand.length <= 4 && /^[a-z0-9]+$/.test(shorthand);
        if (matchedByExtension) {
            resolved.add(`.${shorthand}`);
        }

        const mapped = LANGUAGE_EXTENSION_MAP[normalized] ?? LANGUAGE_EXTENSION_MAP[shorthand];
        if (mapped && mapped.length > 0) {
            for (const ext of mapped) {
                resolved.add(ext);
            }
            continue;
        }

        if (!matchedByExtension) {
            warnings.push(`Unknown language '${entry}' in ingestion policy.`);
        }
    }

    return resolved;
}

function buildPathMatcher(
    projectPath: string,
    includeGlobs: string[] | undefined,
    excludeGlobs: string[] | undefined
): (filePath: string) => boolean {
    const include = (includeGlobs ?? []).filter(Boolean);
    const exclude = (excludeGlobs ?? []).filter(Boolean);

    if (include.length === 0 && exclude.length === 0) {
        return () => true;
    }

    return (filePath: string) => {
        const relative = path.relative(projectPath, filePath);
        const candidate = relative.startsWith("..") || path.isAbsolute(relative)
            ? normalizeSlashes(filePath)
            : normalizeSlashes(relative);

        if (exclude.length > 0 && exclude.some((pattern) => minimatch(candidate, pattern, DEFAULT_GLOB_OPTIONS))) {
            return false;
        }

        if (include.length === 0) {
            return true;
        }

        return include.some((pattern) => minimatch(candidate, pattern, DEFAULT_GLOB_OPTIONS));
    };
}

function buildRedactor(redaction: IngestPolicyRedaction | undefined): (value: string) => { text: string; redacted: boolean } {
    if (!redaction?.maskSecrets && !redaction?.maskPII && (!redaction?.customPatterns || redaction.customPatterns.length === 0)) {
        return (value: string) => ({ text: value, redacted: false });
    }

    const customPatterns = (redaction?.customPatterns ?? []).map((pattern) => new RegExp(pattern, "g"));

    return (value: string) => {
        let output = value;
        let redacted = false;

        if (redaction?.maskSecrets) {
            for (const { pattern, replace } of SECRET_REDACTIONS) {
                const next =
                    typeof replace === "string"
                        ? output.replace(pattern, replace)
                        : output.replace(pattern, (...args) =>
                            replace(String(args[0]), typeof args[1] === "string" ? args[1] : undefined)
                        );
                if (next !== output) {
                    redacted = true;
                    output = next;
                }
            }
        }

        if (redaction?.maskPII) {
            for (const pattern of PII_REDACTIONS) {
                const next = output.replace(pattern, "[REDACTED_PII]");
                if (next !== output) {
                    redacted = true;
                    output = next;
                }
            }
        }

        if (customPatterns.length > 0) {
            for (const pattern of customPatterns) {
                const next = output.replace(pattern, "[REDACTED_CUSTOM]");
                if (next !== output) {
                    redacted = true;
                    output = next;
                }
            }
        }

        return { text: output, redacted };
    };
}

export function resolveIngestPolicy(options: {
    projectPath: string;
    policyPath?: string;
    policyOverride?: IngestPolicy;
}): IngestPolicyResolution {
    const projectRoot = path.resolve(options.projectPath);

    if (options.policyOverride) {
        const validated = validateIngestPolicy(options.policyOverride);
        return {
            policyPath: options.policyPath,
            policy: validated.policy,
            errors: validated.errors,
            warnings: validated.warnings
        };
    }

    const resolvedPath = resolvePolicyPath(projectRoot, options.policyPath);
    if (!resolvedPath) {
        if (options.policyPath) {
            return {
                policyPath: options.policyPath,
                errors: [`Policy file not found: ${options.policyPath}`],
                warnings: []
            };
        }

        return {
            errors: [],
            warnings: []
        };
    }

    if (!fs.existsSync(resolvedPath)) {
        return {
            policyPath: resolvedPath,
            errors: [`Policy file not found: ${resolvedPath}`],
            warnings: []
        };
    }

    try {
        const raw = fs.readFileSync(resolvedPath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        const validated = validateIngestPolicy(parsed);

        return {
            policyPath: resolvedPath,
            policy: validated.policy,
            errors: validated.errors,
            warnings: validated.warnings
        };
    } catch (error) {
        return {
            policyPath: resolvedPath,
            errors: [
                `Failed to parse policy file (${resolvedPath}): ${error instanceof Error ? error.message : String(error)}`
            ],
            warnings: []
        };
    }
}

export function buildIngestPolicyRuntime(options: {
    projectPath: string;
    resolution: IngestPolicyResolution;
}): IngestPolicyRuntime {
    const warnings = [...options.resolution.warnings];
    const policy = options.resolution.policy;

    const allowedExtensions = resolveLanguageExtensions(policy?.languages, warnings);
    const shouldIncludePath = buildPathMatcher(options.projectPath, policy?.includeGlobs, policy?.excludeGlobs);
    const redact = buildRedactor(policy?.redaction);

    return {
        policyPath: options.resolution.policyPath,
        policy,
        errors: options.resolution.errors,
        warnings,
        maxFileBytes: policy?.maxFileBytes,
        allowedExtensions,
        shouldIncludePath,
        chatEnabled: policy?.chat?.enabled,
        chatRoots: policy?.chat?.roots,
        maxChatFiles: policy?.chat?.maxFiles,
        redact
    };
}
