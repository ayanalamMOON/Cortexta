import fetch from "node-fetch";

export type QdrantDistance = "Cosine" | "Dot" | "Euclid" | "Manhattan";

export interface VectorHit {
    id: string;
    score: number;
    payload?: Record<string, unknown>;
}

export interface VectorPoint {
    id: string;
    vector: number[];
    payload?: Record<string, unknown>;
}

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

function baseUrl(): string {
    return (readEnv("CORTEXA_VECTOR_URL") ?? "http://localhost:6333").replace(/\/+$/, "");
}

const COLLECTION = "cortexa_memories";

async function qdrantRequest<T>(route: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl()}${route}`, {
        ...init,
        headers: {
            "Content-Type": "application/json",
            ...(init?.headers ?? {})
        }
    });

    const raw = await res.text();
    if (!res.ok) {
        throw new Error(`Qdrant request failed (${res.status}): ${raw}`);
    }

    return (raw ? JSON.parse(raw) : {}) as T;
}

export async function collectionExists(collection = COLLECTION): Promise<boolean> {
    try {
        await qdrantRequest(`/collections/${collection}`, { method: "GET" });
        return true;
    } catch {
        return false;
    }
}

export async function initCollection(dim = 768, collection = COLLECTION, distance: QdrantDistance = "Cosine"): Promise<void> {
    if (await collectionExists(collection)) {
        return;
    }

    await qdrantRequest(`/collections/${collection}`, {
        method: "PUT",
        body: JSON.stringify({ vectors: { size: dim, distance } })
    });
}

export async function upsertVector(
    id: string,
    vector: number[],
    payload: Record<string, unknown>,
    collection = COLLECTION
): Promise<void> {
    await qdrantRequest(`/collections/${collection}/points?wait=true`, {
        method: "PUT",
        body: JSON.stringify({ points: [{ id, vector, payload }] })
    });
}

export async function upsertVectors(points: VectorPoint[], collection = COLLECTION): Promise<void> {
    if (points.length === 0) return;
    await qdrantRequest(`/collections/${collection}/points?wait=true`, {
        method: "PUT",
        body: JSON.stringify({ points })
    });
}

export async function searchVector(vector: number[], limit = 10, collection = COLLECTION): Promise<VectorHit[]> {
    const data = await qdrantRequest<{
        result?: Array<{ id: string | number; score: number; payload?: Record<string, unknown> }>;
    }>(`/collections/${collection}/points/search`, {
        method: "POST",
        body: JSON.stringify({ vector, limit, with_payload: true })
    });

    return (data.result ?? []).map((item) => ({
        id: String(item.id),
        score: item.score,
        payload: item.payload
    }));
}

export async function deleteVector(id: string, collection = COLLECTION): Promise<void> {
    await qdrantRequest(`/collections/${collection}/points/delete?wait=true`, {
        method: "POST",
        body: JSON.stringify({ points: [id] })
    });
}

export async function vectorStoreHealthy(): Promise<boolean> {
    try {
        await qdrantRequest("/collections", { method: "GET" });
        return true;
    } catch {
        return false;
    }
}
