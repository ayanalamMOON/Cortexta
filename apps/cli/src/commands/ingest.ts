import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { runIngestion } from "../../../../core/ingestion/ingest.pipeline";
import { buildIngestPolicyRuntime, resolveIngestPolicy } from "../../../../core/ingestion/ingest.policy";
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
    .option("--policy <policyPath>", "Path to cortexa.policy.json override")
    .option("--policy-check", "Validate policy file and exit", false)
    .action(async (
        dir: string | undefined,
        options: {
            projectId?: string;
            includeChats?: boolean;
            maxFiles?: number;
            maxChatFiles?: number;
            chatRoot?: string;
            policy?: string;
            policyCheck?: boolean;
        }
    ) => {
        const inputDir = typeof dir === "string" && dir.trim().length > 0 ? dir : ".";
        const projectPath = resolveProjectPath(inputDir);
        const stats = await fs.promises.stat(projectPath).catch(() => null);
        if (!stats?.isDirectory()) {
            throw new Error(`Ingest path is not a directory: ${projectPath}`);
        }

        const policyResolution = resolveIngestPolicy({
            projectPath,
            policyPath: options.policy
        });

        if (policyResolution.errors.length > 0) {
            logger.error("Ingestion policy validation failed:");
            for (const error of policyResolution.errors) {
                logger.error(`- ${error}`);
            }
            return;
        }

        if (options.policyCheck) {
            const runtime = buildIngestPolicyRuntime({ projectPath, resolution: policyResolution });
            logger.info("Ingestion policy check passed.");
            logger.info(`Policy file: ${runtime.policyPath ?? "none"}`);

            if (runtime.warnings.length > 0) {
                logger.warn("Policy warnings:");
                for (const warning of runtime.warnings) {
                    logger.warn(`- ${warning}`);
                }
            }

            return;
        }

        if (policyResolution.warnings.length > 0) {
            logger.warn("Ingestion policy warnings:");
            for (const warning of policyResolution.warnings) {
                logger.warn(`- ${warning}`);
            }
        }

        const result = await runIngestion({
            projectPath,
            projectId: options.projectId,
            includeChats: Boolean(options.includeChats),
            maxFiles: Number.isFinite(options.maxFiles) ? options.maxFiles : undefined,
            maxChatFiles: Number.isFinite(options.maxChatFiles) ? options.maxChatFiles : undefined,
            chatSearchRoots: options.chatRoot ? [options.chatRoot] : undefined,
            policyPath: policyResolution.policyPath,
            policy: policyResolution.policy
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
