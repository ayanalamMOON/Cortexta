import { backfillMemoryCompaction, getMemoryCompactionStats } from "../core/mempalace/memory.service";

interface CliOptions {
    projectId?: string;
    limit?: number;
    apply: boolean;
}

function parseArgs(argv: string[]): CliOptions {
    const options: CliOptions = {
        apply: false
    };

    for (const arg of argv) {
        if (arg === "--apply") {
            options.apply = true;
            continue;
        }

        if (arg.startsWith("--projectId=")) {
            const value = arg.slice("--projectId=".length).trim();
            if (value) {
                options.projectId = value;
            }
            continue;
        }

        if (arg.startsWith("--limit=")) {
            const parsed = Number(arg.slice("--limit=".length));
            if (Number.isFinite(parsed) && parsed > 0) {
                options.limit = Math.trunc(parsed);
            }
        }
    }

    return options;
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));

    const before = getMemoryCompactionStats(options.projectId);
    const result = backfillMemoryCompaction({
        projectId: options.projectId,
        limit: options.limit,
        dryRun: !options.apply
    });
    const after = getMemoryCompactionStats(options.projectId);

    const modeLabel = options.apply ? "apply" : "dry-run";

    console.log(`[cortexa] memory compaction mode=${modeLabel} project=${options.projectId ?? "all"}`);
    console.log(
        `[cortexa] before total=${before.totalRows} compacted=${before.compactedRows} plain=${before.plainRows} saved=${before.savedChars}`
    );
    console.log(
        `[cortexa] result scanned=${result.scanned} eligible=${result.eligible} compacted=${result.compacted} skipped=${result.skipped} saved=${result.savedChars}`
    );
    console.log(
        `[cortexa] after total=${after.totalRows} compacted=${after.compactedRows} plain=${after.plainRows} saved=${after.savedChars}`
    );

    if (!options.apply) {
        console.log("[cortexa] dry-run complete; re-run with --apply to persist compaction updates");
    }
}

main().catch((error) => {
    console.error("[cortexa] compaction script failed");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
