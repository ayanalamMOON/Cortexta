import type { MemoryAtom } from "../types/memory";

export interface RerankOptions {
    query?: string;
    now?: number;
    topK?: number;
    favorRecent?: boolean;
    diversifyByKind?: boolean;
}

function normalizeRecency(lastAccessedAt: number, now: number): number {
    const ageHours = Math.max(0, (now - lastAccessedAt) / 3_600_000);
    return Math.exp(-0.07 * ageHours);
}

function lexicalAffinity(query: string | undefined, atom: MemoryAtom): number {
    if (!query || !query.trim()) return 0;
    const q = query.toLowerCase();
    let score = 0;

    if (atom.title.toLowerCase().includes(q)) score += 0.6;
    if (atom.summary.toLowerCase().includes(q)) score += 0.3;
    if (atom.content.toLowerCase().includes(q)) score += 0.1;

    return Math.min(1, score);
}

export function rerankBySignal(memories: MemoryAtom[], options: RerankOptions = {}): MemoryAtom[] {
    const now = options.now ?? Date.now();

    const scored = memories.map((memory, index) => {
        const recency = options.favorRecent === false ? 0.5 : normalizeRecency(memory.lastAccessedAt, now);
        const lexical = lexicalAffinity(options.query, memory);
        const signal = memory.importance * 0.42 + memory.confidence * 0.28 + recency * 0.2 + lexical * 0.1;

        return {
            memory,
            signal,
            recency,
            lexical,
            index
        };
    });

    scored.sort((a, b) => {
        if (b.signal !== a.signal) return b.signal - a.signal;
        if (b.lexical !== a.lexical) return b.lexical - a.lexical;
        if (b.recency !== a.recency) return b.recency - a.recency;
        return a.index - b.index;
    });

    if (options.diversifyByKind) {
        const buckets = new Map<MemoryAtom["kind"], MemoryAtom[]>();
        for (const row of scored) {
            const list = buckets.get(row.memory.kind) ?? [];
            list.push(row.memory);
            buckets.set(row.memory.kind, list);
        }

        const merged: MemoryAtom[] = [];
        while (true) {
            let appended = false;

            for (const [kind, list] of buckets) {
                const next = list.shift();
                if (!next) {
                    buckets.delete(kind);
                    continue;
                }
                merged.push(next);
                appended = true;
            }

            if (!appended) break;
        }

        return merged.slice(0, options.topK ?? merged.length);
    }

    return scored.map((row) => row.memory).slice(0, options.topK ?? scored.length);
}
