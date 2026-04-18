import { contextCommand } from "./commands/context";
import { ingestCommand } from "./commands/ingest";
import { initCommand } from "./commands/init";
import { memoryCommand } from "./commands/memory";
import { queryCommand } from "./commands/query";
import { renderCliHome } from "./utils/home";
import { logger } from "./utils/logger";

function argv(): string[] {
    return (globalThis as { process?: { argv?: string[] } }).process?.argv ?? [];
}

function normalizeArgs(args: string[]): string[] {
    if (args.length >= 1 && args[0] === "--") {
        return args.slice(1);
    }
    return args;
}

function printHome(unknownCommand?: string): void {
    console.log(renderCliHome({ unknownCommand }));
}

export async function runCli(): Promise<void> {
    const args = normalizeArgs(argv().slice(2));
    const command = (args[0] ?? "home").toLowerCase();

    switch (command) {
        case "home":
        case "help":
        case "-h":
        case "--help":
            printHome();
            return;
        case "init":
            await initCommand();
            return;
        case "ingest":
            if (!args[1]) {
                logger.warn("Missing path. Usage: cortexa ingest <path> [options]");
                return;
            }
            await ingestCommand(args[1], args.slice(2));
            return;
        case "query":
            await queryCommand(args.slice(1).join(" "));
            return;
        case "context":
            await contextCommand(args.slice(1).join(" "));
            return;
        case "daemon": {
            const { daemonCommand } = require("./commands/daemon") as typeof import("./commands/daemon");
            const action = (args[1] ?? "status") as "start" | "stop" | "status";
            await daemonCommand(action);
            return;
        }
        case "memory": {
            const action = args[1] ?? "list";
            await memoryCommand(action, args.slice(2));
            return;
        }
        case "dashboard": {
            await memoryCommand("dashboard", args.slice(1));
            return;
        }
        default:
            printHome(command);
    }
}

if (require.main === module) {
    void runCli().catch((error) => {
        logger.error(error instanceof Error ? error.message : String(error));
    });
}
