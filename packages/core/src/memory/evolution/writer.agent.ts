import { writerAgentDraft } from "../../../../../agents/writer.agent";
import type { LLMClient } from "../../types/llm";
import type { MemoryAtom } from "../../types/memory";

export interface WriterOutput {
    candidates: Array<Pick<MemoryAtom, "kind" | "title" | "summary" | "content" | "tags" | "sourceRef">>;
}

function isMemoryKind(value: unknown): value is MemoryAtom["kind"] {
    return (
        value === "episodic" ||
        value === "semantic" ||
        value === "procedural" ||
        value === "code_entity" ||
        value === "chat_turn" ||
        value === "refactor_plan"
    );
}

function normalizeCandidate(
    candidate: Partial<Pick<MemoryAtom, "kind" | "title" | "summary" | "content" | "tags" | "sourceRef">>,
    fallbackProjectId: string
): Pick<MemoryAtom, "kind" | "title" | "summary" | "content" | "tags" | "sourceRef"> {
    const content = String(candidate.content ?? "").trim();
    const summarySeed = String(candidate.summary ?? content.slice(0, 220)).trim();
    const summary = summarySeed.length > 220 ? `${summarySeed.slice(0, 219).trimEnd()}…` : summarySeed;
    const titleSeed = String(candidate.title ?? summary.split(/\r?\n/)[0] ?? "Generated Memory").trim();
    const title = titleSeed.length > 120 ? `${titleSeed.slice(0, 119).trimEnd()}…` : titleSeed;

    const tags = Array.isArray(candidate.tags)
        ? [...new Set(candidate.tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 16)
        : ["auto-generated"];

    const sourceRef = String(candidate.sourceRef ?? fallbackProjectId).trim() || fallbackProjectId;

    return {
        kind: isMemoryKind(candidate.kind) ? candidate.kind : "semantic",
        title: title || "Generated Memory",
        summary: summary || content.slice(0, 120),
        content: content || summary || title || "Generated memory content.",
        tags: tags.length > 0 ? tags : ["auto-generated"],
        sourceRef
    };
}

function normalizeWriterOutput(output: WriterOutput, fallbackProjectId: string): WriterOutput {
    const normalized = (output.candidates ?? [])
        .map((candidate) => normalizeCandidate(candidate, fallbackProjectId))
        .filter((candidate) => candidate.content.trim().length > 0);

    if (normalized.length === 0) {
        return {
            candidates: [
                normalizeCandidate(
                    {
                        kind: "semantic",
                        title: "Generated Memory",
                        summary: "Fallback candidate",
                        content: "Fallback candidate",
                        tags: ["auto-generated"],
                        sourceRef: fallbackProjectId
                    },
                    fallbackProjectId
                )
            ]
        };
    }

    const dedupedByTitle = new Map<string, Pick<MemoryAtom, "kind" | "title" | "summary" | "content" | "tags" | "sourceRef">>();
    for (const candidate of normalized) {
        const key = `${candidate.kind}:${candidate.title.toLowerCase()}`;
        if (!dedupedByTitle.has(key)) {
            dedupedByTitle.set(key, candidate);
        }
    }

    return {
        candidates: [...dedupedByTitle.values()].slice(0, 5)
    };
}

export class WriterAgent {
    constructor(private readonly llm: LLMClient) { }

    async propose(input: { text: string; projectId: string; context?: string }): Promise<WriterOutput> {
        const legacyDraft = writerAgentDraft(input.text);
        const fallback: WriterOutput = {
            candidates: [
                {
                    kind: "semantic",
                    title: legacyDraft.title,
                    summary: legacyDraft.summary,
                    content: legacyDraft.content,
                    tags: legacyDraft.tags,
                    sourceRef: input.projectId
                }
            ]
        };

        try {
            const output = await this.llm.completeJson<WriterOutput>({
                system: "Generate candidate memory atoms.",
                user: JSON.stringify(input),
                schemaHint: "{ candidates: [{ kind, title, summary, content, tags, sourceRef }] }"
            });

            return normalizeWriterOutput(output, input.projectId);
        } catch {
            return normalizeWriterOutput(fallback, input.projectId);
        }
    }
}
