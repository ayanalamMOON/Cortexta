import { sha256 } from "../utils/hash";

export interface IncrementalDelta {
    filePath: string;
    previousHash?: string;
    nextHash: string;
    changed: boolean;
}

export function shouldReparse(delta: IncrementalDelta): boolean {
    return delta.changed || delta.previousHash !== delta.nextHash;
}

export interface IncrementalRegistry {
    computeDelta: (filePath: string, source: string) => IncrementalDelta;
    getHash: (filePath: string) => string | undefined;
    reset: () => void;
}

export function createIncrementalRegistry(): IncrementalRegistry {
    const hashes = new Map<string, string>();

    return {
        computeDelta(filePath: string, source: string): IncrementalDelta {
            const previousHash = hashes.get(filePath);
            const nextHash = sha256(source);
            const changed = previousHash !== nextHash;
            hashes.set(filePath, nextHash);

            return {
                filePath,
                previousHash,
                nextHash,
                changed
            };
        },
        getHash(filePath: string): string | undefined {
            return hashes.get(filePath);
        },
        reset(): void {
            hashes.clear();
        }
    };
}
