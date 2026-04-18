import { searchMemories } from "../mempalace/memory.service";
import type { ScoredMemory } from "../mempalace/memory.types";
import { dedupeById, filterByMinScore, filterByProject, filterNonEmpty } from "./filters";
import { rankMemories } from "./ranking";

export interface RetrieveOptions {
    projectId?: string;
    topK?: number;
    minScore?: number;
}

export async function retrieveTopK(query: string, options: RetrieveOptions = {}): Promise<ScoredMemory[]> {
    const rows = await searchMemories(query, {
        projectId: options.projectId,
        topK: (options.topK ?? 10) * 3,
        minScore: options.minScore
    });

    const filtered = filterByMinScore(
        dedupeById(filterByProject(filterNonEmpty(rows), options.projectId)),
        options.minScore ?? 0
    );

    return rankMemories(filtered).slice(0, options.topK ?? 10);
}
