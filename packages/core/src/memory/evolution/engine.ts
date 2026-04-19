import type { MemoryAtom } from "../../types/memory";
import { randomId } from "../../utils/ids";
import { ArchivistAgent } from "./archivist.agent";
import { ConsolidatorAgent } from "./consolidator.agent";
import { CriticAgent, type CriticOutput } from "./critic.agent";
import { WriterAgent } from "./writer.agent";

export interface EvolutionMemoryStore {
    searchSimilar(text: string, topK: number): Promise<MemoryAtom[]>;
    upsert(atom: MemoryAtom): Promise<void>;
    archive(atomId: string): Promise<void>;
}

export type EvolutionAction = CriticOutput["action"] | "archive";

export interface EvolutionStageProgress {
    stage: "propose" | "review" | "consolidate" | "archivist" | "persist";
    ok: boolean;
    detail: string;
    at: number;
}

export interface EvolutionProgression {
    proposedCandidates: number;
    reviewedCandidates: number;
    selectedCandidateIndex?: number;
    selectedScore?: number;
    merged: boolean;
    neighborCount: number;
    promoted: boolean;
    archived: boolean;
    stages: EvolutionStageProgress[];
}

export interface EvolutionResult {
    stored: boolean;
    action: EvolutionAction;
    reason: string;
    atomId?: string;
    progression: EvolutionProgression;
}

interface CandidateReview {
    index: number;
    candidate: {
        kind: MemoryAtom["kind"];
        title: string;
        summary: string;
        content: string;
        tags: string[];
        sourceRef?: string;
    };
    review: CriticOutput;
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function ensurePromotedTag(tags: string[]): string[] {
    const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
    if (!normalized.some((tag) => tag.toLowerCase() === "promoted")) {
        normalized.push("promoted");
    }
    return normalized;
}

function summarizeContent(text: string, maxChars = 220): string {
    const clean = text.trim();
    if (clean.length <= maxChars) {
        return clean;
    }

    return `${clean.slice(0, maxChars - 1).trimEnd()}…`;
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
        const result = await this.evolveWithProgression(input);
        return {
            stored: result.stored,
            action: result.action,
            reason: result.reason
        };
    }

    async evolveWithProgression(input: { projectId: string; text: string; context?: string }): Promise<EvolutionResult> {
        const progression: EvolutionProgression = {
            proposedCandidates: 0,
            reviewedCandidates: 0,
            merged: false,
            neighborCount: 0,
            promoted: false,
            archived: false,
            stages: []
        };

        const proposed = await this.writer.propose(input);
        progression.proposedCandidates = proposed.candidates.length;

        if (!proposed.candidates[0]) {
            this.pushStage(progression, "propose", false, "writer-returned-no-candidate");
            return {
                stored: false,
                action: "reject",
                reason: "no-candidate",
                progression
            };
        }
        this.pushStage(progression, "propose", true, `writer-produced-${proposed.candidates.length}-candidate(s)`);

        const reviewed = await this.reviewCandidates(proposed.candidates);
        progression.reviewedCandidates = reviewed.length;

        if (reviewed.length === 0) {
            this.pushStage(progression, "review", false, "critic-produced-no-review");
            return {
                stored: false,
                action: "reject",
                reason: "no-review",
                progression
            };
        }

        const selected = this.selectBestCandidateReview(reviewed);
        if (!selected || !selected.review.accepted || selected.review.action === "reject") {
            const topReason = selected?.review.reason ?? reviewed[0]?.review.reason ?? "critic-rejected";
            this.pushStage(progression, "review", false, topReason);
            return {
                stored: false,
                action: "reject",
                reason: topReason,
                progression
            };
        }
        progression.selectedCandidateIndex = selected.index;
        progression.selectedScore = selected.review.score;
        this.pushStage(progression, "review", true, `selected-candidate-${selected.index}-action-${selected.review.action}`);

        const now = Date.now();
        const atom: MemoryAtom = {
            id: randomId("mem"),
            projectId: input.projectId,
            kind: selected.candidate.kind,
            sourceType: "system",
            title: selected.candidate.title,
            summary: selected.candidate.summary,
            content: selected.candidate.content,
            tags: [...selected.candidate.tags],
            importance: clamp01(selected.review.score),
            confidence: clamp01(selected.review.clarity),
            createdAt: now,
            lastAccessedAt: now,
            sourceRef: selected.candidate.sourceRef
        };

        const neighbors = await this.store.searchSimilar(`${atom.title}\n${atom.summary}`, 5);
        progression.neighborCount = neighbors.length;

        let mergedAtom = atom;
        if (selected.review.action === "merge" && neighbors.length > 0) {
            const merged = await this.consolidator.merge({ candidate: atom, neighbors });
            mergedAtom = {
                ...atom,
                title: merged.title,
                summary: merged.summary,
                content: merged.content,
                tags: merged.tags,
                confidence: clamp01(merged.confidence)
            };
            progression.merged = true;
            this.pushStage(progression, "consolidate", true, `merged-with-${neighbors.length}-neighbor(s)`);
        } else if (selected.review.action === "compress") {
            mergedAtom = {
                ...atom,
                summary: summarizeContent(atom.summary, 180),
                content: summarizeContent(atom.content, 1200)
            };
            this.pushStage(progression, "consolidate", true, "compressed-candidate-content");
        } else {
            this.pushStage(progression, "consolidate", true, "no-consolidation-required");
        }

        const evolved = this.archivist.applyDecay(mergedAtom, now);
        const archivistProgression = this.archivist.evaluateProgression(mergedAtom, now);
        this.pushStage(
            progression,
            "archivist",
            true,
            `decay=${archivistProgression.decayFactor} promote=${archivistProgression.shouldPromote} archive=${archivistProgression.shouldArchive}`
        );

        let finalAtom = evolved;
        if (archivistProgression.shouldPromote) {
            progression.promoted = true;
            finalAtom = {
                ...finalAtom,
                importance: Math.max(finalAtom.importance, 0.9),
                tags: ensurePromotedTag(finalAtom.tags)
            };
        }

        if (archivistProgression.shouldArchive) {
            progression.archived = true;
            this.pushStage(progression, "persist", true, "candidate-not-stored-low-importance");
            return {
                stored: false,
                action: "archive",
                reason: "low-importance",
                atomId: finalAtom.id,
                progression
            };
        }

        await this.store.upsert(finalAtom);
        this.pushStage(progression, "persist", true, "upserted");

        return {
            stored: true,
            action: selected.review.action,
            reason: selected.review.reason,
            atomId: finalAtom.id,
            progression
        };
    }

    private async reviewCandidates(
        candidates: Array<{
            kind: MemoryAtom["kind"];
            title: string;
            summary: string;
            content: string;
            tags: string[];
            sourceRef?: string;
        }>
    ): Promise<CandidateReview[]> {
        const results: CandidateReview[] = [];

        for (let index = 0; index < candidates.length; index += 1) {
            const candidate = candidates[index];
            if (!candidate) {
                continue;
            }

            const similar = await this.store.searchSimilar(`${candidate.title}\n${candidate.summary}`, 3);
            const existingSnippets = similar
                .map((neighbor) => summarizeContent(`${neighbor.title} ${neighbor.summary}`, 180))
                .filter((snippet) => snippet.length > 0);

            const review = await this.critic.review({
                title: candidate.title,
                summary: candidate.summary,
                existingSnippets
            });

            results.push({
                index,
                candidate,
                review
            });
        }

        return results;
    }

    private selectBestCandidateReview(reviews: CandidateReview[]): CandidateReview | undefined {
        const sorted = [...reviews].sort((left, right) => {
            if (left.review.accepted !== right.review.accepted) {
                return left.review.accepted ? -1 : 1;
            }

            if (left.review.action !== right.review.action) {
                const weight = (action: CriticOutput["action"]): number => {
                    if (action === "merge") return 4;
                    if (action === "store") return 3;
                    if (action === "compress") return 2;
                    return 1;
                };

                return weight(right.review.action) - weight(left.review.action);
            }

            const scoreDelta = right.review.score - left.review.score;
            if (scoreDelta !== 0) {
                return scoreDelta;
            }

            return right.review.novelty - left.review.novelty;
        });

        return sorted[0];
    }

    private pushStage(
        progression: EvolutionProgression,
        stage: EvolutionStageProgress["stage"],
        ok: boolean,
        detail: string
    ): void {
        progression.stages.push({
            stage,
            ok,
            detail,
            at: Date.now()
        });
    }
}
