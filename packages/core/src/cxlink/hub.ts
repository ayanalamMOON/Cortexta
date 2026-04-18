import { compileContext } from "../context/context-compiler";
import type { CompiledContext, ContextAtom } from "../types/context";
import { defaultPolicy, maxTokensForAgent, resolvePolicy, type CxLinkPolicy } from "./policies";

export interface HubRequest {
    query: string;
    agent?: string;
    atoms: ContextAtom[];
    model?: string;
    reservedTokens?: number;
    policyOverride?: Partial<CxLinkPolicy>;
}

export interface HubResponse {
    context: CompiledContext;
    tokens: number;
    agent: string;
    model: string;
    maxTokens: number;
}

export function resolveContext(req: HubRequest): HubResponse {
    const agent = req.agent ?? "cli";
    const policy = resolvePolicy(agent, req.policyOverride);
    const maxTokens = maxTokensForAgent(agent, policy);
    const model = req.model ?? policy.defaultModelByAgent[agent] ?? "gpt-4o-mini";
    const renderMode = policy.renderModeByAgent[agent] ?? "compact";
    const maxAtoms = policy.maxAtomsByAgent[agent] ?? req.atoms.length;
    const candidateAtoms = req.atoms.slice(0, Math.max(1, maxAtoms * 3));

    const context = compileContext(req.query, candidateAtoms, {
        model,
        maxTokens,
        reservedTokens: req.reservedTokens,
        renderMode,
        includeTable: renderMode === "full"
    });

    return {
        context,
        tokens: context.tokens,
        agent,
        model,
        maxTokens
    };
}

export const cxlinkHub = {
    resolveContext,
    policy: defaultPolicy
};
