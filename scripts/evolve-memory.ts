import { consolidate } from "../core/mempalace/consolidation";
import { listMemories, upsertMemory } from "../core/mempalace/memory.service";

export async function evolveMemory(): Promise<void> {
    const source = listMemories(undefined, 5_000);
    const evolved = consolidate(source);

    for (const memory of evolved) {
        await upsertMemory({
            id: memory.id,
            projectId: memory.projectId,
            kind: memory.kind,
            sourceType: memory.sourceType,
            title: memory.title,
            summary: memory.summary,
            content: memory.content,
            tags: memory.tags,
            importance: memory.importance,
            confidence: memory.confidence,
            sourceRef: memory.sourceRef,
            embeddingRef: memory.embeddingRef
        });
    }

    console.log(`[cortexa] evolved memories source=${source.length} consolidated=${evolved.length}`);
}

if (require.main === module) {
    void evolveMemory();
}
