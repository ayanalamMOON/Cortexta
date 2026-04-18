import path from "node:path";
import Parser from "tree-sitter";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TypeScriptGrammar = require("tree-sitter-typescript");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const CppGrammar = require("tree-sitter-cpp");

export type SupportedLanguage = "typescript" | "tsx" | "cpp" | "python";

export interface ParserBundle {
    parser: Parser;
    language: SupportedLanguage;
}

export function detectLanguage(filePath: string): SupportedLanguage | null {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".ts") return "typescript";
    if (ext === ".tsx") return "tsx";
    if ([".cpp", ".cc", ".cxx", ".hpp", ".h"].includes(ext)) return "cpp";
    if (ext === ".py") return "python";
    return null;
}

export function createParserForFile(filePath: string): ParserBundle {
    const language = detectLanguage(filePath);
    if (!language) {
        throw new Error(`Unsupported file type for parser: ${filePath}`);
    }

    const parser = new Parser();

    if (language === "typescript") {
        parser.setLanguage(TypeScriptGrammar.typescript);
    } else if (language === "tsx") {
        parser.setLanguage(TypeScriptGrammar.tsx);
    } else if (language === "cpp") {
        const cppLanguage = CppGrammar.default ?? CppGrammar;
        parser.setLanguage(cppLanguage);
    } else {
        // Python parser package is not in dependencies yet. We keep detection for routing while
        // parsing falls back to regex extraction in caller when parser construction fails.
        throw new Error("Python tree-sitter grammar is not configured in this build.");
    }

    return { parser, language };
}
