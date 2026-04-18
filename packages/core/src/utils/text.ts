export function compact(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

export function truncate(text: string, max = 240): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function normalizeWhitespace(text: string): string {
    return text
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+/g, " ")
        .trim();
}

export function safeSnippet(text: string, maxLen = 240): string {
    const cleaned = normalizeWhitespace(text);
    return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen - 1)}…`;
}
