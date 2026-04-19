import type { MemoryAtom } from "../../types/memory";

export interface ArchivistProgression {
    ageDays: number;
    decayFactor: number;
    importanceBefore: number;
    importanceAfter: number;
    confidenceBefore: number;
    confidenceAfter: number;
    shouldPromote: boolean;
    shouldArchive: boolean;
    reasons: string[];
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function round4(value: number): number {
    return Number(value.toFixed(4));
}

function hasProtectedTags(tags: string[]): boolean {
    const protectedTags = new Set(["critical", "keep", "pinned", "do-not-archive", "golden"]);
    return tags.some((tag) => protectedTags.has(tag.trim().toLowerCase()));
}

export class ArchivistAgent {
    evaluateProgression(atom: MemoryAtom, now = Date.now()): ArchivistProgression {
        const ageDays = (now - atom.createdAt) / 86_400_000;
        const boundedAgeDays = Number.isFinite(ageDays) ? Math.max(0, ageDays) : 0;
        const decayFactor = Math.max(0.35, 1 - boundedAgeDays * 0.002);

        const protectedByTag = hasProtectedTags(atom.tags);
        const sourceBoost = atom.kind === "code_entity" ? 0.03 : atom.kind === "procedural" ? 0.02 : 0;
        const confidenceBoost = atom.confidence >= 0.85 ? 0.02 : 0;
        const protectionBoost = protectedByTag ? 0.08 : 0;

        const importanceAfter = round4(clamp01(atom.importance * decayFactor + sourceBoost + confidenceBoost + protectionBoost));
        const confidenceAfter = round4(clamp01(atom.confidence * Math.max(0.75, 1 - boundedAgeDays * 0.0008)));

        const reasons: string[] = [];
        if (protectedByTag) {
            reasons.push("protected-by-tag");
        }

        if (importanceAfter >= 0.82 && confidenceAfter >= 0.82) {
            reasons.push("promotion-threshold-met");
        }

        if (importanceAfter < 0.22 && confidenceAfter < 0.45 && !protectedByTag) {
            reasons.push("archive-threshold-met");
        }

        return {
            ageDays: round4(boundedAgeDays),
            decayFactor: round4(decayFactor),
            importanceBefore: round4(clamp01(atom.importance)),
            importanceAfter,
            confidenceBefore: round4(clamp01(atom.confidence)),
            confidenceAfter,
            shouldPromote: reasons.includes("promotion-threshold-met"),
            shouldArchive: reasons.includes("archive-threshold-met"),
            reasons
        };
    }

    applyDecay(atom: MemoryAtom, now = Date.now()): MemoryAtom {
        const progression = this.evaluateProgression(atom, now);
        return {
            ...atom,
            importance: progression.importanceAfter,
            confidence: progression.confidenceAfter
        };
    }

    shouldPromote(atom: MemoryAtom): boolean {
        return this.evaluateProgression(atom).shouldPromote;
    }

    shouldArchive(atom: MemoryAtom): boolean {
        return this.evaluateProgression(atom).shouldArchive;
    }
}
