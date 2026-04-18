export interface CompressorOptions {
    maxChars?: number;
    preserveLineBreaks?: boolean;
}

function dedupeLines(lines: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        const key = line.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(line);
    }

    return out;
}

export function compressorAgent(text: string, options: CompressorOptions = {}): string {
    const maxChars = options.maxChars ?? 320;
    const normalized = options.preserveLineBreaks
        ? dedupeLines(text.split(/\r?\n/)).join("\n")
        : text.replace(/\s+/g, " ").trim();

    if (normalized.length <= maxChars) {
        return normalized;
    }

    const cut = normalized.slice(0, maxChars);
    const boundary = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "), cut.lastIndexOf(", "));
    if (boundary > Math.floor(maxChars * 0.55)) {
        return `${cut.slice(0, boundary + 1).trimEnd()}…`;
    }
    return `${cut.trimEnd()}…`;
}
