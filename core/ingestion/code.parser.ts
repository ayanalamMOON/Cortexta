import path from "node:path";
import { extractAstFacts, type AstFacts } from "./ast.extractor";
import { chunkByParagraph } from "./chunker";

export interface CodeChunk {
    title: string;
    summary: string;
    content: string;
    tags: string[];
}

export interface ParsedCodeFile {
    filePath: string;
    language: string;
    lines: number;
    facts: AstFacts;
    chunks: CodeChunk[];
}

function detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if ([".ts", ".tsx"].includes(ext)) return "typescript";
    if ([".js", ".jsx"].includes(ext)) return "javascript";
    if (ext === ".py") return "python";
    if ([".cpp", ".cc", ".cxx", ".hpp", ".h"].includes(ext)) return "cpp";
    if (ext === ".java") return "java";
    return ext.replace(".", "") || "unknown";
}

export function parseCode(filePath: string, source: string): ParsedCodeFile {
    const lines = source.split(/\r?\n/).length;
    const language = detectLanguage(filePath);
    const facts = extractAstFacts(source);
    const parts = chunkByParagraph(source, 1400);

    const chunks = parts.map<CodeChunk>((content, index) => {
        const fn = facts.functions[index] ?? facts.functions[0];
        const cls = facts.classes[index] ?? facts.classes[0];
        const anchor = fn ? `function ${fn}` : cls ? `class ${cls}` : `${language} chunk ${index + 1}`;

        return {
            title: `${path.basename(filePath)} :: ${anchor}`,
            summary: `${anchor}; loops=${facts.loops}; branches=${facts.branches}; ${facts.complexityHint}`,
            content,
            tags: [language, "code", fn ? "function" : cls ? "class" : "chunk"].filter(Boolean)
        };
    });

    return {
        filePath,
        language,
        lines,
        facts,
        chunks
    };
}
