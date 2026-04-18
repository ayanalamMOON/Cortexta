import { embedBatch } from "../core/embeddings/embedder";
import { ensureVectorCollection, upsertVectorItems } from "../core/embeddings/vector.store";
import { listMemories } from "../core/mempalace/memory.service";

export async function buildIndex(): Promise<void> {
    const memories = listMemories(undefined, 5_000);
    if (memories.length === 0) {
        console.log("[cortexa] no memories found; index rebuild skipped");
        return;
    }

    await ensureVectorCollection("cortexa_memories", 256);

    const texts = memories.map((memory) => `${memory.title}\n${memory.summary}\n${memory.content}`);
    const vectors = await embedBatch(texts, { dimensions: 256 });

    await upsertVectorItems(
        "cortexa_memories",
        memories.map((memory, index) => ({
            id: memory.id,
            vector: vectors[index] ?? [],
            payload: {
                projectId: memory.projectId,
                kind: memory.kind,
                title: memory.title,
                summary: memory.summary,
                importance: memory.importance,
                confidence: memory.confidence,
                sourceRef: memory.sourceRef ?? null
            }
        }))
    );

    console.log(`[cortexa] vector index rebuilt for ${memories.length} memories`);
}

if (require.main === module) {
    void buildIndex();
}
