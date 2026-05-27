import { compileContext } from "../../core/context/compiler";
import { buildProactiveContextSuggestion } from "../../core/context/proactive";
import {
    createCortexaContextStreamClient,
    type ContextStreamSocketMessage
} from "../../packages/core/src/daemon/context-stream-client";
import {
    clampInteger,
    parseCliArgs,
    readBooleanOption,
    readNumberOption,
    readStringOption
} from "../utils/args";
import { logger } from "../utils/logger";

function buildContextStreamClient(parsed: ReturnType<typeof parseCliArgs>): ReturnType<typeof createCortexaContextStreamClient> {
    return createCortexaContextStreamClient({
        daemonBaseUrl: readStringOption(parsed, ["daemon-url", "daemonUrl"]),
        daemonToken: readStringOption(parsed, ["token", "daemon-token", "daemonToken"]),
        requestTimeoutMs: readNumberOption(parsed, ["request-timeout-ms", "requestTimeoutMs"]),
        wsBaseUrl: readStringOption(parsed, ["ws-url", "wsUrl"]),
        wsPort: readNumberOption(parsed, ["ws-port", "wsPort"])
    });
}

function printStreamUsage(): void {
    logger.warn(
        "Usage: cortexa context stream start <rootPath> [--project-id=<id>] [--branch=<name>] [--daemon-url=<url>] [--ws-url=<url>] [--json] | cortexa context stream stop --project-id=<id> [--branch=<name>] | cortexa context stream status [--daemon-url=<url>] [--json] | cortexa context stream ack --project-id=<id> --suggestion-hash=<hash> --action=<ack|applied|suppressed> [--branch=<name>] [--reason=<text>] | cortexa context stream listen [--project-id=<id>] [--branch=<name>] [--daemon-url=<url>] [--ws-url=<url>] [--json]"
    );
}

function summarizeStreamMessage(message: ContextStreamSocketMessage): string {
    const eventType = message.payload?.eventType ?? message.deltaType;
    const parts = [
        `event=${eventType}`,
        `project=${message.projectId ?? "n/a"}`,
        `step=${message.step}`
    ];

    if (typeof message.payload?.suggestionHash === "string") {
        parts.push(`suggestion=${message.payload.suggestionHash}`);
    }

    if (typeof message.payload?.sourcePath === "string") {
        parts.push(`source=${message.payload.sourcePath}`);
    }

    if (typeof message.payload?.reason === "string") {
        parts.push(`reason=${message.payload.reason}`);
    }

    if (typeof message.payload?.confidence === "number") {
        parts.push(`confidence=${message.payload.confidence.toFixed(2)}`);
    }

    return parts.join(" ");
}

async function runContextStreamListen(parsed: ReturnType<typeof parseCliArgs>): Promise<void> {
    const client = buildContextStreamClient(parsed);
    const jsonMode = readBooleanOption(parsed, ["json"], false);
    const projectId = readStringOption(parsed, ["project-id", "projectId"]);
    const branch = readStringOption(parsed, ["branch"]);

    const subscription = client.subscribe({
        filterProjectId: projectId,
        onDelta: (message) => {
            if (jsonMode) {
                logger.info(JSON.stringify(message));
                return;
            }

            if (branch && typeof message.payload?.branch === "string" && message.payload.branch !== branch) {
                return;
            }

            logger.info(summarizeStreamMessage(message));
        },
        onError: (error) => {
            logger.error(error.message);
        },
        onClose: (code, reason) => {
            logger.warn(`Stream closed code=${code} reason=${reason || "n/a"}`);
        }
    });

    await subscription.waitForOpen();

    logger.info(`Listening on ${client.websocketUrl}`);
    if (projectId) {
        logger.info(`Filtering project=${projectId}${branch ? ` branch=${branch}` : ""}`);
    }

    await new Promise<void>((resolve) => {
        let settled = false;

        const settle = () => {
            if (settled) {
                return;
            }

            settled = true;
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
            resolve();
        };

        const shutdown = () => {
            subscription.close();
            settle();
        };

        const onSignal = () => shutdown();

        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);

        const closeWatcher = () => {
            settle();
        };

        subscription.socket.addEventListener("close", closeWatcher);
    });
}

async function runContextStreamCommand(parsed: ReturnType<typeof parseCliArgs>): Promise<void> {
    const action = (parsed.positionals[1] ?? "status").toLowerCase();

    if (action === "listen" || action === "watch") {
        await runContextStreamListen(parsed);
        return;
    }

    const client = buildContextStreamClient(parsed);
    const jsonMode = readBooleanOption(parsed, ["json"], false);

    if (action === "start") {
        const rootPath = readStringOption(parsed, ["root-path", "rootPath"]) ?? parsed.positionals[2] ?? "";

        if (!rootPath) {
            printStreamUsage();
            return;
        }

        const started = await client.start({
            rootPath,
            projectId: readStringOption(parsed, ["project-id", "projectId"]),
            branch: readStringOption(parsed, ["branch"]),
            config: {
                debounceMs: readNumberOption(parsed, ["debounce-ms", "debounceMs"]),
                minConfidence: readNumberOption(parsed, ["min-confidence", "minConfidence"]),
                maxSuggestionsPerMinute: readNumberOption(parsed, ["max-per-minute", "maxSuggestionsPerMinute"]),
                topK: readNumberOption(parsed, ["top-k", "topK"]),
                maxTokens: readNumberOption(parsed, ["max-tokens", "maxTokens"]),
                previewChars: readNumberOption(parsed, ["preview-chars", "previewChars"]),
                suggestionTtlMs: readNumberOption(parsed, ["suggestion-ttl-ms", "suggestionTtlMs"]),
                dedupeWindowMs: readNumberOption(parsed, ["dedupe-window-ms", "dedupeWindowMs"]),
                includeUnknownLanguages: readBooleanOption(parsed, ["include-unknown-languages", "includeUnknownLanguages"], false),
                suppressOnCriticalRisk: readBooleanOption(parsed, ["suppress-on-critical-risk", "suppressOnCriticalRisk"], true)
            }
        });

        if (jsonMode) {
            logger.info(JSON.stringify(started, null, 2));
            return;
        }

        logger.info(
            `Context stream started id=${started.id} project=${started.projectId} branch=${started.branch} activeSuggestions=${started.activeSuggestions}`
        );
        return;
    }

    if (action === "stop") {
        const projectId = readStringOption(parsed, ["project-id", "projectId"]);
        if (!projectId) {
            printStreamUsage();
            return;
        }

        const stopped = await client.stop(projectId, readStringOption(parsed, ["branch"]));
        if (jsonMode) {
            logger.info(JSON.stringify({ stopped }, null, 2));
            return;
        }

        logger.info(stopped ? `Context stream stopped for project=${projectId}` : `No running context stream for project=${projectId}`);
        return;
    }

    if (action === "ack") {
        const projectId = readStringOption(parsed, ["project-id", "projectId"]);
        const suggestionHash = readStringOption(parsed, ["suggestion-hash", "suggestionHash"]);
        const ackAction = readStringOption(parsed, ["action"]) ?? "ack";

        if (!projectId || !suggestionHash || (ackAction !== "ack" && ackAction !== "applied" && ackAction !== "suppressed")) {
            printStreamUsage();
            return;
        }

        const suggestion = await client.ack({
            projectId,
            branch: readStringOption(parsed, ["branch"]),
            suggestionHash,
            action: ackAction,
            reason: readStringOption(parsed, ["reason"])
        });

        if (jsonMode) {
            logger.info(JSON.stringify(suggestion, null, 2));
            return;
        }

        logger.info(`Acknowledged suggestion ${suggestionHash} for project=${projectId}`);
        return;
    }

    const status = await client.status();

    if (jsonMode) {
        logger.info(JSON.stringify(status, null, 2));
        return;
    }

    logger.info(`Context stream enabled=${status.status?.enabled ?? false} running=${status.status?.running ?? false}`);
    for (const stream of status.status?.streams ?? []) {
        logger.info(
            `- project=${String(stream.projectId ?? "n/a")} branch=${String(stream.branch ?? "main")} queued=${String(stream.queuedEvents ?? 0)} active=${String(stream.activeSuggestions ?? 0)} processed=${String(stream.processedEvents ?? 0)}`
        );
    }
}

export async function contextCommand(cliArgs: string[] = []): Promise<void> {
    const parsed = parseCliArgs(cliArgs);
    const command = (parsed.positionals[0] ?? "").toLowerCase();

    if (command === "stream") {
        await runContextStreamCommand(parsed);
        return;
    }

    const query = parsed.positionals.join(" ").trim();

    if (!query) {
        logger.warn("Usage: cortexa context <query> [--project-id=<id>] [--branch=<name>] [--as-of=<unix-ms>] [--top-k=<n>] [--max-tokens=<n>]");
        return;
    }

    const projectId = readStringOption(parsed, ["project-id", "projectId"]);
    const branch = readStringOption(parsed, ["branch"]);
    const topK = clampInteger(readNumberOption(parsed, ["top-k", "topK"]), 12, 1, 100);
    const maxTokens = clampInteger(readNumberOption(parsed, ["max-tokens", "maxTokens"]), 4000, 128, 32768);
    const asOfRaw = readNumberOption(parsed, ["as-of", "asOf"]);
    const asOf =
        typeof asOfRaw === "number" && Number.isFinite(asOfRaw)
            ? Math.max(0, Math.trunc(asOfRaw))
            : undefined;

    const suggestion = buildProactiveContextSuggestion({
        query,
        projectId,
        branch,
        asOf
    });

    const result = await compileContext(query, {
        projectId,
        branch,
        asOf,
        maxTokens,
        topK,
        constraints: suggestion.recommendedConstraints,
        scope: suggestion.recommendedScope
    });

    logger.info(
        `Intent suggestion: ${suggestion.intent.category} confidence=${suggestion.intent.confidence.toFixed(2)} topK=${suggestion.recommendedTopK} maxTokens=${suggestion.recommendedMaxTokens}`
    );
    logger.info(`Context compiled. tokens≈${result.tokenEstimate}, memories=${result.memoriesUsed}, dropped=${result.dropped}`);
    logger.info("\n" + result.context);
}
