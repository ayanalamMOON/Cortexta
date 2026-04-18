export interface ChromaCollection {
    id: string;
    name: string;
    metadata?: Record<string, unknown>;
}

export interface ChromaUpsertItem {
    id: string;
    embedding: number[];
    document?: string;
    metadata?: Record<string, unknown>;
}

export interface ChromaQueryResult {
    ids: string[];
    distances?: number[];
    documents?: string[];
    metadatas?: Array<Record<string, unknown>>;
}

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

export function chromaEndpoint(url = readEnv("CORTEXA_CHROMA_URL") ?? "http://localhost:8001"): string {
    return url.replace(/\/+$/, "");
}

async function chromaRequest<T>(route: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${chromaEndpoint()}${route}`, {
        ...init,
        headers: {
            "Content-Type": "application/json",
            ...(init?.headers ?? {})
        }
    });

    const raw = await response.text();
    const body = raw ? (JSON.parse(raw) as unknown) : {};

    if (!response.ok) {
        throw new Error(`Chroma request failed (${response.status} ${response.statusText}) on ${route}: ${raw}`);
    }

    return body as T;
}

export async function listChromaCollections(): Promise<ChromaCollection[]> {
    return chromaRequest<ChromaCollection[]>("/api/v1/collections", { method: "GET" });
}

export async function createChromaCollection(
    name: string,
    metadata?: Record<string, unknown>
): Promise<ChromaCollection> {
    return chromaRequest<ChromaCollection>("/api/v1/collections", {
        method: "POST",
        body: JSON.stringify({ name, metadata })
    });
}

export async function getOrCreateChromaCollection(
    name: string,
    metadata?: Record<string, unknown>
): Promise<ChromaCollection> {
    const all = await listChromaCollections();
    const found = all.find((c) => c.name === name);
    if (found) {
        return found;
    }
    return createChromaCollection(name, metadata);
}

export async function upsertChroma(
    collectionId: string,
    items: ChromaUpsertItem[]
): Promise<void> {
    if (items.length === 0) {
        return;
    }

    await chromaRequest(`/api/v1/collections/${collectionId}/upsert`, {
        method: "POST",
        body: JSON.stringify({
            ids: items.map((i) => i.id),
            embeddings: items.map((i) => i.embedding),
            documents: items.map((i) => i.document ?? ""),
            metadatas: items.map((i) => i.metadata ?? {})
        })
    });
}

export async function queryChroma(
    collectionId: string,
    queryEmbedding: number[],
    nResults = 10
): Promise<ChromaQueryResult> {
    const payload = await chromaRequest<{
        ids?: string[][];
        distances?: number[][];
        documents?: string[][];
        metadatas?: Array<Array<Record<string, unknown>>>;
    }>(`/api/v1/collections/${collectionId}/query`, {
        method: "POST",
        body: JSON.stringify({
            query_embeddings: [queryEmbedding],
            n_results: nResults,
            include: ["documents", "metadatas", "distances"]
        })
    });

    return {
        ids: payload.ids?.[0] ?? [],
        distances: payload.distances?.[0] ?? [],
        documents: payload.documents?.[0] ?? [],
        metadatas: payload.metadatas?.[0] ?? []
    };
}
