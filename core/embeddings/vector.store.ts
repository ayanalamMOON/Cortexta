import {
    getOrCreateChromaCollection,
    queryChroma,
    upsertChroma
} from "../../storage/vector/chroma";
import {
    deleteQdrantPoints,
    ensureQdrantCollection,
    searchQdrant,
    upsertQdrantPoints
} from "../../storage/vector/qdrant";

export type VectorProvider = "qdrant" | "chroma" | "memory";

export interface VectorItem {
    id: string;
    vector: number[];
    payload?: Record<string, unknown>;
}

export interface VectorSearchHit {
    id: string;
    score: number;
    payload?: Record<string, unknown>;
}

const inMemoryCollections = new Map<string, Map<string, VectorItem>>();
const chromaCollectionIds = new Map<string, string>();
const initializedCollections = new Set<string>();

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    const length = Math.min(a.length, b.length);

    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < length; i += 1) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function resolveProvider(): VectorProvider {
    const configured = (readEnv("CORTEXA_VECTOR_PROVIDER") ?? "qdrant").toLowerCase();
    if (configured === "chroma") return "chroma";
    if (configured === "memory") return "memory";
    return "qdrant";
}

function memoryCollection(name: string): Map<string, VectorItem> {
    const existing = inMemoryCollections.get(name);
    if (existing) return existing;
    const created = new Map<string, VectorItem>();
    inMemoryCollections.set(name, created);
    return created;
}

async function resolveChromaCollectionId(collection: string): Promise<string> {
    const existing = chromaCollectionIds.get(collection);
    if (existing) {
        return existing;
    }

    const record = await getOrCreateChromaCollection(collection, {
        createdBy: "cortexa"
    });
    chromaCollectionIds.set(collection, record.id);
    return record.id;
}

export async function ensureVectorCollection(collection: string, dimension = 256): Promise<void> {
    const key = `${resolveProvider()}:${collection}`;
    if (initializedCollections.has(key)) {
        return;
    }

    const provider = resolveProvider();

    if (provider === "qdrant") {
        await ensureQdrantCollection({
            collection,
            dimension,
            distance: "Cosine"
        });
    } else if (provider === "chroma") {
        await resolveChromaCollectionId(collection);
    } else {
        memoryCollection(collection);
    }

    initializedCollections.add(key);
}

export async function upsertVectorItem(collection: string, item: VectorItem): Promise<void> {
    await upsertVectorItems(collection, [item]);
}

export async function upsertVectorItems(collection: string, items: VectorItem[]): Promise<void> {
    if (items.length === 0) {
        return;
    }

    const provider = resolveProvider();

    if (provider === "qdrant") {
        await upsertQdrantPoints(
            collection,
            items.map((item) => ({
                id: item.id,
                vector: item.vector,
                payload: item.payload
            }))
        );
        return;
    }

    if (provider === "chroma") {
        const collectionId = await resolveChromaCollectionId(collection);
        await upsertChroma(
            collectionId,
            items.map((item) => ({
                id: item.id,
                embedding: item.vector,
                document: typeof item.payload?.summary === "string" ? String(item.payload.summary) : undefined,
                metadata: item.payload
            }))
        );
        return;
    }

    const bucket = memoryCollection(collection);
    for (const item of items) {
        bucket.set(item.id, item);
    }
}

export async function searchVectorItems(
    collection: string,
    vector: number[],
    limit = 10
): Promise<VectorSearchHit[]> {
    const provider = resolveProvider();

    if (provider === "qdrant") {
        const hits = await searchQdrant(collection, vector, limit);
        return hits.map((hit) => ({
            id: String(hit.id),
            score: hit.score,
            payload: hit.payload
        }));
    }

    if (provider === "chroma") {
        const collectionId = await resolveChromaCollectionId(collection);
        const result = await queryChroma(collectionId, vector, limit);
        return result.ids.map((id, index) => ({
            id,
            score: Math.max(0, 1 - (result.distances?.[index] ?? 1)),
            payload: result.metadatas?.[index]
        }));
    }

    const bucket = memoryCollection(collection);
    const ranked = [...bucket.values()]
        .map<VectorSearchHit>((item) => ({
            id: item.id,
            score: cosineSimilarity(vector, item.vector),
            payload: item.payload
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    return ranked;
}

export async function deleteVectorItems(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) {
        return;
    }

    const provider = resolveProvider();

    if (provider === "qdrant") {
        await deleteQdrantPoints(collection, ids);
        return;
    }

    if (provider === "memory") {
        const bucket = memoryCollection(collection);
        for (const id of ids) {
            bucket.delete(id);
        }
        return;
    }

    // Chroma delete can be added similarly; for now this is a non-blocking no-op fallback.
}
