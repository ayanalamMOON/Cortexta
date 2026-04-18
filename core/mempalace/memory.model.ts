import { clampImportance } from "../scoring/importance";
import type { CreateMemoryInput, MemoryRecord } from "./memory.types";

function randomId(prefix = "mem"): string {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function stringifyTags(tags: string[]): string {
    return JSON.stringify([...new Set(tags.map((t) => t.trim()).filter(Boolean))]);
}

export function parseTags(raw: unknown): string[] {
    if (!raw) return [];

    if (Array.isArray(raw)) {
        return raw.map(String).map((tag) => tag.trim()).filter(Boolean);
    }

    if (typeof raw === "string") {
        const text = raw.trim();
        if (!text) return [];

        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) {
                return parsed.map(String).map((tag) => tag.trim()).filter(Boolean);
            }
        } catch {
            // Fallback to comma-separated values.
        }

        return text
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean);
    }

    return [];
}

export function createMemory(input: CreateMemoryInput): MemoryRecord {
    const now = Date.now();

    return {
        id: input.id ?? randomId(),
        projectId: input.projectId ?? "default",
        kind: input.kind,
        sourceType: input.sourceType ?? "manual",
        title: input.title.trim(),
        summary: input.summary.trim(),
        content: input.content,
        tags: input.tags?.length ? [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))] : [],
        importance: clampImportance(input.importance ?? 0.6),
        confidence: clampImportance(input.confidence ?? 0.75),
        createdAt: now,
        lastAccessedAt: now,
        embeddingRef: input.embeddingRef,
        sourceRef: input.sourceRef,
        embedding: input.embedding
    };
}
