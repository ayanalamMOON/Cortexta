import { compressorAgent } from "../../agents/compressor.agent";
import { criticAgent } from "../../agents/critic.agent";
import { plannerAgent } from "../../agents/planner.agent";
import { refactorAgent } from "../../agents/refactor.agent";
import { writerAgent, writerAgentDraft } from "../../agents/writer.agent";
import { ArchivistAgent } from "../../packages/core/src/memory/evolution/archivist.agent";
import { ConsolidatorAgent } from "../../packages/core/src/memory/evolution/consolidator.agent";
import { CriticAgent } from "../../packages/core/src/memory/evolution/critic.agent";
import { WriterAgent } from "../../packages/core/src/memory/evolution/writer.agent";
import type { LLMClient } from "../../packages/core/src/types/llm";
import type { MemoryAtom } from "../../packages/core/src/types/memory";
import { randomId } from "../../packages/core/src/utils/ids";
import { evolveMemoryWithProgression } from "../mempalace/evolution.service";
import { searchMemories } from "../mempalace/memory.service";

export type CortexaAgentId =
    | "writer"
    | "critic"
    | "compressor"
    | "planner"
    | "refactor"
    | "evolution_writer"
    | "evolution_critic"
    | "evolution_consolidator"
    | "evolution_archivist"
    | "multi_agent_loop";

export interface CortexaAgentDescriptor {
    id: CortexaAgentId;
    family: "heuristic" | "evolution" | "orchestrator";
    mutation: boolean;
    description: string;
}

export interface RunCortexaAgentInput {
    agent: CortexaAgentId;
    text: string;
    projectId?: string;
    branch?: string;
    context?: string;
    dryRun?: boolean;
    existingSnippets?: string[];
    maxChars?: number;
    topK?: number;
}

export interface RunCortexaAgentOutput {
    ok: true;
    agent: CortexaAgentId;
    projectId: string;
    branch: string;
    dryRun: boolean;
    output: unknown;
}

const fallbackLlmClient: LLMClient = {
    async completeJson<T>(): Promise<T> {
        throw new Error("llm-not-configured");
    }
};

const AGENT_CATALOG: CortexaAgentDescriptor[] = [
    {
        id: "writer",
        family: "heuristic",
        mutation: false,
        description: "Generate memory candidate draft from raw input."
    },
    {
        id: "critic",
        family: "heuristic",
        mutation: false,
        description: "Score novelty and clarity of candidate memory content."
    },
    {
        id: "compressor",
        family: "heuristic",
        mutation: false,
        description: "Compress and deduplicate text for token-efficient storage/context."
    },
    {
        id: "planner",
        family: "heuristic",
        mutation: false,
        description: "Produce execution plan with constraints, risks, and ordered steps."
    },
    {
        id: "refactor",
        family: "heuristic",
        mutation: false,
        description: "Generate refactor recommendations and validation strategy."
    },
    {
        id: "evolution_writer",
        family: "evolution",
        mutation: false,
        description: "Run LLM-compatible writer in memory evolution pipeline mode."
    },
    {
        id: "evolution_critic",
        family: "evolution",
        mutation: false,
        description: "Run LLM-compatible critic in memory evolution pipeline mode."
    },
    {
        id: "evolution_consolidator",
        family: "evolution",
        mutation: false,
        description: "Merge a candidate memory atom with nearest neighbors."
    },
    {
        id: "evolution_archivist",
        family: "evolution",
        mutation: false,
        description: "Evaluate decay/promotion/archive progression for a memory atom."
    },
    {
        id: "multi_agent_loop",
        family: "orchestrator",
        mutation: true,
        description: "Execute writer→critic→compressor→planner→refactor→evolution loop."
    }
];

function normalizeProjectId(projectId?: string): string {
    const normalized = (projectId ?? "").trim();
    return normalized || "default";
}

function normalizeBranch(branch?: string): string {
    const normalized = (branch ?? "").trim();
    return normalized || "main";
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, Math.trunc(value)));
}

function toMemoryAtom(source: {
    id: string;
    projectId: string;
    kind: MemoryAtom["kind"];
    sourceType: MemoryAtom["sourceType"];
    title: string;
    summary: string;
    content: string;
    tags: string[];
    importance: number;
    confidence: number;
    createdAt: number;
    lastAccessedAt: number;
    sourceRef?: string;
    embeddingRef?: string;
}): MemoryAtom {
    return {
        id: source.id,
        projectId: source.projectId,
        kind: source.kind,
        sourceType: source.sourceType,
        title: source.title,
        summary: source.summary,
        content: source.content,
        tags: source.tags,
        importance: source.importance,
        confidence: source.confidence,
        createdAt: source.createdAt,
        lastAccessedAt: source.lastAccessedAt,
        sourceRef: source.sourceRef,
        embeddingRef: source.embeddingRef
    };
}

async function resolveExistingSnippets(params: {
    text: string;
    projectId: string;
    branch: string;
    topK: number;
    existingSnippets?: string[];
}): Promise<string[]> {
    const explicit = (params.existingSnippets ?? [])
        .map((snippet) => snippet.trim())
        .filter(Boolean);

    if (explicit.length > 0) {
        return [...new Set(explicit)].slice(0, params.topK);
    }

    const matches = await searchMemories(params.text, {
        projectId: params.projectId,
        branch: params.branch,
        topK: params.topK,
        minScore: 0
    });

    return matches
        .map((match) => `${match.title}: ${match.summary}`.trim())
        .filter(Boolean)
        .slice(0, params.topK);
}

function makeCandidateAtom(projectId: string, text: string): MemoryAtom {
    const draft = writerAgentDraft(text);
    const now = Date.now();

    return {
        id: randomId("agent_mem"),
        projectId,
        kind: "semantic",
        sourceType: "system",
        title: draft.title,
        summary: draft.summary,
        content: draft.content,
        tags: draft.tags,
        importance: 0.55,
        confidence: 0.6,
        createdAt: now,
        lastAccessedAt: now,
        sourceRef: "agent-orchestrator"
    };
}

export function listCortexaAgents(): CortexaAgentDescriptor[] {
    return AGENT_CATALOG.map((agent) => ({ ...agent }));
}

export function isCortexaAgentId(value: string): value is CortexaAgentId {
    return AGENT_CATALOG.some((agent) => agent.id === value);
}

export async function runCortexaAgent(input: RunCortexaAgentInput): Promise<RunCortexaAgentOutput> {
    const projectId = normalizeProjectId(input.projectId);
    const branch = normalizeBranch(input.branch);
    const dryRun = input.dryRun !== false;
    const text = input.text.trim();
    const topK = clampInteger(input.topK, 6, 1, 40);
    const maxChars = clampInteger(input.maxChars, 320, 64, 32_000);

    if (!text) {
        throw new Error("Missing required field: text");
    }

    switch (input.agent) {
        case "writer": {
            const draft = writerAgentDraft(text);
            const preview = writerAgent(text);
            return {
                ok: true,
                agent: input.agent,
                projectId,
                branch,
                dryRun,
                output: {
                    draft,
                    preview
                }
            };
        }

        case "critic": {
            const snippets = await resolveExistingSnippets({
                text,
                projectId,
                branch,
                topK,
                existingSnippets: input.existingSnippets
            });

            const review = criticAgent(text, snippets);
            return {
                ok: true,
                agent: input.agent,
                projectId,
                branch,
                dryRun,
                output: {
                    review,
                    snippets
                }
            };
        }

        case "compressor": {
            const compressed = compressorAgent(text, {
                maxChars,
                preserveLineBreaks: true
            });

            return {
                ok: true,
                agent: input.agent,
                projectId,
                branch,
                dryRun,
                output: {
                    originalChars: text.length,
                    compressedChars: compressed.length,
                    compressed
                }
            };
        }

        case "planner": {
            const plan = plannerAgent(text, {
                context: input.context,
                maxSteps: clampInteger(input.topK, 6, 3, 12)
            });

            return {
                ok: true,
                agent: input.agent,
                projectId,
                branch,
                dryRun,
                output: {
                    plan
                }
            };
        }

        case "refactor": {
            const snippets = await resolveExistingSnippets({
                text,
                projectId,
                branch,
                topK,
                existingSnippets: input.existingSnippets
            });

            const plan = plannerAgent(text, {
                context: input.context,
                maxSteps: 7
            });

            const suggestion = refactorAgent({
                text,
                plan,
                memoryAnchors: snippets
            });

            return {
                ok: true,
                agent: input.agent,
                projectId,
                branch,
                dryRun,
                output: {
                    plan,
                    suggestion,
                    snippets
                }
            };
        }

        case "evolution_writer": {
            const writer = new WriterAgent(fallbackLlmClient);
            const proposed = await writer.propose({
                projectId,
                text,
                context: input.context
            });

            return {
                ok: true,
                agent: input.agent,
                projectId,
                branch,
                dryRun,
                output: {
                    proposed
                }
            };
        }

        case "evolution_critic": {
            const draft = writerAgentDraft(text);
            const critic = new CriticAgent(fallbackLlmClient);
            const snippets = await resolveExistingSnippets({
                text,
                projectId,
                branch,
                topK,
                existingSnippets: input.existingSnippets
            });

            const review = await critic.review({
                title: draft.title,
                summary: draft.summary,
                existingSnippets: snippets
            });

            return {
                ok: true,
                agent: input.agent,
                projectId,
                branch,
                dryRun,
                output: {
                    draft,
                    review,
                    snippets
                }
            };
        }

        case "evolution_consolidator": {
            const consolidator = new ConsolidatorAgent(fallbackLlmClient);
            const candidate = makeCandidateAtom(projectId, text);
            const neighborsRaw = await searchMemories(text, {
                projectId,
                branch,
                topK,
                minScore: 0
            });

            const neighbors = neighborsRaw.map((row) =>
                toMemoryAtom({
                    id: row.id,
                    projectId: row.projectId,
                    kind: row.kind,
                    sourceType: row.sourceType,
                    title: row.title,
                    summary: row.summary,
                    content: row.content,
                    tags: row.tags,
                    importance: row.importance,
                    confidence: row.confidence,
                    createdAt: row.createdAt,
                    lastAccessedAt: row.lastAccessedAt,
                    sourceRef: row.sourceRef,
                    embeddingRef: row.embeddingRef
                })
            );

            const merged = await consolidator.merge({
                candidate,
                neighbors
            });

            return {
                ok: true,
                agent: input.agent,
                projectId,
                branch,
                dryRun,
                output: {
                    candidate,
                    neighbors: neighbors.length,
                    merged
                }
            };
        }

        case "evolution_archivist": {
            const archivist = new ArchivistAgent();
            const candidate = makeCandidateAtom(projectId, text);
            const progression = archivist.evaluateProgression(candidate);
            const evolved = archivist.applyDecay(candidate);

            return {
                ok: true,
                agent: input.agent,
                projectId,
                branch,
                dryRun,
                output: {
                    candidate,
                    progression,
                    evolved
                }
            };
        }

        case "multi_agent_loop": {
            const snippets = await resolveExistingSnippets({
                text,
                projectId,
                branch,
                topK,
                existingSnippets: input.existingSnippets
            });

            const writerDraft = writerAgentDraft(text);
            const writerPreview = writerAgent(text);
            const review = criticAgent(writerDraft.content, snippets);
            const compressed = compressorAgent(writerDraft.content, {
                maxChars,
                preserveLineBreaks: true
            });
            const plan = plannerAgent(compressed, {
                context: input.context,
                maxSteps: 8
            });
            const refactor = refactorAgent({
                text: compressed,
                plan,
                memoryAnchors: snippets
            });

            const progression = await evolveMemoryWithProgression({
                projectId,
                branch,
                text: compressed,
                context: input.context,
                dryRun
            });

            return {
                ok: true,
                agent: input.agent,
                projectId,
                branch,
                dryRun,
                output: {
                    stages: [
                        "writer",
                        "critic",
                        "compressor",
                        "planner",
                        "refactor",
                        "evolution"
                    ],
                    writer: {
                        draft: writerDraft,
                        preview: writerPreview
                    },
                    critic: review,
                    compressor: {
                        originalChars: writerDraft.content.length,
                        compressedChars: compressed.length,
                        compressed
                    },
                    planner: plan,
                    refactor,
                    progression
                }
            };
        }
    }
}
