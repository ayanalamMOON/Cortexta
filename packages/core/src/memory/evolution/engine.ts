import type { MemoryAtom } from "../../types/memory";
import { randomId } from "../../utils/ids";
import { ArchivistAgent } from "./archivist.agent";
import { ConsolidatorAgent } from "./consolidator.agent";
import { CriticAgent } from "./critic.agent";
import { WriterAgent } from "./writer.agent";

export interface EvolutionMemoryStore {
    searchSimilar(text: string, topK: number): Promise<MemoryAtom[]>;
    upsert(atom: MemoryAtom): Promise<void>;
    archive(atomId: string): Promise<void>;
}

export class MemoryEvolutionEngine {
    private readonly archivist = new ArchivistAgent();

    constructor(
        private readonly writer: WriterAgent,
        private readonly critic: CriticAgent,
        private readonly consolidator: ConsolidatorAgent,
        private readonly store: EvolutionMemoryStore
    ) { }

    async evolve(input: { projectId: string; text: string; context?: string }): Promise<{ stored: boolean; action: string; reason: string }> {
        const proposed = await this.writer.propose(input);
        const candidate = proposed.candidates[0];
        if (!candidate) {
            return { stored: false, action: "reject", reason: "no-candidate" };
        }

        const review = await this.critic.review({
            title: candidate.title,
            summary: candidate.summary
        });

        if (!review.accepted || review.action === "reject") {
            return { stored: false, action: "reject", reason: review.reason };
        }

        const atom: MemoryAtom = {
            id: randomId("mem"),
            projectId: input.projectId,
            kind: candidate.kind,
            sourceType: "system",
            title: candidate.title,
            summary: candidate.summary,
            content: candidate.content,
            tags: candidate.tags,
            importance: Math.min(1, Math.max(0, review.score)),
            confidence: Math.min(1, Math.max(0, review.clarity)),
            createdAt: Date.now(),
            lastAccessedAt: Date.now(),
            sourceRef: candidate.sourceRef
        };

        const neighbors = await this.store.searchSimilar(atom.summary, 5);
        const merged = await this.consolidator.merge({ candidate: atom, neighbors });

        const evolved = this.archivist.applyDecay({
            ...atom,
            title: merged.title,
            summary: merged.summary,
            content: merged.content,
            tags: merged.tags,
            confidence: merged.confidence
        });

        if (this.archivist.shouldArchive(evolved)) {
            await this.store.archive(evolved.id);
            return { stored: false, action: "archive", reason: "low-importance" };
        }

        await this.store.upsert(evolved);
        return { stored: true, action: review.action, reason: review.reason };
    }
}
