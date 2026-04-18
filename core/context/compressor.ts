const SYMBOLIC_RULES: Array<[RegExp, string]> = [
    [/\bdynamic programming\b/gi, "DP"],
    [/\brecursion\b/gi, "REC"],
    [/\bbinary search\b/gi, "BS(log n)"],
    [/\bfor loop over n elements\b/gi, "LOOP[n]"],
    [/\bdivide by 2\b/gi, "/2"]
];

export function compressContextText(text: string): string {
    let output = text;

    for (const [pattern, replacement] of SYMBOLIC_RULES) {
        output = output.replace(pattern, replacement);
    }

    return output.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function compressSummary(summary: string, maxChars = 180): string {
    const cleaned = compressContextText(summary);
    return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars - 1)}…`;
}
