export interface CxLinkPolicy {
    maxTokensByAgent: Record<string, number>;
    priorityOrder: string[];
    defaultModelByAgent: Record<string, string>;
    renderModeByAgent: Record<string, "full" | "compact" | "symbolic">;
    maxAtomsByAgent: Record<string, number>;
}

export const defaultPolicy: CxLinkPolicy = {
    maxTokensByAgent: {
        copilot: 2000,
        cli: 4000,
        gpt: 8000,
        daemon: 4000
    },
    priorityOrder: ["local-file", "graph-neighbors", "memory", "chat-history"],
    defaultModelByAgent: {
        copilot: "gpt-4o-mini",
        cli: "gpt-4o-mini",
        daemon: "gpt-4o-mini",
        gpt: "gpt-4.1"
    },
    renderModeByAgent: {
        copilot: "compact",
        cli: "full",
        daemon: "compact",
        gpt: "compact"
    },
    maxAtomsByAgent: {
        copilot: 20,
        cli: 40,
        daemon: 24,
        gpt: 60
    }
};

export function resolvePolicy(agent: string, override?: Partial<CxLinkPolicy>): CxLinkPolicy {
    if (!override) return defaultPolicy;

    return {
        maxTokensByAgent: {
            ...defaultPolicy.maxTokensByAgent,
            ...(override.maxTokensByAgent ?? {})
        },
        priorityOrder: override.priorityOrder?.length ? override.priorityOrder : defaultPolicy.priorityOrder,
        defaultModelByAgent: {
            ...defaultPolicy.defaultModelByAgent,
            ...(override.defaultModelByAgent ?? {})
        },
        renderModeByAgent: {
            ...defaultPolicy.renderModeByAgent,
            ...(override.renderModeByAgent ?? {})
        },
        maxAtomsByAgent: {
            ...defaultPolicy.maxAtomsByAgent,
            ...(override.maxAtomsByAgent ?? {})
        }
    };
}

export function maxTokensForAgent(agent: string, policy: CxLinkPolicy = defaultPolicy): number {
    return policy.maxTokensByAgent[agent] ?? policy.maxTokensByAgent.cli ?? 4000;
}
