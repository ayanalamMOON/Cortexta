import type { GraphEdge, GraphNode } from "../types/graph";
import { randomId } from "../utils/ids";
import { traverseGraph } from "./traversal";

export interface NeighborQuery {
    nodeId: string;
    projectId?: string;
    edgeTypes?: GraphEdge["type"][];
    limit?: number;
    minWeight?: number;
}

function edgeKey(edge: GraphEdge): string {
    return `${edge.projectId}:${edge.fromNode}:${edge.toNode}:${edge.type}`;
}

export class GraphService {
    private nodes = new Map<string, GraphNode>();

    private edges = new Map<string, GraphEdge>();

    addNode(node: GraphNode): void {
        this.nodes.set(node.id, node);
    }

    addNodes(nodes: GraphNode[]): void {
        for (const node of nodes) {
            this.addNode(node);
        }
    }

    addEdge(edge: GraphEdge): void {
        const withId = edge.id ? edge : { ...edge, id: randomId("edge") };
        this.edges.set(edgeKey(withId), withId);
    }

    addEdges(edges: GraphEdge[]): void {
        for (const edge of edges) {
            this.addEdge(edge);
        }
    }

    getNode(id: string): GraphNode | undefined {
        return this.nodes.get(id);
    }

    getNeighbors(id: string): GraphEdge[] {
        const rows: GraphEdge[] = [];
        for (const edge of this.edges.values()) {
            if (edge.fromNode === id || edge.toNode === id) {
                rows.push(edge);
            }
        }
        return rows.sort((a, b) => b.weight - a.weight);
    }

    queryNeighbors(query: NeighborQuery): GraphEdge[] {
        const edgeTypes = query.edgeTypes ? new Set(query.edgeTypes) : null;
        const rows: GraphEdge[] = [];

        for (const edge of this.edges.values()) {
            if (query.projectId && edge.projectId !== query.projectId) continue;
            if (edge.fromNode !== query.nodeId && edge.toNode !== query.nodeId) continue;
            if (edgeTypes && !edgeTypes.has(edge.type)) continue;
            if (query.minWeight !== undefined && edge.weight < query.minWeight) continue;
            rows.push(edge);
        }

        rows.sort((a, b) => b.weight - a.weight);
        return rows.slice(0, query.limit ?? rows.length);
    }

    reachableFrom(nodeId: string, options: { maxDepth?: number; maxEdges?: number; minWeight?: number } = {}): GraphEdge[] {
        const result = traverseGraph([...this.edges.values()], {
            startNode: nodeId,
            maxDepth: options.maxDepth,
            maxEdges: options.maxEdges,
            minWeight: options.minWeight
        });

        return result.edges;
    }

    removeNode(nodeId: string): void {
        this.nodes.delete(nodeId);
        for (const [key, edge] of this.edges.entries()) {
            if (edge.fromNode === nodeId || edge.toNode === nodeId) {
                this.edges.delete(key);
            }
        }
    }

    removeEdge(id: string): void {
        for (const [key, edge] of this.edges.entries()) {
            if (edge.id === id) {
                this.edges.delete(key);
                return;
            }
        }
    }

    stats(): { nodes: number; edges: number; projects: number } {
        const projects = new Set<string>();
        for (const node of this.nodes.values()) {
            projects.add(node.projectId);
        }
        for (const edge of this.edges.values()) {
            projects.add(edge.projectId);
        }

        return {
            nodes: this.nodes.size,
            edges: this.edges.size,
            projects: projects.size
        };
    }
}
