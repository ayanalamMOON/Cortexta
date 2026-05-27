import path from "node:path";
import { runIngestion } from "../../core/ingestion/ingest.pipeline";
import { buildIngestPolicyRuntime, resolveIngestPolicy } from "../../core/ingestion/ingest.policy";
import {
    clampInteger,
    hasFlag,
    parseCliArgs,
    readBooleanOption,
    readNumberOption,
    readStringOption
} from "../utils/args";
import { logger } from "../utils/logger";

function normalizeOptionalInt(value: number | undefined, min: number, max: number): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return undefined;
    }

    return clampInteger(value, min, min, max);
}

function normalizeProjectIdOption(value: string | undefined): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const normalized = value.trim();
    if (!normalized) {
        return undefined;
    }

    if (normalized.toLowerCase() === "auto") {
        return undefined;
    }

    return normalized;
}

function inferProjectIdFromPath(projectPath: string): string {
    const basename = path.basename(path.resolve(projectPath)).trim();
    return basename || "default";
}

export async function ingestCommand(projectPath: string, cliArgs: string[] = []): Promise<void> {
    const parsed = parseCliArgs(cliArgs);
    const projectId = normalizeProjectIdOption(readStringOption(parsed, ["project-id", "projectId"]));
    const branch = readStringOption(parsed, ["branch"]);
    const chatRoot = readStringOption(parsed, ["chat-root", "chatRoot"]);
    const policyPath = readStringOption(parsed, ["policy", "policyPath"]);
    const policyCheck = hasFlag(parsed, ["policy-check", "policyCheck"]);
    const jsonMode = hasFlag(parsed, ["json"]) || readStringOption(parsed, ["format"]) === "json";
    const maxFiles = normalizeOptionalInt(readNumberOption(parsed, ["max-files", "maxFiles"]), 0, 200_000);
    const maxChatFiles = normalizeOptionalInt(
        readNumberOption(parsed, ["max-chat-files", "maxChatFiles"]),
        1,
        50_000
    );
    const skipUnchanged = hasFlag(parsed, ["no-skip-unchanged", "noSkipUnchanged"])
        ? false
        : readBooleanOption(parsed, ["skip-unchanged", "skipUnchanged"], true);

    const includeChats = hasFlag(parsed, ["no-include-chats", "noIncludeChats"])
        ? false
        : true;

    const policyResolution = resolveIngestPolicy({
        projectPath,
        policyPath
    });

    if (policyResolution.errors.length > 0) {
        const payload = {
            ok: false,
            policyPath: policyResolution.policyPath,
            errors: policyResolution.errors,
            warnings: policyResolution.warnings
        };

        if (jsonMode) {
            logger.info(JSON.stringify(payload, null, 2));
        } else {
            logger.error("Ingestion policy validation failed:");
            for (const error of policyResolution.errors) {
                logger.error(`- ${error}`);
            }
        }

        return;
    }

    if (policyCheck) {
        const runtime = buildIngestPolicyRuntime({ projectPath, resolution: policyResolution });
        const payload = {
            ok: true,
            policyPath: runtime.policyPath,
            warnings: runtime.warnings,
            policy: runtime.policy ?? null,
            effective: {
                maxFileBytes: runtime.maxFileBytes,
                allowedExtensions: runtime.allowedExtensions ? [...runtime.allowedExtensions] : undefined,
                includeGlobs: runtime.policy?.includeGlobs ?? [],
                excludeGlobs: runtime.policy?.excludeGlobs ?? [],
                chat: {
                    enabled: runtime.chatEnabled,
                    roots: runtime.chatRoots,
                    maxFiles: runtime.maxChatFiles
                },
                redaction: runtime.policy?.redaction ?? null
            }
        };

        if (jsonMode) {
            logger.info(JSON.stringify(payload, null, 2));
        } else {
            logger.info("Ingestion policy check passed.");
            if (runtime.policyPath) {
                logger.info(`Policy file: ${runtime.policyPath}`);
            } else {
                logger.info("Policy file: none");
            }

            if (runtime.warnings.length > 0) {
                logger.warn("Policy warnings:");
                for (const warning of runtime.warnings) {
                    logger.warn(`- ${warning}`);
                }
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

    const inferredProjectId = projectId ?? inferProjectIdFromPath(projectPath);
    const startedAt = Date.now();

    logger.info("Ingestion started", {
        projectPath,
        policyPath: policyResolution.policyPath ?? "none",
        projectId: inferredProjectId,
        projectIdSource: projectId ? "explicit" : "auto",
        branch: branch ?? "main",
        includeChats,
        skipUnchanged,
        maxFiles: maxFiles ?? "all",
        maxChatFiles: maxChatFiles ?? "default",
        storageCompaction: "inline"
    });

    const result = await runIngestion({
        projectPath,
        projectId,
        branch,
        includeChats,
        skipUnchanged,
        maxFiles,
        maxChatFiles,
        chatSearchRoots: chatRoot ? [chatRoot] : undefined,
        policyPath: policyResolution.policyPath,
        policy: policyResolution.policy
    });

    logger.info("Ingestion finished", {
        projectPath,
        projectId: inferredProjectId,
        projectIdSource: projectId ? "explicit" : "auto",
        branch: branch ?? "main",
        includeChats,
        skipUnchanged,
        filesScanned: result.filesScanned,
        codeFilesSkippedUnchanged: result.codeFilesSkippedUnchanged,
        chatFilesScanned: result.chatFilesScanned,
        chatFilesSkippedUnchanged: result.chatFilesSkippedUnchanged,
        codeChunks: result.codeChunks,
        chatTurns: result.chatTurns,
        memoriesStored: result.memoriesStored,
        staleMemoriesRemoved: result.staleMemoriesRemoved,
        staleCodeMemoriesRemoved: result.staleCodeMemoriesRemoved,
        staleChatMemoriesRemoved: result.staleChatMemoriesRemoved,
        ingestVersion: result.ingestVersion,
        elapsedMs: Date.now() - startedAt,
        errors: result.errors.length
    });

    if (result.errors.length > 0) {
        logger.warn("Ingestion errors (first 5):", result.errors.slice(0, 5));
    }
}
