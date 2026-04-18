export interface CxfPayload {
    intent: string;
    scope: string;
    concepts: string[];
    graph: string[];
    history: string[];
    constraints: string[];
    metadata?: Record<string, unknown>;
}

function cleanList(values: string[]): string[] {
    return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function section(title: string, rows: string[]): string[] {
    if (rows.length === 0) return [title, "  - none"];
    return [title, ...rows.map((row) => `  - ${row}`)];
}

export function toCxfText(payload: CxfPayload): string {
    const concepts = cleanList(payload.concepts);
    const graph = cleanList(payload.graph);
    const history = cleanList(payload.history);
    const constraints = cleanList(payload.constraints);

    return [
        "[CORTEXA_CONTEXT]",
        "",
        `intent: ${payload.intent}`,
        `scope: ${payload.scope}`,
        "",
        ...section("concepts:", concepts),
        ...section("graph:", graph),
        ...section("history:", history),
        ...section("constraints:", constraints),
        payload.metadata ? "" : "",
        payload.metadata ? `metadata: ${JSON.stringify(payload.metadata)}` : ""
    ]
        .filter(Boolean)
        .join("\n");
}

export function fromCxfText(text: string): CxfPayload {
    const lines = text.split(/\r?\n/);
    const payload: CxfPayload = {
        intent: "",
        scope: "",
        concepts: [],
        graph: [],
        history: [],
        constraints: []
    };

    let sectionName: "concepts" | "graph" | "history" | "constraints" | null = null;
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith("intent:")) {
            payload.intent = line.slice("intent:".length).trim();
            sectionName = null;
            continue;
        }
        if (line.startsWith("scope:")) {
            payload.scope = line.slice("scope:".length).trim();
            sectionName = null;
            continue;
        }

        if (line === "concepts:") {
            sectionName = "concepts";
            continue;
        }
        if (line === "graph:") {
            sectionName = "graph";
            continue;
        }
        if (line === "history:") {
            sectionName = "history";
            continue;
        }
        if (line === "constraints:") {
            sectionName = "constraints";
            continue;
        }

        if (line.startsWith("- ") || line.startsWith("• ") || line.startsWith("* ") || line.startsWith("+ ")) {
            const value = line.slice(2).trim();
            if (!value || value === "none" || !sectionName) continue;
            payload[sectionName].push(value);
        }
    }

    payload.concepts = cleanList(payload.concepts);
    payload.graph = cleanList(payload.graph);
    payload.history = cleanList(payload.history);
    payload.constraints = cleanList(payload.constraints);

    return payload;
}
