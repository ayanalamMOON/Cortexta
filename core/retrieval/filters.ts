import type { ScoredMemory } from "../mempalace/memory.types";

export function filterNonEmpty(rows: ScoredMemory[]): ScoredMemory[] {
    return rows.filter((row) => Boolean(row.summary.trim()));
}

export function filterByProject(rows: ScoredMemory[], projectId?: string): ScoredMemory[] {
    if (!projectId) {
        return rows;
    }

    return rows.filter((row) => row.projectId === projectId);
}

export function filterByMinScore(rows: ScoredMemory[], minScore = 0): ScoredMemory[] {
    return rows.filter((row) => row.score >= minScore);
}

export function dedupeById(rows: ScoredMemory[]): ScoredMemory[] {
    const map = new Map<string, ScoredMemory>();
    for (const row of rows) {
        const existing = map.get(row.id);
        if (!existing || row.score > existing.score) {
            map.set(row.id, row);
        }
    }
    return [...map.values()];
}
