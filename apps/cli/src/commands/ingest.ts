import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { runIngestion } from "../../../../core/ingestion/ingest.pipeline";
import { logger } from "../utils/logger";

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

function resolveProjectPath(inputDir: string): string {
    const invocationCwd = readEnv("INIT_CWD")?.trim();
    const base = invocationCwd && invocationCwd.length > 0 ? invocationCwd : process.cwd();
    return path.resolve(base, inputDir);
}

function parseMaxFiles(value: string): number {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --max-files value: ${value}. Expected a non-negative integer.`);
    }
    return parsed;
}

function parseMaxChatFiles(value: string): number {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --max-chat-files value: ${value}. Expected a positive integer.`);
    }
    return parsed;
}

export const ingestCommand = new Command("ingest")
    .argument("[dir]", "Directory to ingest", ".")
    .description("Ingest source files into Cortexa memory (projectId auto-inferred when omitted)")
    .option("--project-id <projectId>", "Project identifier override")
    .option("--include-chats", "Also ingest Copilot chat sessions", false)
    .option("--max-files <maxFiles>", "Maximum files to process", parseMaxFiles)
    .option("--max-chat-files <maxChatFiles>", "Maximum number of chat session files to parse", parseMaxChatFiles)
    .option("--chat-root <chatRoot>", "Optional workspaceStorage root for chat ingestion discovery")
    .action(async (dir: string | undefined, options: { projectId?: string; includeChats?: boolean; maxFiles?: number; maxChatFiles?: number; chatRoot?: string }) => {
        const inputDir = typeof dir === "string" && dir.trim().length > 0 ? dir : ".";
        const projectPath = resolveProjectPath(inputDir);
        const stats = await fs.promises.stat(projectPath).catch(() => null);
        if (!stats?.isDirectory()) {
            throw new Error(`Ingest path is not a directory: ${projectPath}`);
        }

        const result = await runIngestion({
            projectPath,
            projectId: options.projectId,
            includeChats: Boolean(options.includeChats),
            maxFiles: Number.isFinite(options.maxFiles) ? options.maxFiles : undefined,
            maxChatFiles: Number.isFinite(options.maxChatFiles) ? options.maxChatFiles : undefined,
            chatSearchRoots: options.chatRoot ? [options.chatRoot] : undefined
        });

        logger.info("Ingestion completed", {
            projectPath,
            filesScanned: result.filesScanned,
            codeChunks: result.codeChunks,
            chatTurns: result.chatTurns,
            memoriesStored: result.memoriesStored,
            errors: result.errors.length
        });

        if (result.errors.length > 0) {
            logger.warn("First ingestion errors:", result.errors.slice(0, 10));
        }
    });
