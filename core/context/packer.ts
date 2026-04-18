export interface PackedContext {
    packed: string[];
    tokenEstimate: number;
    dropped: number;
}

export function estimateTokens(text: string): number {
    // Practical approximation for English/code mixed text (~4 chars per token).
    return Math.max(1, Math.ceil(text.length / 4));
}

export function packContextParts(parts: string[], maxTokens = 4000): PackedContext {
    const packed: string[] = [];
    let currentTokens = 0;

    for (const part of parts) {
        const candidateTokens = estimateTokens(`${packed.join("\n")}${packed.length > 0 ? "\n" : ""}${part}`);
        if (candidateTokens > maxTokens) {
            break;
        }

        packed.push(part);
        currentTokens = candidateTokens;
    }

    return {
        packed,
        tokenEstimate: currentTokens,
        dropped: Math.max(0, parts.length - packed.length)
    };
}
