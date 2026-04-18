export interface WriterDraft {
    title: string;
    summary: string;
    content: string;
    tags: string[];
}

function detectTags(text: string): string[] {
    const lowered = text.toLowerCase();
    const tags: string[] = [];

    if (/(refactor|cleanup|rewrite)/.test(lowered)) tags.push("refactor");
    if (/(bug|fix|error|exception)/.test(lowered)) tags.push("bugfix");
    if (/(optimi[sz]e|performance|latency)/.test(lowered)) tags.push("performance");
    if (/(test|spec|assert)/.test(lowered)) tags.push("testing");
    if (/(typescript|ts\b|node)/.test(lowered)) tags.push("typescript");

    if (tags.length === 0) tags.push("general");
    return [...new Set(tags)];
}

export function writerAgentDraft(input: string): WriterDraft {
    const clean = input.trim();
    const summary = clean.length > 180 ? `${clean.slice(0, 179).trimEnd()}…` : clean;

    return {
        title: clean.split(/\r?\n/)[0]?.slice(0, 72) || "Untitled memory",
        summary,
        content: clean,
        tags: detectTags(clean)
    };
}

export function writerAgent(input: string): string {
    const draft = writerAgentDraft(input);
    return `[writer-candidate] ${draft.title} :: ${draft.summary}`;
}
