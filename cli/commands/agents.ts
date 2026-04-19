import {
    isCortexaAgentId,
    listCortexaAgents,
    runCortexaAgent
} from "../../core/agents/orchestrator.service";
import {
    clampInteger,
    hasFlag,
    parseCliArgs,
    readNumberOption,
    readStringOption
} from "../utils/args";
import { logger } from "../utils/logger";

function printUsage(): void {
    logger.warn("Usage: cortexa agents list [--json] | cortexa agents run <agent> <text> [--project-id=<id>] [--branch=<name>] [--context=<text>] [--dry-run] [--apply] [--top-k=<n>] [--max-chars=<n>] [--json]");
}

export async function agentsCommand(cliArgs: string[] = []): Promise<void> {
    const parsed = parseCliArgs(cliArgs);
    const action = (parsed.positionals[0] ?? "list").toLowerCase();
    const jsonMode = hasFlag(parsed, ["json"]) || readStringOption(parsed, ["format"]) === "json";

    if (action === "list") {
        const agents = listCortexaAgents();

        if (jsonMode) {
            logger.info(JSON.stringify({ agents, count: agents.length }, null, 2));
            return;
        }

        logger.info(`CORTEXA agents (${agents.length})`);
        for (const agent of agents) {
            logger.info(`- ${agent.id} [${agent.family}] mutation=${agent.mutation} :: ${agent.description}`);
        }
        return;
    }

    if (action === "run") {
        const agentRaw = (parsed.positionals[1] ?? "").trim();
        const textFromPositionals = parsed.positionals.slice(2).join(" ").trim();
        const text = textFromPositionals || readStringOption(parsed, ["text"]);

        if (!agentRaw || !isCortexaAgentId(agentRaw)) {
            logger.warn(`Unknown agent: ${agentRaw || "(empty)"}`);
            logger.info(`Available: ${listCortexaAgents().map((agent) => agent.id).join(", ")}`);
            return;
        }

        if (!text) {
            logger.warn("Missing text. Usage: cortexa agents run <agent> <text> [options]");
            return;
        }

        const projectId = readStringOption(parsed, ["project-id", "projectId"]);
        const branch = readStringOption(parsed, ["branch"]);
        const context = readStringOption(parsed, ["context"]);
        const apply = hasFlag(parsed, ["apply"]);
        const dryRun = hasFlag(parsed, ["dry-run", "dryRun"]) || !apply;
        const topK = clampInteger(readNumberOption(parsed, ["top-k", "topK"]), 6, 1, 40);
        const maxChars = clampInteger(readNumberOption(parsed, ["max-chars", "maxChars"]), 320, 64, 32_000);

        const result = await runCortexaAgent({
            agent: agentRaw,
            text,
            projectId,
            branch,
            context,
            dryRun,
            topK,
            maxChars
        });

        if (jsonMode) {
            logger.info(JSON.stringify(result, null, 2));
            return;
        }

        logger.info(
            `Agent run complete agent=${result.agent} project=${result.projectId} branch=${result.branch} dryRun=${result.dryRun}`
        );
        logger.info(JSON.stringify(result.output, null, 2));
        return;
    }

    printUsage();
}
