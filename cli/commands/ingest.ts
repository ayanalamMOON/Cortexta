import { runIngestion } from "../../core/ingestion/ingest.pipeline";
import { clampInteger, hasFlag, parseCliArgs, readNumberOption, readStringOption } from "../utils/args";
import { logger } from "../utils/logger";

function normalizeOptionalInt(value: number | undefined, min: number, max: number): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return undefined;
    }

    return clampInteger(value, min, min, max);
}

export async function ingestCommand(projectPath: string, cliArgs: string[] = []): Promise<void> {
    const parsed = parseCliArgs(cliArgs);
    const projectId = readStringOption(parsed, ["project-id", "projectId"]);
    const chatRoot = readStringOption(parsed, ["chat-root", "chatRoot"]);
    const maxFiles = normalizeOptionalInt(readNumberOption(parsed, ["max-files", "maxFiles"]), 0, 200_000);
    const maxChatFiles = normalizeOptionalInt(
        readNumberOption(parsed, ["max-chat-files", "maxChatFiles"]),
        1,
        50_000
    );

    const includeChats = hasFlag(parsed, ["no-include-chats", "noIncludeChats"])
        ? false
        : true;

    const result = await runIngestion({
        projectPath,
        projectId,
        includeChats,
        maxFiles,
        maxChatFiles,
        chatSearchRoots: chatRoot ? [chatRoot] : undefined
    });

    logger.info("Ingestion finished", {
        projectPath,
        projectId: projectId ?? "auto",
        includeChats,
        filesScanned: result.filesScanned,
        codeChunks: result.codeChunks,
        chatTurns: result.chatTurns,
        memoriesStored: result.memoriesStored,
        errors: result.errors.length
    });

    if (result.errors.length > 0) {
        logger.warn("Ingestion errors (first 5):", result.errors.slice(0, 5));
    }
}
