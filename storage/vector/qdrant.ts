export type QdrantDistance = "Cosine" | "Euclid" | "Dot" | "Manhattan";

export interface QdrantPoint {
    id: string | number;
    vector: number[];
    payload?: Record<string, unknown>;
}

export interface QdrantSearchResult {
    id: string | number;
    score: number;
    payload?: Record<string, unknown>;
    vector?: number[];
}

interface QdrantResponse<T> {
    result?: T;
    status?: unknown;
    time?: number;
}

export interface QdrantCollectionOptions {
    collection: string;
    dimension: number;
    distance?: QdrantDistance;
    onDisk?: boolean;
}

function cleanBase(url: string): string {
    return url.replace(/\/+$/, "");
}

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

export function qdrantEndpoint(url = readEnv("CORTEXA_VECTOR_URL") ?? "http://localhost:6333"): string {
    return cleanBase(url);
}

async function qdrantRequest<T>(route: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${qdrantEndpoint()}${route}`, {
        ...init,
        headers: {
            "Content-Type": "application/json",
            ...(init?.headers ?? {})
        }
    });

    const raw = await response.text();
    const body = raw ? (JSON.parse(raw) as unknown) : {};

    if (!response.ok) {
        throw new Error(`Qdrant request failed (${response.status} ${response.statusText}) on ${route}: ${raw}`);
    }

    return body as T;
}

export async function getQdrantCollection(collection: string): Promise<unknown | null> {
    try {
        const data = await qdrantRequest<QdrantResponse<unknown>>(`/collections/${collection}`, {
            method: "GET"
        });
        return data.result ?? null;
    } catch {
        return null;
    }
}

export async function ensureQdrantCollection(options: QdrantCollectionOptions): Promise<void> {
    const existing = await getQdrantCollection(options.collection);
    if (existing) {
        return;
    }

    await qdrantRequest(`/collections/${options.collection}`, {
        method: "PUT",
        body: JSON.stringify({
            vectors: {
                size: options.dimension,
                distance: options.distance ?? "Cosine",
                on_disk: options.onDisk ?? false
            }
        })
    });
}

export async function upsertQdrantPoints(
    collection: string,
    points: QdrantPoint[],
    wait = true
): Promise<void> {
    if (points.length === 0) {
        return;
    }

    await qdrantRequest(`/collections/${collection}/points?wait=${String(wait)}`, {
        method: "PUT",
        body: JSON.stringify({ points })
    });
}

export async function searchQdrant(
    collection: string,
    vector: number[],
    limit = 10,
    scoreThreshold?: number
): Promise<QdrantSearchResult[]> {
    const data = await qdrantRequest<QdrantResponse<QdrantSearchResult[]>>(
        `/collections/${collection}/points/search`,
        {
            method: "POST",
            body: JSON.stringify({
                vector,
                limit,
                with_payload: true,
                with_vector: false,
                ...(scoreThreshold !== undefined ? { score_threshold: scoreThreshold } : {})
            })
        }
    );

    return data.result ?? [];
}

export async function deleteQdrantPoints(
    collection: string,
    pointIds: Array<string | number>,
    wait = true
): Promise<void> {
    if (pointIds.length === 0) {
        return;
    }

    await qdrantRequest(`/collections/${collection}/points/delete?wait=${String(wait)}`, {
        method: "POST",
        body: JSON.stringify({ points: pointIds })
    });
}

export async function healthCheckQdrant(): Promise<boolean> {
    try {
        await qdrantRequest("/collections", { method: "GET" });
        return true;
    } catch {
        return false;
    }
}
