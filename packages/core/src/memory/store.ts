import type { MemoryAtom } from "../types/memory";
import { consolidateMemories } from "./consolidate";
import { scoreMemory, sortByScore } from "./retrieval";

export interface SearchOptions {
    projectId?: string;
    topK?: number;
    includeArchived?: boolean;
    preferredTags?: string[];
}

export interface MemoryStoreStats {
    total: number;
    active: number;
    archived: number;
    byKind: Record<MemoryAtom["kind"], number>;
}

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 1);
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function normalizedAtom(atom: MemoryAtom, existing?: MemoryAtom): MemoryAtom {
    const now = Date.now();
    return {
        ...atom,
        title: atom.title.trim(),
        summary: atom.summary.trim(),
        content: atom.content,
        tags: [...new Set(atom.tags.map((tag) => tag.trim()).filter(Boolean))],
        importance: clamp01(atom.importance),
        confidence: clamp01(atom.confidence),
        createdAt: existing?.createdAt ?? atom.createdAt ?? now,
        lastAccessedAt: atom.lastAccessedAt ?? existing?.lastAccessedAt ?? now
    };
}

export class MemoryStore {
    private byId = new Map<string, MemoryAtom>();

    private archived = new Set<string>();

    private projectIndex = new Map<string, Set<string>>();

    private tokenIndex = new Map<string, Set<string>>();

    constructor(initial: MemoryAtom[] = []) {
        if (initial.length > 0) {
            this.upsertManySync(initial);
        }
    }

    private addToIndexes(atom: MemoryAtom): void {
        const projectBucket = this.projectIndex.get(atom.projectId) ?? new Set<string>();
        projectBucket.add(atom.id);
        this.projectIndex.set(atom.projectId, projectBucket);

        const indexable = `${atom.title}\n${atom.summary}\n${atom.tags.join(" ")}`;
        for (const token of tokenize(indexable)) {
            const bucket = this.tokenIndex.get(token) ?? new Set<string>();
            bucket.add(atom.id);
            this.tokenIndex.set(token, bucket);
        }
    }

    private removeFromIndexes(atom: MemoryAtom): void {
        const projectBucket = this.projectIndex.get(atom.projectId);
        if (projectBucket) {
            projectBucket.delete(atom.id);
            if (projectBucket.size === 0) this.projectIndex.delete(atom.projectId);
        }

        const indexable = `${atom.title}\n${atom.summary}\n${atom.tags.join(" ")}`;
        for (const token of tokenize(indexable)) {
            const bucket = this.tokenIndex.get(token);
            if (!bucket) continue;
            bucket.delete(atom.id);
            if (bucket.size === 0) this.tokenIndex.delete(token);
        }
    }

    private idsByProject(projectId?: string): Set<string> {
        if (!projectId) {
            return new Set<string>(this.byId.keys());
        }
        return new Set<string>(this.projectIndex.get(projectId) ?? []);
    }

    upsertSync(atom: MemoryAtom): void {
        const existing = this.byId.get(atom.id);
        if (existing) {
            this.removeFromIndexes(existing);
        }

        const clean = normalizedAtom(atom, existing);
        this.byId.set(clean.id, clean);
        this.addToIndexes(clean);
    }

    upsertManySync(atoms: MemoryAtom[]): void {
        for (const atom of atoms) {
            this.upsertSync(atom);
        }
    }

    get(id: string): MemoryAtom | undefined {
        const atom = this.byId.get(id);
        if (!atom || this.archived.has(id)) return undefined;
        return atom;
    }

    delete(id: string): boolean {
        const atom = this.byId.get(id);
        if (!atom) return false;

        this.removeFromIndexes(atom);
        this.byId.delete(id);
        this.archived.delete(id);
        return true;
    }

    archiveSync(id: string): void {
        if (this.byId.has(id)) {
            this.archived.add(id);
        }
    }

    restore(id: string): void {
        this.archived.delete(id);
    }

    markAccessed(id: string, at = Date.now()): void {
        const atom = this.byId.get(id);
        if (!atom) return;
        this.byId.set(id, {
            ...atom,
            lastAccessedAt: at
        });
    }

    search(query: string, topK = 10, options: SearchOptions = {}): MemoryAtom[] {
        const q = query.trim();
        if (!q) return [];

        const queryTokens = tokenize(q);
        const candidateIds = this.idsByProject(options.projectId);

        if (queryTokens.length > 0) {
            const tokenMatched = new Set<string>();
            for (const token of queryTokens) {
                const bucket = this.tokenIndex.get(token);
                if (!bucket) continue;
                for (const id of bucket) {
                    if (candidateIds.has(id)) tokenMatched.add(id);
                }
            }

            if (tokenMatched.size > 0) {
                for (const id of [...candidateIds]) {
                    if (!tokenMatched.has(id)) candidateIds.delete(id);
                }
            }
        }

        const candidates: MemoryAtom[] = [];
        for (const id of candidateIds) {
            if (!options.includeArchived && this.archived.has(id)) continue;
            const atom = this.byId.get(id);
            if (!atom) continue;
            candidates.push(atom);
        }

        const rescored = candidates
            .map((atom) => ({
                atom,
                score: scoreMemory(atom, {
                    query: q,
                    projectId: options.projectId,
                    preferredTags: options.preferredTags
                })
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map((row) => row.atom);

        for (const atom of rescored) {
            this.markAccessed(atom.id);
        }

        return rescored;
    }

    searchSimilarSync(text: string, topK = 10, options: SearchOptions = {}): MemoryAtom[] {
        return this.search(text, topK, options);
    }

    all(options: { includeArchived?: boolean; projectId?: string } = {}): MemoryAtom[] {
        const ids = this.idsByProject(options.projectId);
        const rows: MemoryAtom[] = [];
        for (const id of ids) {
            if (!options.includeArchived && this.archived.has(id)) continue;
            const atom = this.byId.get(id);
            if (atom) rows.push(atom);
        }

        return sortByScore(rows, {
            projectId: options.projectId
        });
    }

    consolidate(projectId?: string): MemoryAtom[] {
        const base = this.all({ includeArchived: false, projectId });
        const consolidated = consolidateMemories(base);

        const stableIds = new Set(consolidated.map((m) => m.id));
        for (const atom of base) {
            if (!stableIds.has(atom.id)) {
                this.archiveSync(atom.id);
            }
        }

        for (const atom of consolidated) {
            this.upsertSync(atom);
        }

        return consolidated;
    }

    stats(): MemoryStoreStats {
        const byKind: MemoryStoreStats["byKind"] = {
            episodic: 0,
            semantic: 0,
            procedural: 0,
            code_entity: 0,
            chat_turn: 0,
            refactor_plan: 0
        };

        for (const atom of this.byId.values()) {
            byKind[atom.kind] += 1;
        }

        return {
            total: this.byId.size,
            active: this.byId.size - this.archived.size,
            archived: this.archived.size,
            byKind
        };
    }

    async upsert(atom: MemoryAtom): Promise<void> {
        this.upsertSync(atom);
    }

    async searchSimilar(text: string, topK: number): Promise<MemoryAtom[]> {
        return this.searchSimilarSync(text, topK);
    }

    async archive(atomId: string): Promise<void> {
        this.archiveSync(atomId);
    }
}
