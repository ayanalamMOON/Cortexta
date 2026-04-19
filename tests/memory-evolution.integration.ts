import assert from "node:assert/strict";
import {
    MemoryEvolutionEngine,
    type EvolutionMemoryStore
} from "../packages/core/src/memory/evolution/engine";
import type { MemoryAtom } from "../packages/core/src/types/memory";

class MockEvolutionStore implements EvolutionMemoryStore {
    private readonly records = new Map<string, MemoryAtom>();

    public upsertCount = 0;

    public archiveCount = 0;

    constructor(seed: MemoryAtom[] = []) {
        for (const atom of seed) {
            this.records.set(atom.id, atom);
        }
    }

    async searchSimilar(text: string, topK: number): Promise<MemoryAtom[]> {
        const q = text.trim().toLowerCase();
        if (!q) {
            return [...this.records.values()].slice(0, topK);
        }

        const ranked = [...this.records.values()]
            .map((atom) => {
                const bag = `${atom.title}\n${atom.summary}\n${atom.content}`.toLowerCase();
                const overlap = q
                    .split(/[^a-z0-9_]+/)
                    .filter((token) => token.length > 1)
                    .filter((token) => bag.includes(token)).length;

                return {
                    atom,
                    overlap
                };
            })
            .sort((left, right) => right.overlap - left.overlap)
            .map((row) => row.atom);

        return ranked.slice(0, topK);
    }

    async upsert(atom: MemoryAtom): Promise<void> {
        this.records.set(atom.id, atom);
        this.upsertCount += 1;
    }

    async archive(atomId: string): Promise<void> {
        if (this.records.has(atomId)) {
            this.archiveCount += 1;
        }
    }

    all(): MemoryAtom[] {
        return [...this.records.values()];
    }
}

function seedNeighbor(projectId: string): MemoryAtom {
    return {
        id: "seed_neighbor_1",
        projectId,
        kind: "semantic",
        sourceType: "system",
        title: "Caching strategy baseline",
        summary: "Current cache approach for memory retrieval",
        content: "Document existing cache strategy before introducing progression upgrades.",
        tags: ["memory", "cache"],
        importance: 0.75,
        confidence: 0.78,
        createdAt: Date.now() - 3600_000,
        lastAccessedAt: Date.now() - 120_000,
        sourceRef: "seed"
    };
}

async function testProgressionAndCompatibility(): Promise<void> {
    const projectId = "evolution-progression-test";
    const store = new MockEvolutionStore([seedNeighbor(projectId)]);

    const writer = {
        async propose(): Promise<{
            candidates: Array<{
                kind: MemoryAtom["kind"];
                title: string;
                summary: string;
                content: string;
                tags: string[];
                sourceRef?: string;
            }>;
        }> {
            return {
                candidates: [
                    {
                        kind: "semantic",
                        title: "Low signal note",
                        summary: "A weak candidate",
                        content: "weak",
                        tags: ["draft"],
                        sourceRef: "test"
                    },
                    {
                        kind: "procedural",
                        title: "Primary evolution candidate",
                        summary: "Upgrade progression pipeline with staged telemetry and safer decisions.",
                        content: "Upgrade progression pipeline with staged telemetry, candidate ranking, and archive guards.",
                        tags: ["upgrade", "progression", "telemetry"],
                        sourceRef: "test"
                    }
                ]
            };
        }
    };

    const critic = {
        async review(input: { title: string }): Promise<{
            accepted: boolean;
            score: number;
            novelty: number;
            redundancy: number;
            clarity: number;
            action: "store" | "merge" | "reject" | "compress";
            reason: string;
            mergeKey?: string;
        }> {
            if (input.title.toLowerCase().includes("primary")) {
                return {
                    accepted: true,
                    score: 0.91,
                    novelty: 0.95,
                    redundancy: 0.08,
                    clarity: 0.9,
                    action: "merge",
                    reason: "best-candidate",
                    mergeKey: "primary"
                };
            }

            return {
                accepted: false,
                score: 0.2,
                novelty: 0.2,
                redundancy: 0.8,
                clarity: 0.3,
                action: "reject",
                reason: "low-signal"
            };
        }
    };

    const consolidator = {
        async merge(input: { candidate: MemoryAtom }): Promise<{
            title: string;
            summary: string;
            content: string;
            tags: string[];
            confidence: number;
        }> {
            return {
                title: `${input.candidate.title} (merged)`,
                summary: `${input.candidate.summary} Merged with nearby memory anchors.`,
                content: `${input.candidate.content}\n\nMerged context attached.`,
                tags: [...input.candidate.tags, "merged"],
                confidence: 0.93
            };
        }
    };

    const engine = new MemoryEvolutionEngine(writer as any, critic as any, consolidator as any, store);

    const result = await engine.evolveWithProgression({
        projectId,
        text: "Please update and upgrade the evolution and progression flow."
    });

    assert.equal(result.stored, true, "detailed evolution should store selected candidate");
    assert.equal(result.action, "merge", "selected candidate should follow critic merge action");
    assert.equal(result.reason, "best-candidate", "reason should surface critic rationale");
    assert.equal(result.progression.proposedCandidates, 2, "progression should track proposed candidate count");
    assert.equal(result.progression.reviewedCandidates, 2, "progression should track reviewed candidate count");
    assert.equal(result.progression.selectedCandidateIndex, 1, "engine should choose strongest candidate");
    assert.equal(result.progression.merged, true, "engine should mark merged progression");
    assert.ok(result.progression.neighborCount >= 1, "engine should report neighbor count");
    assert.equal(result.progression.promoted, true, "high-score candidate should be promoted");

    const stageNames = result.progression.stages.map((stage) => stage.stage);
    assert.ok(stageNames.includes("propose"), "stages should include propose");
    assert.ok(stageNames.includes("review"), "stages should include review");
    assert.ok(stageNames.includes("consolidate"), "stages should include consolidate");
    assert.ok(stageNames.includes("archivist"), "stages should include archivist");
    assert.ok(stageNames.includes("persist"), "stages should include persist");

    assert.equal(store.upsertCount, 1, "store should receive one upsert call");
    const stored = store
        .all()
        .find((atom) => atom.id === result.atomId);
    assert.ok(stored, "stored atom should exist in store");
    assert.ok(stored?.tags.some((tag) => tag.toLowerCase() === "promoted"), "stored atom should include promoted tag");

    const legacy = await engine.evolve({
        projectId,
        text: "Compatibility call for legacy evolve API"
    });

    assert.deepEqual(
        Object.keys(legacy).sort(),
        ["action", "reason", "stored"],
        "legacy evolve() should keep compact return contract"
    );
}

async function testRejectPath(): Promise<void> {
    const store = new MockEvolutionStore();

    const writer = {
        async propose(): Promise<{
            candidates: Array<{
                kind: MemoryAtom["kind"];
                title: string;
                summary: string;
                content: string;
                tags: string[];
                sourceRef?: string;
            }>;
        }> {
            return {
                candidates: [
                    {
                        kind: "semantic",
                        title: "Rejected candidate",
                        summary: "Rejected",
                        content: "Rejected",
                        tags: ["draft"],
                        sourceRef: "test"
                    }
                ]
            };
        }
    };

    const critic = {
        async review(): Promise<{
            accepted: boolean;
            score: number;
            novelty: number;
            redundancy: number;
            clarity: number;
            action: "store" | "merge" | "reject" | "compress";
            reason: string;
            mergeKey?: string;
        }> {
            return {
                accepted: false,
                score: 0.1,
                novelty: 0.1,
                redundancy: 0.9,
                clarity: 0.2,
                action: "reject",
                reason: "critic-reject"
            };
        }
    };

    const consolidator = {
        async merge(input: { candidate: MemoryAtom }): Promise<{
            title: string;
            summary: string;
            content: string;
            tags: string[];
            confidence: number;
        }> {
            return {
                title: input.candidate.title,
                summary: input.candidate.summary,
                content: input.candidate.content,
                tags: input.candidate.tags,
                confidence: input.candidate.confidence
            };
        }
    };

    const engine = new MemoryEvolutionEngine(writer as any, critic as any, consolidator as any, store);
    const result = await engine.evolveWithProgression({
        projectId: "reject-path",
        text: "reject me"
    });

    assert.equal(result.stored, false, "reject path should not store");
    assert.equal(result.action, "reject", "reject path should surface reject action");
    assert.equal(store.upsertCount, 0, "reject path must not upsert");
    assert.ok(
        result.progression.stages.some((stage) => stage.stage === "review" && stage.ok === false),
        "reject path should mark review stage as failed"
    );
}

async function testArchivePath(): Promise<void> {
    const store = new MockEvolutionStore();

    const writer = {
        async propose(): Promise<{
            candidates: Array<{
                kind: MemoryAtom["kind"];
                title: string;
                summary: string;
                content: string;
                tags: string[];
                sourceRef?: string;
            }>;
        }> {
            return {
                candidates: [
                    {
                        kind: "semantic",
                        title: "Very low signal",
                        summary: "noise",
                        content: "noise",
                        tags: ["draft"],
                        sourceRef: "test"
                    }
                ]
            };
        }
    };

    const critic = {
        async review(): Promise<{
            accepted: boolean;
            score: number;
            novelty: number;
            redundancy: number;
            clarity: number;
            action: "store" | "merge" | "reject" | "compress";
            reason: string;
            mergeKey?: string;
        }> {
            return {
                accepted: true,
                score: 0.05,
                novelty: 0.1,
                redundancy: 0.9,
                clarity: 0.2,
                action: "store",
                reason: "accepted-but-low"
            };
        }
    };

    const consolidator = {
        async merge(input: { candidate: MemoryAtom }): Promise<{
            title: string;
            summary: string;
            content: string;
            tags: string[];
            confidence: number;
        }> {
            return {
                title: input.candidate.title,
                summary: input.candidate.summary,
                content: input.candidate.content,
                tags: input.candidate.tags,
                confidence: input.candidate.confidence
            };
        }
    };

    const engine = new MemoryEvolutionEngine(writer as any, critic as any, consolidator as any, store);
    const result = await engine.evolveWithProgression({
        projectId: "archive-path",
        text: "archive me"
    });

    assert.equal(result.stored, false, "archive path should not store");
    assert.equal(result.action, "archive", "archive path should surface archive action");
    assert.equal(result.progression.archived, true, "progression should mark archived path");
    assert.equal(store.upsertCount, 0, "archive path should not persist atom");
}

async function main(): Promise<void> {
    await testProgressionAndCompatibility();
    await testRejectPath();
    await testArchivePath();
    console.log("✅ memory evolution integration test passed");
}

main().catch((error) => {
    console.error("❌ memory evolution integration test failed");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
