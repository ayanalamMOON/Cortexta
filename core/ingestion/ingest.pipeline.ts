import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { upsertMemory } from "../mempalace/memory.service";
import { parseCode } from "./code.parser";
import { parseCopilotSession } from "./copilot.parser";

export interface IngestInput {
    projectPath: string;
    projectId?: string;
    includeChats?: boolean;
    maxChunkChars?: number;
    maxFiles?: number;
    maxChatFiles?: number;
    chatSearchRoots?: string[];
}

export interface IngestionResult {
    filesScanned: number;
    codeChunks: number;
    chatTurns: number;
    memoriesStored: number;
    errors: string[];
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "out"]);
const CODE_EXTENSIONS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".cpp",
    ".cc",
    ".cxx",
    ".h",
    ".hpp",
    ".java",
    ".go",
    ".rs"
]);

const DEFAULT_MAX_CHUNK_CHARS = 1400;
const DEFAULT_MAX_FILE_BYTES = 768 * 1024;
const DEFAULT_MAX_CHAT_FILES = 400;

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

function normalizeSlashes(value: string): string {
    return value.replace(/\\/g, "/");
}

function toPositiveInteger(value: unknown): number | undefined {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return undefined;
    }
    return Math.floor(parsed);
}

function toNonNegativeInteger(value: unknown): number | undefined {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return undefined;
    }
    return Math.floor(parsed);
}

function stableId(prefix: string, parts: Array<string | number | undefined>): string {
    const hash = crypto
        .createHash("sha1")
        .update(parts.map((part) => String(part ?? "")).join("|"))
        .digest("hex")
        .slice(0, 24);

    return `${prefix}_${hash}`;
}

function splitByMaxChars(content: string, maxChars: number): string[] {
    if (content.length <= maxChars) {
        return [content];
    }

    const slices: string[] = [];
    for (let index = 0; index < content.length; index += maxChars) {
        slices.push(content.slice(index, index + maxChars));
    }
    return slices;
}

function toSourceRef(projectPath: string, targetPath: string): string {
    const absoluteProject = path.resolve(projectPath);
    const absoluteTarget = path.resolve(targetPath);
    const relative = path.relative(absoluteProject, absoluteTarget);

    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        return normalizeSlashes(relative);
    }

    return normalizeSlashes(absoluteTarget);
}

function shouldIncludeCodeFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return CODE_EXTENSIONS.has(ext);
}

function walkFiles(rootPath: string, maxFiles = Number.POSITIVE_INFINITY): string[] {
    const found: string[] = [];

    const stack: string[] = [rootPath];

    while (stack.length > 0 && found.length < maxFiles) {
        const current = stack.pop();
        if (!current) {
            break;
        }

        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (found.length >= maxFiles) {
                break;
            }

            if (entry.isSymbolicLink()) {
                continue;
            }

            const full = path.join(current, entry.name);

            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) {
                    continue;
                }
                stack.push(full);
                continue;
            }

            if (entry.isFile() && shouldIncludeCodeFile(full)) {
                found.push(full);
            }
        }
    }

    return found.sort((a, b) => a.localeCompare(b));
}

function collectChatFilesInDirectory(baseDir: string, output: Set<string>, maxFiles: number): void {
    if (!fs.existsSync(baseDir) || output.size >= maxFiles) {
        return;
    }

    let files: string[] = [];
    try {
        files = fs.readdirSync(baseDir);
    } catch {
        return;
    }

    for (const file of files) {
        if (output.size >= maxFiles) {
            return;
        }

        const ext = path.extname(file).toLowerCase();
        if (ext !== ".json" && ext !== ".jsonl") {
            continue;
        }

        output.add(path.join(baseDir, file));
    }
}

function collectFromWorkspaceStorageRoot(storageRoot: string, output: Set<string>, maxFiles: number): void {
    if (!fs.existsSync(storageRoot) || output.size >= maxFiles) {
        return;
    }

    let folders: fs.Dirent[] = [];
    try {
        folders = fs.readdirSync(storageRoot, { withFileTypes: true });
    } catch {
        return;
    }

    for (const folder of folders) {
        if (!folder.isDirectory() || output.size >= maxFiles) {
            continue;
        }

        const workspaceDir = path.join(storageRoot, folder.name);
        collectChatFilesInDirectory(path.join(workspaceDir, "chatSessions"), output, maxFiles);
        collectChatFilesInDirectory(path.join(workspaceDir, "GitHub.copilot-chat", "transcripts"), output, maxFiles);
        collectChatFilesInDirectory(path.join(workspaceDir, "ms-vscode.copilot-chat", "transcripts"), output, maxFiles);
    }
}

function discoverChatSessionFiles(
    projectPath: string,
    chatSearchRoots: string[] = [],
    maxChatFiles = DEFAULT_MAX_CHAT_FILES
): string[] {
    const discovered = new Set<string>();
    const roots = new Set<string>();

    roots.add(path.join(projectPath, ".vscode", "workspaceStorage"));

    for (const root of chatSearchRoots) {
        if (!root.trim()) {
            continue;
        }

        const absolute = path.isAbsolute(root) ? root : path.resolve(projectPath, root);
        roots.add(absolute);
    }

    const appData = readEnv("APPDATA");
    if (appData) {
        roots.add(path.join(appData, "Code", "User", "workspaceStorage"));
        roots.add(path.join(appData, "Code - Insiders", "User", "workspaceStorage"));
    }

    const home = readEnv("HOME") ?? readEnv("USERPROFILE");
    if (home) {
        roots.add(path.join(home, ".config", "Code", "User", "workspaceStorage"));
        roots.add(path.join(home, ".config", "Code - Insiders", "User", "workspaceStorage"));
    }

    for (const root of roots) {
        if (discovered.size >= maxChatFiles) {
            break;
        }

        collectFromWorkspaceStorageRoot(root, discovered, maxChatFiles);
    }

    return [...discovered].sort((a, b) => a.localeCompare(b));
}

function readChatSessionFile(chatFile: string): unknown {
    const raw = fs.readFileSync(chatFile, "utf8");

    if (path.extname(chatFile).toLowerCase() === ".jsonl") {
        const events: unknown[] = [];
        const lines = raw.split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }

            try {
                events.push(JSON.parse(trimmed) as unknown);
            } catch {
                // Ignore malformed jsonl lines and continue parsing remaining events.
            }
        }

        return events;
    }

    return JSON.parse(raw) as unknown;
}

export async function runIngestion(input: IngestInput): Promise<IngestionResult> {
    const projectPath = path.resolve(input.projectPath);
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
        throw new Error(`Project path does not exist or is not a directory: ${projectPath}`);
    }

    const projectId = input.projectId ?? (path.basename(projectPath) || "default");
    const maxChunkChars = toPositiveInteger(input.maxChunkChars) ?? DEFAULT_MAX_CHUNK_CHARS;
    const maxFiles = toNonNegativeInteger(input.maxFiles) ?? Number.POSITIVE_INFINITY;
    const maxFileBytes = toPositiveInteger(readEnv("CORTEXA_INGEST_MAX_FILE_BYTES")) ?? DEFAULT_MAX_FILE_BYTES;
    const maxChatFiles = toPositiveInteger(input.maxChatFiles) ?? DEFAULT_MAX_CHAT_FILES;

    const result: IngestionResult = {
        filesScanned: 0,
        codeChunks: 0,
        chatTurns: 0,
        memoriesStored: 0,
        errors: []
    };

    const files = walkFiles(projectPath, maxFiles);

    for (const filePath of files) {
        result.filesScanned += 1;

        try {
            const stat = fs.statSync(filePath);
            if (stat.size > maxFileBytes) {
                continue;
            }

            const source = fs.readFileSync(filePath, "utf8");
            const parsed = parseCode(filePath, source);
            const sourceRef = toSourceRef(projectPath, filePath);

            for (let chunkIndex = 0; chunkIndex < parsed.chunks.length; chunkIndex += 1) {
                const chunk = parsed.chunks[chunkIndex];
                const segmentParts = splitByMaxChars(chunk.content, maxChunkChars);

                for (let segmentIndex = 0; segmentIndex < segmentParts.length; segmentIndex += 1) {
                    const segment = segmentParts[segmentIndex];
                    const segmentedTitle =
                        segmentParts.length > 1
                            ? `${chunk.title} [${segmentIndex + 1}/${segmentParts.length}]`
                            : chunk.title;

                    const segmentedSummary =
                        segmentParts.length > 1
                            ? `${chunk.summary}; segment=${segmentIndex + 1}/${segmentParts.length}`
                            : chunk.summary;

                    result.codeChunks += 1;

                    await upsertMemory({
                        id: stableId("code", [
                            projectId,
                            sourceRef,
                            chunkIndex,
                            segmentIndex,
                            segmentedTitle,
                            segment
                        ]),
                        projectId,
                        kind: "code_entity",
                        sourceType: "code",
                        title: segmentedTitle,
                        summary: segmentedSummary,
                        content: segment,
                        tags: [...new Set([...chunk.tags, parsed.language, `file:${sourceRef}`])],
                        importance: parsed.facts.functions.length > 0 ? 0.72 : 0.58,
                        confidence: 0.7,
                        sourceRef
                    });

                    result.memoriesStored += 1;
                }
            }
        } catch (error) {
            result.errors.push(`code:${filePath}:${error instanceof Error ? error.message : String(error)}`);
        }
    }

    if (input.includeChats) {
        const chatFiles = discoverChatSessionFiles(projectPath, input.chatSearchRoots ?? [], maxChatFiles);
        for (const chatFile of chatFiles) {
            try {
                const raw = readChatSessionFile(chatFile);
                const turns = parseCopilotSession(raw);
                const sourceRef = toSourceRef(projectPath, chatFile);

                for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
                    const turn = turns[turnIndex];
                    const prompt = turn.prompt.trim();
                    const response = turn.response.trim();

                    if (!prompt && !response) {
                        continue;
                    }

                    const summarySource = prompt || response;
                    const summary =
                        summarySource.length <= 240 ? summarySource : `${summarySource.slice(0, 239)}…`;

                    result.chatTurns += 1;

                    const fileTags = (turn.files ?? []).slice(0, 25).map((file) => `file:${normalizeSlashes(String(file))}`);

                    await upsertMemory({
                        id: stableId("chat", [projectId, sourceRef, turnIndex, turn.timestamp, prompt, response]),
                        projectId,
                        kind: "chat_turn",
                        sourceType: "chat",
                        title: "Copilot Interaction",
                        summary,
                        content: `${prompt}\n\n---\n\n${response}`.trim(),
                        tags: [...new Set(["copilot", "chat", `chat-file:${sourceRef}`, ...fileTags])],
                        importance: 0.65,
                        confidence: 0.75,
                        sourceRef
                    });

                    result.memoriesStored += 1;
                }
            } catch (error) {
                result.errors.push(`chat:${chatFile}:${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    return result;
}
