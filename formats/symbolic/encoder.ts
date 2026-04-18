export interface SymbolicRule {
    pattern: RegExp;
    replacement: string;
}

const DEFAULT_RULES: SymbolicRule[] = [
    { pattern: /dynamic programming/gi, replacement: "DP" },
    { pattern: /recursion/gi, replacement: "REC" },
    { pattern: /binary search/gi, replacement: "BS(log n)" },
    { pattern: /depth[- ]first search/gi, replacement: "DFS" },
    { pattern: /breadth[- ]first search/gi, replacement: "BFS" },
    { pattern: /time complexity/gi, replacement: "T(n)" },
    { pattern: /space complexity/gi, replacement: "S(n)" },
    { pattern: /big[- ]o\s*\(([^)]+)\)/gi, replacement: "O($1)" }
];

export function encodeSymbolic(text: string, rules: SymbolicRule[] = DEFAULT_RULES): string {
    let out = text;
    for (const rule of rules) {
        out = out.replace(rule.pattern, rule.replacement);
    }
    return out;
}
