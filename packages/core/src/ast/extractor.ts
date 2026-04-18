import fs from "node:fs";
import path from "node:path";
import type { CodeEntity, ExtractedFile } from "../types/memory";
import { sha256 } from "../utils/hash";
import { randomId } from "../utils/ids";
import { normalizeWhitespace } from "../utils/text";
import { createParserForFile, detectLanguage } from "./language-registry";
import { classifyNodeType, summarizeEntity } from "./summarize";

const NAME_FIELD_CANDIDATES = ["name", "declarator", "identifier", "field_identifier", "type_identifier", "property_identifier"];

function basename(filePath: string): string {
    return path.basename(filePath);
}

function sliceNode(source: string, node: any): string {
    return source.slice(node.startIndex, node.endIndex);
}

function firstNamedChildByTypes(node: any, types: string[]): any | null {
    if (!node || !node.namedChildren) return null;

    for (const child of node.namedChildren) {
        if (types.includes(child.type)) return child;
    }

    for (const child of node.namedChildren) {
        const found = firstNamedChildByTypes(child, types);
        if (found) return found;
    }

    return null;
}

function findNameText(node: any, source: string): string {
    for (const field of NAME_FIELD_CANDIDATES) {
        try {
            const n = node.childForFieldName?.(field);
            if (n) return normalizeWhitespace(sliceNode(source, n));
        } catch {
            // Ignore child lookup errors.
        }
    }

    const maybeNameNode = firstNamedChildByTypes(node, [
        "identifier",
        "type_identifier",
        "field_identifier",
        "property_identifier"
    ]);

    if (maybeNameNode) {
        return normalizeWhitespace(sliceNode(source, maybeNameNode));
    }

    return "anonymous";
}

function countPatterns(root: any, predicate: (type: string) => boolean): number {
    let count = 0;

    function walk(node: any): void {
        if (predicate(node.type)) count += 1;
        if (node.namedChildren) {
            for (const child of node.namedChildren) walk(child);
        }
    }

    walk(root);
    return count;
}

function collectIdentifiers(root: any, source: string): Set<string> {
    const ids = new Set<string>();

    function walk(node: any): void {
        if (
            node.type === "identifier" ||
            node.type === "field_identifier" ||
            node.type === "property_identifier" ||
            node.type === "type_identifier"
        ) {
            const text = normalizeWhitespace(sliceNode(source, node));
            if (text && text.length > 1) ids.add(text);
        }
        if (node.namedChildren) {
            for (const child of node.namedChildren) walk(child);
        }
    }

    walk(root);
    return ids;
}

function inferComplexityHint(root: any, source: string, functionName: string): string {
    const loopCount = countPatterns(
        root,
        (t) => t.includes("for_") || t === "for_statement" || t === "while_statement" || t === "do_statement"
    );
    const branchCount = countPatterns(
        root,
        (t) => t === "if_statement" || t === "switch_statement" || t === "conditional_expression"
    );
    const identifiers = collectIdentifiers(root, source);
    const isRecursive = identifiers.has(functionName);

    if (loopCount >= 2) return `likely O(n^${Math.min(loopCount, 3)}) due to nested loops`;
    if (loopCount === 1 && branchCount > 0) return "likely O(n) with branching";
    if (loopCount === 1) return "likely O(n)";
    if (isRecursive) return "recursive, inspect stack growth and termination";
    if (branchCount > 0) return "branch-heavy, data-dependent cost";
    return "structural helper, cost likely linear in its input size";
}

function collectDependencies(root: any, source: string): string[] {
    const deps = new Set<string>();

    function walk(node: any): void {
        if (node.type === "call_expression") {
            const callee = node.childForFieldName?.("function") ?? node.childForFieldName?.("name");
            if (callee) {
                const text = normalizeWhitespace(sliceNode(source, callee));
                if (text && text.length > 1) deps.add(text);
            }
        }

        if (node.type === "import_statement" || node.type === "import_declaration" || node.type === "using_declaration") {
            const text = normalizeWhitespace(sliceNode(source, node));
            if (text) deps.add(text);
        }

        if (node.namedChildren) {
            for (const child of node.namedChildren) walk(child);
        }
    }

    walk(root);
    return [...deps].slice(0, 16);
}

function buildEntity(params: {
    kind: NonNullable<ReturnType<typeof classifyNodeType>>;
    language: string;
    filePath: string;
    node: any;
    source: string;
    projectId: string;
}): CodeEntity {
    const name = findNameText(params.node, params.source);
    const sourceSlice = sliceNode(params.source, params.node);
    const signature = normalizeWhitespace(sourceSlice.split("{")[0].split("=>")[0]).slice(0, 220);
    const complexityHint = inferComplexityHint(params.node, params.source, name);
    const dependencies = collectDependencies(params.node, params.source);

    const stableId = sha256(
        `${params.filePath}:${params.node.startIndex}:${params.node.endIndex}:${normalizeWhitespace(sourceSlice)}`
    ).slice(0, 24);

    return {
        id: stableId,
        projectId: params.projectId,
        filePath: params.filePath,
        kind: params.kind,
        language: params.language,
        name,
        signature,
        summary: summarizeEntity({
            kind: params.kind,
            name,
            signature,
            complexityHint,
            dependencies,
            preview: sourceSlice
        }),
        complexityHint,
        dependencies,
        startLine: params.node.startPosition.row + 1,
        endLine: params.node.endPosition.row + 1,
        startIndex: params.node.startIndex,
        endIndex: params.node.endIndex,
        sourceHash: sha256(normalizeWhitespace(sourceSlice)),
        rawSlice: sourceSlice,
        tokensApprox: Math.ceil(sourceSlice.length / 4),
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
}

function visit(node: any, source: string, language: string, filePath: string, projectId: string, entities: CodeEntity[]): void {
    const kind = classifyNodeType(node.type);

    if (kind && node.type !== "program" && node.type !== "translation_unit") {
        entities.push(
            buildEntity({
                kind,
                language,
                filePath,
                node,
                source,
                projectId
            })
        );
    }

    if (node.namedChildren) {
        for (const child of node.namedChildren) {
            visit(child, source, language, filePath, projectId, entities);
        }
    }
}

function dedupeEntities(entities: CodeEntity[]): CodeEntity[] {
    const seen = new Set<string>();
    const out: CodeEntity[] = [];

    for (const entity of entities) {
        const key = `${entity.kind}:${entity.startIndex ?? 0}:${entity.endIndex ?? 0}:${entity.sourceHash}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(entity);
    }

    return out;
}

function extractPythonFallback(filePath: string, source: string, projectId: string): CodeEntity[] {
    const entities: CodeEntity[] = [];
    const lines = source.split(/\r?\n/);

    lines.forEach((line, index) => {
        const fn = line.match(/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((.*?)\)\s*:/);
        if (fn) {
            const signature = `def ${fn[1]}(${fn[2]})`;
            entities.push({
                id: sha256(`${filePath}:py:def:${index}:${signature}`).slice(0, 24),
                projectId,
                filePath,
                kind: "function",
                language: "python",
                name: fn[1],
                signature,
                summary: summarizeEntity({
                    kind: "function",
                    name: fn[1],
                    signature,
                    complexityHint: "inspect implementation for complexity",
                    dependencies: [],
                    preview: line
                }),
                complexityHint: "inspect implementation for complexity",
                dependencies: [],
                startLine: index + 1,
                endLine: index + 1,
                startIndex: 0,
                endIndex: line.length,
                sourceHash: sha256(line),
                rawSlice: line,
                tokensApprox: Math.ceil(line.length / 4),
                createdAt: Date.now(),
                updatedAt: Date.now()
            });
        }
    });

    if (entities.length === 0 && source.trim()) {
        entities.push({
            id: randomId("ent"),
            projectId,
            filePath,
            kind: "module",
            language: "python",
            name: basename(filePath),
            signature: "module",
            summary: summarizeEntity({
                kind: "module",
                name: basename(filePath),
                signature: "module",
                complexityHint: "n/a",
                dependencies: [],
                preview: source.slice(0, 240)
            }),
            complexityHint: "n/a",
            dependencies: [],
            startLine: 1,
            endLine: Math.max(1, lines.length),
            sourceHash: sha256(source),
            tokensApprox: Math.ceil(source.length / 4),
            createdAt: Date.now(),
            updatedAt: Date.now()
        });
    }

    return entities;
}

export function extractEntitiesFromFile(filePath: string, projectId = "default"): ExtractedFile {
    const language = detectLanguage(filePath) ?? "unknown";
    if (!fs.existsSync(filePath)) {
        return { filePath, language, entities: [] };
    }

    const source = fs.readFileSync(filePath, "utf8");
    if (!source.trim()) {
        return { filePath, language, entities: [] };
    }

    if (language === "python") {
        return {
            filePath,
            language,
            entities: extractPythonFallback(filePath, source, projectId)
        };
    }

    try {
        const { parser } = createParserForFile(filePath);
        const tree = parser.parse(source);

        const entities: CodeEntity[] = [];
        visit(tree.rootNode, source, language, filePath, projectId, entities);

        return {
            filePath,
            language,
            entities: dedupeEntities(entities)
        };
    } catch {
        const moduleEntity: CodeEntity = {
            id: randomId("ent"),
            projectId,
            filePath,
            kind: "module",
            language,
            name: basename(filePath),
            signature: "module",
            summary: summarizeEntity({
                kind: "module",
                name: basename(filePath),
                signature: "module",
                complexityHint: "parser-unavailable fallback",
                dependencies: [],
                preview: source.slice(0, 240)
            }),
            complexityHint: "parser-unavailable fallback",
            dependencies: [],
            startLine: 1,
            endLine: Math.max(1, source.split(/\r?\n/).length),
            sourceHash: sha256(source),
            tokensApprox: Math.ceil(source.length / 4),
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        return { filePath, language, entities: [moduleEntity] };
    }
}
