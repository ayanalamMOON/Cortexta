import type { MemoryRecord } from "./memory.types";

export function consolidate(memories: MemoryRecord[]): MemoryRecord[] {
    const byKey = new Map<string, MemoryRecord>();

    for (const memory of memories) {
        const key = `${memory.projectId}:${memory.kind}:${memory.title.toLowerCase().trim()}`;
        const existing = byKey.get(key);

        if (!existing) {
            byKey.set(key, memory);
            continue;
        }

        const merged: MemoryRecord = {
            ...existing,
            summary: existing.summary.length >= memory.summary.length ? existing.summary : memory.summary,
            content: existing.content.length >= memory.content.length ? existing.content : memory.content,
            tags: [...new Set([...existing.tags, ...memory.tags])],
            importance: Math.max(existing.importance, memory.importance),
            confidence: Math.max(existing.confidence, memory.confidence),
            lastAccessedAt: Math.max(existing.lastAccessedAt, memory.lastAccessedAt)
        };

        byKey.set(key, merged);
    }

    return [...byKey.values()];
}
