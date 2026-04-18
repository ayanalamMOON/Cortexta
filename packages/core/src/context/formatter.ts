import type { ContextAtom } from "../types/context";
import { normalizeWhitespace } from "../utils/text";

function escapePipes(text: string): string {
    return text.replace(/\|/g, "\\|");
}

function compactBody(text: string, max = 180): string {
    const clean = normalizeWhitespace(text);
    if (clean.length <= max) return clean;
    return `${clean.slice(0, max - 1)}…`;
}

export function renderAtom(atom: ContextAtom, mode: "full" | "compact" | "symbolic" = "compact"): string {
    if (mode === "symbolic") {
        const tags = atom.tags?.length ? ` tags=${atom.tags.join(",")}` : "";
        return `• ${atom.title} :: ${atom.kind.toUpperCase()} p=${atom.priority.toFixed(2)} r=${atom.relevance.toFixed(2)}${tags}`;
    }

    if (mode === "compact") {
        const tags = atom.tags?.length ? `\n  tags: ${atom.tags.join(", ")}` : "";
        const source = atom.sourceRef ? `\n  source: ${atom.sourceRef}` : "";
        return `• ${atom.title}\n  ${compactBody(atom.body)}${tags}${source}`;
    }

    return [
        `• ${atom.title}`,
        `kind: ${atom.kind}`,
        `priority: ${atom.priority.toFixed(2)}  recency: ${atom.recency.toFixed(2)}  relevance: ${atom.relevance.toFixed(2)}`,
        atom.sourceRef ? `source: ${atom.sourceRef}` : "",
        atom.tags?.length ? `tags: ${atom.tags.join(", ")}` : "",
        atom.body
    ]
        .filter(Boolean)
        .join("\n");
}

export interface RenderContextOptions {
    mode?: "full" | "compact" | "symbolic";
    includeTable?: boolean;
}

function renderTable(atoms: ContextAtom[]): string {
    const rows = [
        "| # | kind | title | priority | relevance | recency |",
        "|---:|---|---|---:|---:|---:|"
    ];

    atoms.forEach((atom, index) => {
        rows.push(
            `| ${index + 1} | ${escapePipes(atom.kind)} | ${escapePipes(compactBody(atom.title, 48))} | ${atom.priority.toFixed(2)} | ${atom.relevance.toFixed(2)} | ${atom.recency.toFixed(2)} |`
        );
    });

    return rows.join("\n");
}

export function renderContext(atoms: ContextAtom[], query: string, options: RenderContextOptions = {}): string {
    const mode = options.mode ?? "compact";
    const lines = atoms.map((a) => renderAtom(a, mode));
    const header = [`[CORTEXA_CONTEXT]`, `intent: ${query}`, `atoms: ${atoms.length}`, ""];

    if (options.includeTable && atoms.length > 0) {
        return [...header, renderTable(atoms), "", ...lines].join("\n");
    }

    return [...header, ...lines].join("\n");
}
