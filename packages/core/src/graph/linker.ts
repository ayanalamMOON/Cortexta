import type { GraphEdge } from "../types/graph";
import type { CodeEntity, MemoryAtom } from "../types/memory";
import { randomId } from "../utils/ids";

function normalized(text: string): string {
    return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function overlap(a: string[], b: string[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    const sb = new Set(b.map((v) => normalized(v)));
    let hits = 0;
    for (const v of a) {
        if (sb.has(normalized(v))) hits += 1;
    }
    return hits / Math.max(a.length, b.length);
}

export function linkMemoryToEntity(memory: MemoryAtom, entity: CodeEntity): GraphEdge {
    const lexicalMatch =
        normalized(memory.summary).includes(normalized(entity.name)) || normalized(memory.title).includes(normalized(entity.name));

    const depMatch = overlap(memory.tags, entity.dependencies);
    const weight = Math.min(0.98, 0.55 + (lexicalMatch ? 0.25 : 0) + depMatch * 0.18 + memory.importance * 0.02);

    return {
        id: randomId("edge"),
        fromNode: memory.id,
        toNode: entity.id,
        type: "explains",
        projectId: memory.projectId,
        weight: Number(weight.toFixed(4)),
        metadata: {
            sourceRef: memory.sourceRef,
            entityPath: entity.filePath,
            lexicalMatch,
            depMatch: Number(depMatch.toFixed(4))
        }
    };
}

export function linkEntityDependency(from: CodeEntity, to: CodeEntity): GraphEdge {
    const relates = from.dependencies.some((dep) => normalized(dep).includes(normalized(to.name)));

    return {
        id: randomId("edge"),
        fromNode: from.id,
        toNode: to.id,
        type: "depends_on",
        projectId: from.projectId,
        weight: relates ? 0.82 : 0.41,
        metadata: {
            from: from.filePath,
            to: to.filePath,
            reason: relates ? "dependency-name-match" : "co-located"
        }
    };
}
