import type { MemoryAtom } from "../../types/memory";

export class ArchivistAgent {
    applyDecay(atom: MemoryAtom, now = Date.now()): MemoryAtom {
        const ageDays = (now - atom.createdAt) / 86_400_000;
        const decay = Math.max(0.4, 1 - ageDays * 0.002);
        return { ...atom, importance: Number((atom.importance * decay).toFixed(4)) };
    }

    shouldPromote(atom: MemoryAtom): boolean {
        return atom.importance >= 0.8 && atom.confidence >= 0.8;
    }

    shouldArchive(atom: MemoryAtom): boolean {
        return atom.importance < 0.25 && atom.confidence < 0.4;
    }
}
