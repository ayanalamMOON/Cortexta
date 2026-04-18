import type { GraphEdge } from "../types/graph";

export interface TraversalOptions {
    startNode: string;
    maxDepth?: number;
    maxEdges?: number;
    minWeight?: number;
}

export function limitTraversal(edges: GraphEdge[], maxDepth = 2): GraphEdge[] {
    const depthBudget = Math.max(1, maxDepth);
    const sorted = [...edges].sort((a, b) => b.weight - a.weight);
    return sorted.slice(0, Math.max(3, depthBudget * 12));
}

export function traverseGraph(edges: GraphEdge[], options: TraversalOptions): { edges: GraphEdge[]; visited: string[] } {
    const maxDepth = Math.max(1, options.maxDepth ?? 2);
    const maxEdges = Math.max(1, options.maxEdges ?? 64);
    const minWeight = options.minWeight ?? 0;

    const outgoing = new Map<string, GraphEdge[]>();
    for (const edge of edges) {
        if (edge.weight < minWeight) continue;
        const bucket = outgoing.get(edge.fromNode) ?? [];
        bucket.push(edge);
        outgoing.set(edge.fromNode, bucket);
    }

    for (const bucket of outgoing.values()) {
        bucket.sort((a, b) => b.weight - a.weight);
    }

    const visited = new Set<string>([options.startNode]);
    const seenEdge = new Set<string>();
    const output: GraphEdge[] = [];
    const queue: Array<{ node: string; depth: number }> = [{ node: options.startNode, depth: 0 }];

    while (queue.length > 0 && output.length < maxEdges) {
        const current = queue.shift();
        if (!current) break;
        if (current.depth >= maxDepth) continue;

        const nextEdges = outgoing.get(current.node) ?? [];
        for (const edge of nextEdges) {
            const edgeKey = `${edge.fromNode}|${edge.toNode}|${edge.type}`;
            if (seenEdge.has(edgeKey)) continue;

            seenEdge.add(edgeKey);
            output.push(edge);

            if (!visited.has(edge.toNode)) {
                visited.add(edge.toNode);
                queue.push({ node: edge.toNode, depth: current.depth + 1 });
            }

            if (output.length >= maxEdges) break;
        }
    }

    return {
        edges: output,
        visited: [...visited]
    };
}
