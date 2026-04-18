export interface EmbedOptions {
    endpoint?: string;
    dimensions?: number;
    ast?: Record<string, unknown>;
}

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

function normalizeVector(vec: number[]): number[] {
    if (vec.length === 0) {
        return vec;
    }

    const magnitude = Math.sqrt(vec.reduce((acc, cur) => acc + cur * cur, 0));
    if (magnitude === 0) {
        return vec;
    }

    return vec.map((v) => v / magnitude);
}

function deterministicEmbedding(text: string, dimensions = 256): number[] {
    const vec = new Array<number>(dimensions).fill(0);

    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        const bucket = i % dimensions;
        const scaled = ((code * (i + 17)) % 997) / 997;
        vec[bucket] += scaled;
    }

    return normalizeVector(vec);
}

export async function embedText(text: string, options: EmbedOptions = {}): Promise<number[]> {
    const clean = text.trim();
    if (!clean) {
        return [];
    }

    const dimensions = options.dimensions ?? 256;
    const endpoint = options.endpoint ?? readEnv("CORTEXA_EMBEDDING_URL") ?? "";

    if (!endpoint) {
        return deterministicEmbedding(clean, dimensions);
    }

    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                text: clean,
                ast: options.ast ?? null
            })
        });

        if (!response.ok) {
            throw new Error(`Embedding endpoint returned ${response.status}`);
        }

        const data = (await response.json()) as { embedding?: number[] };
        const embedding = data.embedding ?? [];
        if (embedding.length === 0) {
            return deterministicEmbedding(clean, dimensions);
        }

        return normalizeVector(embedding);
    } catch {
        return deterministicEmbedding(clean, dimensions);
    }
}

export async function embedBatch(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
    const output: number[][] = [];
    for (const text of texts) {
        output.push(await embedText(text, options));
    }
    return output;
}
