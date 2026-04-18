export interface AstFacts {
    imports: string[];
    functions: string[];
    classes: string[];
    loops: number;
    branches: number;
    complexityHint: string;
}

function unique(values: string[]): string[] {
    return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function inferComplexity(loops: number, branches: number): string {
    if (loops >= 2) return "likely O(n^k) due to nested loops";
    if (loops === 1 && branches > 0) return "likely O(n) with branch-dependent flow";
    if (loops === 1) return "likely O(n)";
    if (branches > 0) return "branch-heavy, data-dependent complexity";
    return "likely bounded helper or direct mapping";
}

export function extractAstFacts(source: string): AstFacts {
    if (!source.trim()) {
        return {
            imports: [],
            functions: [],
            classes: [],
            loops: 0,
            branches: 0,
            complexityHint: "empty source"
        };
    }

    const imports = unique(
        [...source.matchAll(/^\s*(?:import\s+.*from\s+["'][^"']+["']|#include\s+[<"][^>"]+[>"])/gm)].map((m) => m[0])
    );

    const functions = unique(
        [
            ...source.matchAll(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g),
            ...source.matchAll(/\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g),
            ...source.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\([^)]*\)\s*=>/g)
        ].map((m) => m[1])
    );

    const classes = unique(
        [...source.matchAll(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g), ...source.matchAll(/\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map(
            (m) => m[1]
        )
    );

    const loops = ([...source.matchAll(/\bfor\b/g)].length + [...source.matchAll(/\bwhile\b/g)].length);
    const branches =
        [...source.matchAll(/\bif\b/g)].length +
        [...source.matchAll(/\bswitch\b/g)].length +
        [...source.matchAll(/\bcase\b/g)].length;

    return {
        imports,
        functions,
        classes,
        loops,
        branches,
        complexityHint: inferComplexity(loops, branches)
    };
}
