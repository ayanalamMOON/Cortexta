import { safeSnippet } from "../utils/text";

const LOOP_TYPES = new Set(["for_statement", "while_statement", "do_statement", "for_in_statement", "for_of_statement"]);
const BRANCH_TYPES = new Set(["if_statement", "switch_statement", "conditional_expression", "ternary_expression"]);
const FUNC_TYPES = new Set(["function_declaration", "function_definition", "method_definition", "arrow_function"]);
const CLASS_TYPES = new Set(["class_declaration", "struct_specifier"]);
const INTERFACE_TYPES = new Set(["interface_declaration"]);
const MODULE_TYPES = new Set(["program", "translation_unit"]);

export function classifyNodeType(
    nodeType: string
): "function" | "class" | "interface" | "struct" | "method" | "loop" | "branch" | "module" | null {
    if (nodeType === "method_definition") return "method";
    if (LOOP_TYPES.has(nodeType)) return "loop";
    if (BRANCH_TYPES.has(nodeType)) return "branch";
    if (FUNC_TYPES.has(nodeType)) return "function";
    if (INTERFACE_TYPES.has(nodeType)) return "interface";
    if (CLASS_TYPES.has(nodeType)) return nodeType === "struct_specifier" ? "struct" : "class";
    if (MODULE_TYPES.has(nodeType)) return "module";
    return null;
}

export function summarizeEntity(params: {
    kind: string;
    name: string;
    signature: string;
    complexityHint: string;
    dependencies: string[];
    preview: string;
}): string {
    const deps = params.dependencies.length ? params.dependencies.slice(0, 8).join(", ") : "none";

    return [
        `${params.kind.toUpperCase()} ${params.name}`,
        `signature: ${params.signature}`,
        `complexity: ${params.complexityHint}`,
        `dependencies: ${deps}`,
        `preview: ${safeSnippet(params.preview, 180)}`
    ].join("\n");
}
