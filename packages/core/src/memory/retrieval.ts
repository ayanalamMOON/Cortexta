import type { MemoryAtom } from "../types/memory";

export interface ScoreMemoryOptions {
    now?: number;
    query?: string;
    projectId?: string;
    preferredTags?: string[];
}

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 1);
}

export function lexicalSimilarity(query: string, atom: MemoryAtom): number {
    const q = query.trim().toLowerCase();
    if (!q) return 0;

    const title = atom.title.toLowerCase();
    const summary = atom.summary.toLowerCase();
    const content = atom.content.toLowerCase();

    let score = 0;
    if (title.includes(q)) score += 0.45;
    if (summary.includes(q)) score += 0.35;
    if (content.includes(q)) score += 0.2;

    const qTokens = tokenize(q);
    if (qTokens.length > 0) {
        const corpus = new Set<string>([...tokenize(title), ...tokenize(summary), ...tokenize(content)]);
        const overlap = qTokens.filter((token) => corpus.has(token)).length;
        score += (overlap / qTokens.length) * 0.35;
    }

    return Math.min(1, score);
}

export function scoreMemory(atom: MemoryAtom, options: ScoreMemoryOptions = {}): number {
    const now = options.now ?? Date.now();
    const ageHours = Math.max(0, (now - atom.lastAccessedAt) / 3_600_000);
    const recency = Math.exp(-0.06 * ageHours);
    const lexical = options.query ? lexicalSimilarity(options.query, atom) : 0;
    const projectBonus = options.projectId && atom.projectId === options.projectId ? 0.06 : 0;
    const tagBoost = options.preferredTags?.length
        ? Math.min(
            0.12,
            options.preferredTags.filter((tag) => atom.tags.some((t) => t.toLowerCase() === tag.toLowerCase())).length * 0.04
        )
        : 0;

    const score = atom.importance * 0.38 + atom.confidence * 0.24 + recency * 0.18 + lexical * 0.2 + projectBonus + tagBoost;
    return Number(score.toFixed(6));
}

export function sortByScore(memories: MemoryAtom[], options: ScoreMemoryOptions = {}): MemoryAtom[] {
    return [...memories].sort((a, b) => scoreMemory(b, options) - scoreMemory(a, options));
}
