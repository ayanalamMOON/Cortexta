import type { CortexaLlmRuntimeStatus } from "../../core/llm/cortexa-llm.service";
import {
    generateMiniLlmText,
    getMiniLlmStatus,
    trainMiniLlm
} from "../../core/llm/mini-llm.service";
import {
    clampInteger,
    hasFlag,
    parseCliArgs,
    readBooleanOption,
    readNumberOption,
    readStringOption
} from "../utils/args";
import { logger } from "../utils/logger";

function printUsage(): void {
    logger.warn(
        "Usage: cortexa llm status [--runtime] [--include-mini] [--daemon-url=<url>] [--daemon-token=<token>] [--request-timeout-ms=<n>] [--json] | cortexa llm train [projectPath] [--project-id=<id>] [--branch=<name>] [--max-files=<n>] [--max-file-bytes=<n>] [--max-corpus-chars=<n>] [--max-vocab=<n>] [--max-transitions=<n>] [--memory-limit=<n>] [--no-memory] [--hf-dataset=<id>] [--hf-split=<name>] [--hf-rows=<n>] [--model-path=<path>] [--json] | cortexa llm preview <text> [--max-tokens=<n>]"
    );
}

function resolveDaemonBaseUrl(parsed: ReturnType<typeof parseCliArgs>): string {
    const explicit = readStringOption(parsed, ["daemon-url", "daemonUrl"]);
    if (explicit) {
        return explicit.endsWith("/") ? explicit.slice(0, -1) : explicit;
    }

    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const envUrl = env?.CORTEXA_DAEMON_URL?.trim();
    if (envUrl) {
        return envUrl.endsWith("/") ? envUrl.slice(0, -1) : envUrl;
    }

    const portCandidate = Number(env?.CORTEXA_DAEMON_PORT ?? 4312);
    const port = Number.isFinite(portCandidate) ? portCandidate : 4312;
    return `http://localhost:${port}`;
}

function resolveDaemonToken(parsed: ReturnType<typeof parseCliArgs>): string | undefined {
    return (
        readStringOption(parsed, ["token", "daemon-token", "daemonToken"]) ??
        (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CORTEXA_DAEMON_TOKEN
    );
}

async function fetchRuntimeStatus(parsed: ReturnType<typeof parseCliArgs>): Promise<CortexaLlmRuntimeStatus | null> {
    const baseUrl = resolveDaemonBaseUrl(parsed);
    const token = resolveDaemonToken(parsed);
    const timeoutMs = clampInteger(readNumberOption(parsed, ["request-timeout-ms", "requestTimeoutMs"]), 4000, 500, 60_000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const headers: Record<string, string> = {
            "content-type": "application/json"
        };

        if (token) {
            headers["x-cortexa-token"] = token;
        }

        const response = await fetch(`${baseUrl}/cxlink/llm/status`, {
            method: "POST",
            headers,
            body: "{}",
            signal: controller.signal
        });

        const payload = (await response.json().catch(() => ({}))) as {
            ok?: boolean;
            error?: string;
            status?: CortexaLlmRuntimeStatus;
        };

        if (!response.ok) {
            logger.warn(
                `LLM runtime status request failed (${response.status}): ${payload.error ?? "unknown_error"}`
            );
            return null;
        }

        if (!payload.status) {
            logger.warn("LLM runtime status response missing status payload.");
            return null;
        }

        return payload.status;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Failed to reach daemon LLM status endpoint: ${message}`);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

export async function llmCommand(cliArgs: string[] = []): Promise<void> {
    const parsed = parseCliArgs(cliArgs);
    const action = (parsed.positionals[0] ?? "status").toLowerCase();
    const jsonMode = hasFlag(parsed, ["json"]) || readStringOption(parsed, ["format"]) === "json";
    const runtimeMode = readBooleanOption(parsed, ["runtime"], false);
    const includeMini = readBooleanOption(parsed, ["include-mini", "includeMini"], false);

    if (action === "status") {
        if (runtimeMode) {
            const status = await fetchRuntimeStatus(parsed);
            if (!status) {
                return;
            }

            if (jsonMode) {
                if (includeMini) {
                    logger.info(JSON.stringify({ runtime: status, mini: getMiniLlmStatus() }, null, 2));
                } else {
                    logger.info(JSON.stringify(status, null, 2));
                }
                return;
            }

            logger.info("LLM runtime status:");
            logger.info(`Mode: ${status.mode}`);
            logger.info(`Strict remote: ${status.strictRemote}`);
            logger.info(`Service URL: ${status.serviceUrl}`);
            logger.info(`Service reachable: ${status.serviceReachable}`);
            logger.info(`Effective timeout: ${status.effectiveTimeoutMs}ms`);
            logger.info(`Effective JSON max tokens: ${status.effectiveJsonMaxTokens}`);

            if (status.modelPathDetected) {
                logger.info(`Model path detected: ${status.modelPathDetected}`);
            }

            if (typeof status.lastSuccessAt === "number") {
                logger.info(`Last success: ${new Date(status.lastSuccessAt).toISOString()}`);
            }

            if (status.lastError) {
                logger.warn(`Last error: ${status.lastError}`);
            }

            if (Array.isArray(status.diagnosticHints) && status.diagnosticHints.length > 0) {
                logger.info("Diagnostic hints:");
                for (const hint of status.diagnosticHints) {
                    logger.info(`- ${hint}`);
                }
            }

            if (includeMini) {
                const miniStatus = getMiniLlmStatus();
                logger.info("Mini LLM status:");
                logger.info(`Mini LLM mode: ${miniStatus.mode}`);
                logger.info(`Enabled: ${miniStatus.enabled}`);
                logger.info(`Model path: ${miniStatus.modelPath}`);
                logger.info(`Model file present: ${miniStatus.modelExists}`);
                logger.info(`Persisted model loaded: ${miniStatus.loaded}`);
                logger.info(`Ephemeral model loaded: ${miniStatus.ephemeralLoaded}`);
            }

            return;
        }

        const status = getMiniLlmStatus();

        if (jsonMode) {
            logger.info(JSON.stringify(status, null, 2));
            return;
        }

        logger.info(`Mini LLM mode: ${status.mode}`);
        logger.info(`Enabled: ${status.enabled}`);
        logger.info(`Model path: ${status.modelPath}`);
        logger.info(`Model file present: ${status.modelExists}`);
        logger.info(`Persisted model loaded: ${status.loaded}`);
        logger.info(`Ephemeral model loaded: ${status.ephemeralLoaded}`);

        if (typeof status.vocabSize === "number") {
            logger.info(`Vocab size: ${status.vocabSize}`);
        }
        if (typeof status.transitionRows === "number") {
            logger.info(`Transition rows: ${status.transitionRows}`);
        }
        if (typeof status.tokenCount === "number") {
            logger.info(`Training tokens: ${status.tokenCount}`);
        }
        if (typeof status.sourceCount === "number") {
            logger.info(`Training sources: ${status.sourceCount}`);
        }

        if (status.enabled && !status.modelExists) {
            logger.warn("No persisted mini LLM model found yet. Run `cortexa llm train` to build one.");
        }

        return;
    }

    if (action === "train") {
        const projectPath = readStringOption(parsed, ["path"]) ?? parsed.positionals[1] ?? process.cwd();
        const projectId = readStringOption(parsed, ["project-id", "projectId"]);
        const branch = readStringOption(parsed, ["branch"]);
        const modelPath = readStringOption(parsed, ["model-path", "modelPath"]);
        const includeMemoryStore = hasFlag(parsed, ["no-memory", "no-memory-store"])
            ? false
            : readBooleanOption(parsed, ["include-memory", "memory-store"], true);

        const maxFiles = clampInteger(readNumberOption(parsed, ["max-files", "maxFiles"]), 800, 20, 20_000);
        const maxFileBytes = clampInteger(
            readNumberOption(parsed, ["max-file-bytes", "maxFileBytes"]),
            300_000,
            8_000,
            2_000_000
        );
        const maxCorpusChars = clampInteger(
            readNumberOption(parsed, ["max-corpus-chars", "maxCorpusChars"]),
            2_000_000,
            20_000,
            20_000_000
        );
        const maxVocab = clampInteger(readNumberOption(parsed, ["max-vocab", "maxVocab"]), 4_096, 128, 32_768);
        const maxTransitionsPerToken = clampInteger(
            readNumberOption(parsed, ["max-transitions", "maxTransitions", "max-transitions-per-token"]),
            24,
            2,
            256
        );
        const memoryLimit = clampInteger(readNumberOption(parsed, ["memory-limit", "memoryLimit"]), 250, 0, 10_000);
        const hfDataset = readStringOption(parsed, ["hf-dataset", "hfDataset"]);
        const hfSplit = readStringOption(parsed, ["hf-split", "hfSplit"]);
        const hfRows = clampInteger(readNumberOption(parsed, ["hf-rows", "hfRows"]), 200, 1, 2_000);

        logger.info(`Training mini local LLM from ${projectPath} ...`);

        const result = await trainMiniLlm({
            projectPath,
            projectId,
            branch,
            modelPath,
            maxFiles,
            maxFileBytes,
            maxCorpusChars,
            maxVocab,
            maxTransitionsPerToken,
            includeMemoryStore,
            memoryLimit,
            hfDataset,
            hfSplit,
            hfRows
        });

        if (jsonMode) {
            logger.info(JSON.stringify(result, null, 2));
            return;
        }

        logger.info(`Mini LLM trained successfully in ${result.durationMs}ms`);
        logger.info(`Model path: ${result.modelPath}`);
        logger.info(`Sources: ${result.sourceCount}`);
        logger.info(`Corpus chars: ${result.corpusChars}`);
        logger.info(`Token count: ${result.tokenCount}`);
        logger.info(`Vocab size: ${result.vocabSize}`);
        logger.info(`Transition rows: ${result.transitionRows}`);
        logger.info(`Average branching factor: ${result.averageBranchingFactor.toFixed(2)}`);

        if (result.warnings.length > 0) {
            logger.warn("Training warnings:");
            for (const warning of result.warnings) {
                logger.warn(`- ${warning}`);
            }
        }

        return;
    }

    if (action === "preview") {
        const textFromPositionals = parsed.positionals.slice(1).join(" ").trim();
        const text = textFromPositionals || readStringOption(parsed, ["text", "seed"]);

        if (!text) {
            logger.warn("Missing text. Usage: cortexa llm preview <text> [--max-tokens=<n>]");
            return;
        }

        const maxTokens = clampInteger(readNumberOption(parsed, ["max-tokens", "maxTokens"]), 72, 8, 256);
        const generated = await generateMiniLlmText(text, {
            maxTokens
        });

        if (jsonMode) {
            logger.info(
                JSON.stringify(
                    {
                        text,
                        maxTokens,
                        generated
                    },
                    null,
                    2
                )
            );
            return;
        }

        logger.info("Mini LLM preview:");
        logger.info(generated);
        return;
    }

    printUsage();
}
