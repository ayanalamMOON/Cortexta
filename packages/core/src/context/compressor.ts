import type { ContextAtom } from "../types/context";
import { normalizeWhitespace } from "../utils/text";

function trimAtSentence(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;

    const window = text.slice(0, maxChars);
    const boundary = Math.max(window.lastIndexOf(". "), window.lastIndexOf("; "), window.lastIndexOf("\n"));
    if (boundary >= Math.floor(maxChars * 0.55)) {
        return `${window.slice(0, boundary + 1).trimEnd()}…`;
    }
    return `${window.trimEnd()}…`;
}

function dedupeLines(body: string): string {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const rawLine of body.split(/\r?\n/)) {
        const line = normalizeWhitespace(rawLine);
        if (!line) continue;
        const key = line.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(line);
    }

    return out.join("\n");
}

export function compressAtom(atom: ContextAtom, maxBodyChars = 220): ContextAtom {
    const normalized = dedupeLines(atom.body);
    const compressed = trimAtSentence(normalized, maxBodyChars);

    return {
        ...atom,
        body: compressed
    };
}

export function compressAtoms(atoms: ContextAtom[], maxBodyChars = 220): ContextAtom[] {
    return atoms.map((atom) => compressAtom(atom, maxBodyChars));
}
