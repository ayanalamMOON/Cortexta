import type { MemoryAtom } from "../types/memory";

function normalize(text: string): string {
    return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function shingle(text: string): Set<string> {
    const clean = normalize(text);
    const tokens = clean.split(/[^a-z0-9_]+/).filter((t) => t.length > 1);
    const grams = new Set<string>();
    for (let i = 0; i < tokens.length; i += 1) {
        grams.add(tokens[i]);
        if (i + 1 < tokens.length) {
            grams.add(`${tokens[i]} ${tokens[i + 1]}`);
        }
    }
    return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;

    let intersection = 0;
    for (const token of a) {
        if (b.has(token)) intersection += 1;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

function merge(base: MemoryAtom, incoming: MemoryAtom): MemoryAtom {
    const keepIncomingSummary = incoming.summary.length > base.summary.length;
    const keepIncomingContent = incoming.content.length > base.content.length;

    return {
        ...base,
        title: keepIncomingSummary ? incoming.title : base.title,
        summary: keepIncomingSummary ? incoming.summary : base.summary,
        content: keepIncomingContent ? incoming.content : base.content,
        tags: [...new Set([...base.tags, ...incoming.tags])],
        importance: Math.max(base.importance, incoming.importance),
        confidence: Math.max(base.confidence, incoming.confidence),
        createdAt: Math.min(base.createdAt, incoming.createdAt),
        lastAccessedAt: Math.max(base.lastAccessedAt, incoming.lastAccessedAt),
        sourceRef: base.sourceRef ?? incoming.sourceRef,
        embeddingRef: base.embeddingRef ?? incoming.embeddingRef
    };
}

export function consolidateMemories(memories: MemoryAtom[]): MemoryAtom[] {
    const out: MemoryAtom[] = [];

    for (const m of memories) {
        const key = `${m.projectId}:${m.kind}:${normalize(m.title)}`;
        const shingles = shingle(`${m.title}\n${m.summary}`);

        let merged = false;
        for (let i = 0; i < out.length; i += 1) {
            const existing = out[i];
            if (existing.projectId !== m.projectId || existing.kind !== m.kind) {
                continue;
            }

            const exactKey = `${existing.projectId}:${existing.kind}:${normalize(existing.title)}`;
            const similarity = jaccard(shingle(`${existing.title}\n${existing.summary}`), shingles);

            if (exactKey === key || similarity >= 0.72) {
                out[i] = merge(existing, m);
                merged = true;
                break;
            }
        }

        if (!merged) {
            out.push(m);
        }
    }

    return out;
}
