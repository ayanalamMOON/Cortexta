import { evolveMemoryWithProgression } from "../../core/mempalace/evolution.service";
import { hasFlag, parseCliArgs, readStringOption } from "../utils/args";
import { logger } from "../utils/logger";

function formatOptionalNumber(value: number | undefined): string {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "n/a";
    }

    return value.toFixed(4);
}

export async function evolveCommand(cliArgs: string[] = []): Promise<void> {
    const parsed = parseCliArgs(cliArgs);
    const text = parsed.positionals.join(" ").trim();

    if (!text) {
        logger.warn(
            "Missing text. Usage: cortexa evolve <text> [--project-id=<id>] [--context=<text>] [--dry-run] [--json]"
        );
        return;
    }

    const projectId = readStringOption(parsed, ["project-id", "projectId"]) ?? "default";
    const context = readStringOption(parsed, ["context"]);
    const dryRun = hasFlag(parsed, ["dry-run", "dryRun"]);
    const jsonMode = hasFlag(parsed, ["json"]) || readStringOption(parsed, ["format"]) === "json";

    const progression = await evolveMemoryWithProgression({
        projectId,
        text,
        context,
        dryRun
    });

    if (jsonMode) {
        logger.info(
            JSON.stringify(
                {
                    mode: "progression",
                    projectId: progression.projectId,
                    dryRun: progression.dryRun,
                    stored: progression.result.stored,
                    persisted: progression.persisted,
                    action: progression.result.action,
                    reason: progression.result.reason,
                    atomId: progression.result.atomId,
                    progression: progression.result.progression
                },
                null,
                2
            )
        );
        return;
    }

    logger.info(
        `Evolution progression project=${progression.projectId} dryRun=${progression.dryRun} stored=${progression.result.stored} persisted=${progression.persisted} action=${progression.result.action} reason=${progression.result.reason}`
    );

    const telemetry = progression.result.progression;
    logger.info(
        `Telemetry proposed=${telemetry.proposedCandidates} reviewed=${telemetry.reviewedCandidates} selectedCandidate=${telemetry.selectedCandidateIndex ?? "n/a"} selectedScore=${formatOptionalNumber(telemetry.selectedScore)} neighbors=${telemetry.neighborCount}`
    );
    logger.info(`Telemetry merged=${telemetry.merged} promoted=${telemetry.promoted} archived=${telemetry.archived}`);

    if (progression.result.atomId) {
        logger.info(`Atom id: ${progression.result.atomId}`);
    }

    if (telemetry.stages.length > 0) {
        logger.info("Stage trace:");
        for (const stage of telemetry.stages) {
            logger.info(`  - ${stage.stage} ok=${stage.ok} detail=${stage.detail}`);
        }
    }
}
