export type MemoryKind =
    | "episodic"
    | "semantic"
    | "procedural"
    | "code_entity"
    | "chat_turn"
    | "refactor_plan";

export interface MemoryAtom {
    id: string;
    projectId: string;
    kind: MemoryKind;
    sourceType: "code" | "chat" | "manual" | "system";
    title: string;
    summary: string;
    content: string;
    tags: string[];
    importance: number;
    confidence: number;
    createdAt: number;
    lastAccessedAt: number;
    sourceRef?: string;
    embeddingRef?: string;
}

export interface CodeEntity {
    id: string;
    projectId: string;
    filePath: string;
    kind: "function" | "class" | "interface" | "struct" | "method" | "module" | "loop" | "branch";
    language: string;
    name: string;
    signature: string;
    summary: string;
    complexityHint: string;
    startLine: number;
    endLine: number;
    startIndex?: number;
    endIndex?: number;
    sourceHash: string;
    dependencies: string[];
    rawSlice?: string;
    tokensApprox?: number;
    createdAt?: number;
    updatedAt?: number;
}

export interface ExtractedFile {
    filePath: string;
    language: string;
    entities: CodeEntity[];
}
