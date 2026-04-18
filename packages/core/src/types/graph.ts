export type NodeType =
    | "function"
    | "class"
    | "method"
    | "module"
    | "memory"
    | "chat"
    | "concept"
    | "refactor_plan";

export type EdgeType =
    | "calls"
    | "contains"
    | "imports"
    | "depends_on"
    | "similar_to"
    | "optimized_by"
    | "derived_from"
    | "refactors"
    | "explains";

export interface GraphNode {
    id: string;
    type: NodeType;
    label: string;
    projectId: string;
    metadata?: Record<string, unknown>;
}

export interface GraphEdge {
    id: string;
    fromNode: string;
    toNode: string;
    type: EdgeType;
    projectId: string;
    weight: number;
    metadata?: Record<string, unknown>;
}
