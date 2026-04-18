import crypto from "node:crypto";
import zlib from "node:zlib";
import { compressSummary } from "../context/compressor";

export const COMPACT_PREFIX = "cortexa://mem/compact/v1/";
const DEFAULT_MIN_COMPACT_SOURCE_CHARS = 256;
const DEFAULT_MIN_COMPACT_WIN_RATIO = 0.92;
const DEFAULT_PREVIEW_CHARS = 320;
const DEFAULT_COPILOT_PREVIEW_CHARS = 280;
const DEFAULT_BROTLI_QUALITY = 5;

interface CompactEnvelopeV1 {
    v: 1;
    codec: "br64";
    originalChars: number;
    preview: string;
    payload: string;
    checksum?: string;
}

export interface CompactionConfig {
    minSourceChars: number;
    minWinRatio: number;
    previewChars: number;
    copilotPreviewChars: number;
    brotliQuality: number;
}

export interface CompactionAnalysis {
    isCompacted: boolean;
    storedChars: number;
    originalChars: number;
    savedChars: number;
    preview: string;
    integrity: "not_compacted" | "valid" | "invalid_checksum" | "decode_error";
    compressionRatio: number;
}

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

function toPositiveInteger(value: unknown): number | undefined {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return undefined;
    }
    return Math.floor(parsed);
}

function toBoundedNumber(value: unknown, min: number, max: number): number | undefined {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
        return undefined;
    }

    return Math.min(max, Math.max(min, parsed));
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function checksumOfText(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex").slice(0, 24);
}

export function getCompactionConfig(overrides: Partial<CompactionConfig> = {}): CompactionConfig {
    return {
        minSourceChars:
            overrides.minSourceChars ??
            toPositiveInteger(readEnv("CORTEXA_MEM_COMPACT_MIN_CHARS")) ??
            DEFAULT_MIN_COMPACT_SOURCE_CHARS,
        minWinRatio:
            overrides.minWinRatio ??
            toBoundedNumber(readEnv("CORTEXA_MEM_COMPACT_MIN_WIN_RATIO"), 0.3, 0.99) ??
            DEFAULT_MIN_COMPACT_WIN_RATIO,
        previewChars:
            overrides.previewChars ??
            toPositiveInteger(readEnv("CORTEXA_MEM_COMPACT_PREVIEW_CHARS")) ??
            DEFAULT_PREVIEW_CHARS,
        copilotPreviewChars:
            overrides.copilotPreviewChars ??
            toPositiveInteger(readEnv("CORTEXA_MEM_COPILOT_PREVIEW_CHARS")) ??
            DEFAULT_COPILOT_PREVIEW_CHARS,
        brotliQuality: clamp(
            overrides.brotliQuality ??
            toPositiveInteger(readEnv("CORTEXA_MEM_COMPACT_BROTLI_QUALITY")) ??
            DEFAULT_BROTLI_QUALITY,
            1,
            11
        )
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toPreview(text: string, maxChars = 320): string {
    const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
    if (!normalized) {
        return "";
    }

    const lines = normalized
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 6);

    const joined = lines.join(" | ");
    return joined.length <= maxChars ? joined : `${joined.slice(0, Math.max(0, maxChars - 1))}…`;
}

function decodeEnvelopePayload(
    envelope: CompactEnvelopeV1
): {
    restored: string;
    integrity: "valid" | "invalid_checksum" | "decode_error";
} {
    try {
        const compressed = Buffer.from(envelope.payload, "base64");
        const restored = zlib.brotliDecompressSync(compressed).toString("utf8");
        if (envelope.checksum && checksumOfText(restored) !== envelope.checksum) {
            return {
                restored: envelope.preview,
                integrity: "invalid_checksum"
            };
        }

        return {
            restored,
            integrity: "valid"
        };
    } catch {
        return {
            restored: envelope.preview,
            integrity: "decode_error"
        };
    }
}

function parseEnvelope(value: string): CompactEnvelopeV1 | null {
    if (!value.startsWith(COMPACT_PREFIX)) {
        return null;
    }

    try {
        const encoded = value.slice(COMPACT_PREFIX.length);
        const decoded = Buffer.from(encoded, "base64url").toString("utf8");
        const parsed = JSON.parse(decoded) as unknown;
        if (!isRecord(parsed)) {
            return null;
        }

        if (
            parsed.v !== 1 ||
            parsed.codec !== "br64" ||
            typeof parsed.originalChars !== "number" ||
            !Number.isFinite(parsed.originalChars) ||
            parsed.originalChars < 0 ||
            typeof parsed.preview !== "string" ||
            typeof parsed.payload !== "string" ||
            (parsed.checksum !== undefined && typeof parsed.checksum !== "string") ||
            !parsed.payload.trim()
        ) {
            return null;
        }

        return {
            v: 1,
            codec: "br64",
            originalChars: Math.floor(parsed.originalChars),
            preview: parsed.preview,
            payload: parsed.payload,
            checksum: parsed.checksum ? String(parsed.checksum) : undefined
        };
    } catch {
        return null;
    }
}

export function isCompactedContent(value: string): boolean {
    return parseEnvelope(value) !== null;
}

export function compactContentForStorage(content: string): string {
    const config = getCompactionConfig();

    if (!content || content.length < config.minSourceChars) {
        return content;
    }

    if (isCompactedContent(content)) {
        return content;
    }

    const source = Buffer.from(content, "utf8");

    let compressed: Buffer;
    try {
        compressed = zlib.brotliCompressSync(source, {
            params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: config.brotliQuality
            }
        });
    } catch {
        return content;
    }

    const envelope: CompactEnvelopeV1 = {
        v: 1,
        codec: "br64",
        originalChars: content.length,
        preview: toPreview(content, config.previewChars),
        payload: compressed.toString("base64"),
        checksum: checksumOfText(content)
    };

    const encodedEnvelope = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
    const wrapped = `${COMPACT_PREFIX}${encodedEnvelope}`;

    const winRatio = wrapped.length / Math.max(1, content.length);
    return winRatio <= config.minWinRatio ? wrapped : content;
}

export function resurrectContentFromStorage(value: string): string {
    const envelope = parseEnvelope(value);
    if (!envelope) {
        return value;
    }

    const decoded = decodeEnvelopePayload(envelope);
    return decoded.restored || envelope.preview || value;
}

export function resurrectContentForCopilot(value: string, maxChars = 280): string {
    const charLimit = Math.max(32, Math.floor(maxChars));
    const envelope = parseEnvelope(value);
    if (!envelope) {
        return compressSummary(value, charLimit);
    }

    if (envelope.preview) {
        return compressSummary(envelope.preview, charLimit);
    }

    return compressSummary(resurrectContentFromStorage(value), charLimit);
}

export function analyzeStoredContent(value: string): CompactionAnalysis {
    const storedChars = value.length;
    const envelope = parseEnvelope(value);

    if (!envelope) {
        return {
            isCompacted: false,
            storedChars,
            originalChars: storedChars,
            savedChars: 0,
            preview: compressSummary(value, 140),
            integrity: "not_compacted",
            compressionRatio: 1
        };
    }

    const decoded = decodeEnvelopePayload(envelope);
    const originalChars = Math.max(envelope.originalChars, storedChars);
    const savedChars = Math.max(0, originalChars - storedChars);

    return {
        isCompacted: true,
        storedChars,
        originalChars,
        savedChars,
        preview: envelope.preview,
        integrity: decoded.integrity,
        compressionRatio: storedChars / Math.max(1, originalChars)
    };
}
