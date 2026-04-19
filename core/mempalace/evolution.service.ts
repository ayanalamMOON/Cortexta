import { CompressorAgent } from "../../packages/core/src/memory/evolution/compressor.agent";
import { ConsolidatorAgent } from "../../packages/core/src/memory/evolution/consolidator.agent";
import { CriticAgent } from "../../packages/core/src/memory/evolution/critic.agent";
import {
    MemoryEvolutionEngine,
    type EvolutionMemoryStore,
    type EvolutionResult
} from "../../packages/core/src/memory/evolution/engine";
import { WriterAgent } from "../../packages/core/src/memory/evolution/writer.agent";
import type { LLMClient } from "../../packages/core/src/types/llm";
import type { MemoryAtom } from "../../packages/core/src/types/memory";
import { deleteMemory, searchMemories, upsertMemory } from "./memory.service";
import type { MemoryRecord } from "./memory.types";

export interface ProgressionEvolutionInput {
    projectId?: string;
    branch?: string;
    text: string;
    context?: string;
    dryRun?: boolean;
}

export interface ProgressionEvolutionOutput {
    projectId: string;
    dryRun: boolean;
    persisted: boolean;
    result: EvolutionResult;
}

const fallbackLlmClient: LLMClient = {
    async completeJson<T>(): Promise<T> {
        throw new Error("llm-not-configured");
    }
};

function toMemoryAtom(record: MemoryRecord): MemoryAtom {
    return {
        id: record.id,
        projectId: record.projectId,
        kind: record.kind,
        sourceType: record.sourceType,
        title: record.title,
        summary: record.summary,
        content: record.content,
        tags: record.tags,
        importance: record.importance,
        confidence: record.confidence,
        createdAt: record.createdAt,
        lastAccessedAt: record.lastAccessedAt,
        sourceRef: record.sourceRef,
        embeddingRef: record.embeddingRef
    };
}

function createEvolutionMemoryStore(projectId: string, branch: string, persistWrites: boolean): EvolutionMemoryStore {
    return {
        async searchSimilar(text: string, topK: number): Promise<MemoryAtom[]> {
            const matches = await searchMemories(text, {
                projectId,
                branch,
                topK,
                minScore: 0
            });

            return matches.map(toMemoryAtom);
        },
        async upsert(atom: MemoryAtom): Promise<void> {
            if (!persistWrites) {
                return;
            }

            await upsertMemory({
                id: atom.id,
                projectId: atom.projectId,
                branch,
                kind: atom.kind,
                sourceType: atom.sourceType,
                title: atom.title,
                summary: atom.summary,
                content: atom.content,
                tags: atom.tags,
                importance: atom.importance,
                confidence: atom.confidence,
                sourceRef: atom.sourceRef,
                embeddingRef: atom.embeddingRef
            });
        },
        async archive(atomId: string): Promise<void> {
            if (!persistWrites) {
                return;
            }

            await deleteMemory(atomId, {
                projectId,
                branch
            });
        }
    };
}

function createEvolutionEngine(projectId: string, branch: string, persistWrites: boolean): MemoryEvolutionEngine {
    const writer = new WriterAgent(fallbackLlmClient);
    const critic = new CriticAgent(fallbackLlmClient);
    const compressor = new CompressorAgent();
    const consolidator = new ConsolidatorAgent(fallbackLlmClient);
    const store = createEvolutionMemoryStore(projectId, branch, persistWrites);

    return new MemoryEvolutionEngine(writer, critic, consolidator, store, compressor);
}

export async function evolveMemoryWithProgression(
    input: ProgressionEvolutionInput
): Promise<ProgressionEvolutionOutput> {
    const projectId = (input.projectId ?? "").trim() || "default";
    const branch = (input.branch ?? "").trim() || "main";
    const text = input.text.trim();
    const context = input.context?.trim();
    const dryRun = input.dryRun === true;
    const persistWrites = !dryRun;

    if (!text) {
        throw new Error("Missing required field: text");
    }

    const engine = createEvolutionEngine(projectId, branch, persistWrites);
    const result = await engine.evolveWithProgression({
        projectId,
        text,
        context
    });

    return {
        projectId,
        dryRun,
        persisted: persistWrites && result.stored,
        result
    };
}
