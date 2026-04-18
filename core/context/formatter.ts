import type { ScoredMemory } from "../mempalace/memory.types";

export interface ContextFormatOptions {
    scope?: string;
    constraints?: string[];
    includeScores?: boolean;
}

export function formatContext(
    query: string,
    memories: ScoredMemory[],
    options: ContextFormatOptions = {}
): string {
    const lines: string[] = [];

    lines.push("[CORTEXA_CONTEXT]");
    lines.push("");
    lines.push(`intent: ${query}`);
    lines.push(`scope: ${options.scope ?? "current_file + project + memory"}`);
    lines.push("");

    lines.push("memories:");
    if (memories.length === 0) {
        lines.push("  - none");
    } else {
        for (const memory of memories) {
            lines.push(`  - [${memory.kind}] ${memory.title}`);
            lines.push(`    summary: ${memory.summary}`);
            if (options.includeScores) {
                lines.push(`    score: ${memory.score.toFixed(4)}`);
            }
            if (memory.tags.length > 0) {
                lines.push(`    tags: ${memory.tags.join(", ")}`);
            }
        }
    }

    if (options.constraints && options.constraints.length > 0) {
        lines.push("");
        lines.push("constraints:");
        for (const constraint of options.constraints) {
            lines.push(`  - ${constraint}`);
        }
    }

    return lines.join("\n");
}
