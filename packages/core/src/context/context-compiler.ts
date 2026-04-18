import { TokenCounter } from "../token/token-counter";
import type { CompiledContext, ContextAtom } from "../types/context";
import { compressAtom } from "./compressor";
import { renderContext } from "./formatter";
import { packByScore, packByTokenBudget } from "./packer";

export interface CompileOptions {
    model: string;
    maxTokens: number;
    reservedTokens?: number;
    renderMode?: "full" | "compact" | "symbolic";
    includeTable?: boolean;
}

function countTokens(model: string, text: string): number {
    const counter = new TokenCounter(model);
    const tokens = counter.countText(text);
    counter.free();
    return tokens;
}

export function compileContext(query: string, atoms: ContextAtom[], options: CompileOptions): CompiledContext {
    const sorted = packByScore(atoms).map((a) => compressAtom(a));
    const packed = packByTokenBudget(sorted, {
        model: options.model,
        maxTokens: options.maxTokens,
        reservedTokens: options.reservedTokens
    });

    const accepted = packed.accepted;
    const dropped = packed.dropped;

    const rendered = renderContext(accepted, query, {
        mode: options.renderMode ?? "compact",
        includeTable: options.includeTable
    });
    const tokens = countTokens(options.model, rendered);
    return { rendered, tokens, atoms: accepted, dropped };
}
