export interface ContextAtom {
    id: string;
    kind: "memory" | "entity" | "graph" | "chat" | "constraint" | "system";
    title: string;
    body: string;
    priority: number;
    recency: number;
    relevance: number;
    sourceRef?: string;
    tags?: string[];
}

export interface CompiledContext {
    rendered: string;
    tokens: number;
    atoms: ContextAtom[];
    dropped: string[];
}
