import { TokenCounter } from "../token/token-counter";
import type { ContextAtom } from "../types/context";

export interface PackOptions {
    model?: string;
    maxTokens?: number;
    reservedTokens?: number;
}

function rank(atom: ContextAtom): number {
    return atom.priority * 0.42 + atom.recency * 0.22 + atom.relevance * 0.28 + (atom.tags?.length ? 0.08 : 0);
}

export function packByScore(atoms: ContextAtom[]): ContextAtom[] {
    return [...atoms].sort((a, b) => {
        const sa = rank(a);
        const sb = rank(b);
        if (sb !== sa) return sb - sa;
        return a.id.localeCompare(b.id);
    });
}

export function packByTokenBudget(atoms: ContextAtom[], options: PackOptions = {}): { accepted: ContextAtom[]; dropped: string[] } {
    const model = options.model ?? "gpt-4o-mini";
    const maxTokens = options.maxTokens ?? 4000;
    const budget = Math.max(128, maxTokens - (options.reservedTokens ?? 0));

    const counter = new TokenCounter(model);
    const sorted = packByScore(atoms);
    const accepted: ContextAtom[] = [];
    const dropped: string[] = [];

    let runningTokens = 0;
    for (const atom of sorted) {
        const estimate = counter.countText(`${atom.title}\n${atom.body}`);
        if (runningTokens + estimate > budget) {
            dropped.push(atom.id);
            continue;
        }
        accepted.push(atom);
        runningTokens += estimate;
    }

    counter.free();

    return {
        accepted,
        dropped
    };
}
