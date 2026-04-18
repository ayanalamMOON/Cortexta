export function chunkText(input: string, max = 800): string[] {
    const out: string[] = [];
    for (let i = 0; i < input.length; i += max) {
        out.push(input.slice(i, i + max));
    }
    return out;
}

export function chunkByParagraph(input: string, maxChars = 1200): string[] {
    const paragraphs = input
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);

    const chunks: string[] = [];
    let current = "";

    for (const paragraph of paragraphs) {
        const next = current ? `${current}\n\n${paragraph}` : paragraph;
        if (next.length > maxChars && current) {
            chunks.push(current);
            current = paragraph;
        } else {
            current = next;
        }
    }

    if (current) {
        chunks.push(current);
    }

    return chunks.length > 0 ? chunks : chunkText(input, maxChars);
}
