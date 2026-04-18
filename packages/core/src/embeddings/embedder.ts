import fetch from "node-fetch";

export interface EmbedOptions {
    endpoint?: string;
    dimensions?: number;
    ast?: unknown;
}

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

function normalize(vec: number[]): number[] {
    const mag = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
    if (mag === 0) return vec;
    return vec.map((v) => v / mag);
}

function fallbackEmbedding(text: string, dimensions = 256): number[] {
    const vec = new Array<number>(dimensions).fill(0);
    for (let i = 0; i < text.length; i += 1) {
        const idx = i % dimensions;
        vec[idx] += ((text.charCodeAt(i) * (i + 13)) % 1009) / 1009;
    }
    return normalize(vec);
}

export async function embed(text: string, ast?: unknown, options: EmbedOptions = {}): Promise<number[]> {
    const clean = text.trim();
    if (!clean) return [];

    const endpoint = options.endpoint ?? readEnv("CORTEXA_EMBEDDING_URL") ?? "";
    const dimensions = options.dimensions ?? 256;

    if (!endpoint) {
        return fallbackEmbedding(clean, dimensions);
    }

    try {
        const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: clean, ast: options.ast ?? ast ?? null })
        });

        if (!res.ok) {
            throw new Error(`embedding endpoint status=${res.status}`);
        }

        const data = (await res.json()) as { embedding?: number[] };
        const vec = data.embedding ?? [];
        if (vec.length === 0) {
            return fallbackEmbedding(clean, dimensions);
        }
        return normalize(vec);
    } catch {
        return fallbackEmbedding(clean, dimensions);
    }
}

export async function embedBatch(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
    const out: number[][] = [];
    for (const text of texts) {
        out.push(await embed(text, undefined, options));
    }
    return out;
}
