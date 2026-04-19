import readline from "node:readline";
import { doctor } from "../scripts/doctor";
import { agentsCommand } from "./commands/agents";
import { contextCommand } from "./commands/context";
import { evolveCommand } from "./commands/evolve";
import { ingestCommand } from "./commands/ingest";
import { initCommand } from "./commands/init";
import { memoryCommand } from "./commands/memory";
import { queryCommand } from "./commands/query";
import { renderCliHome } from "./utils/home";
import { logger } from "./utils/logger";

function argv(): string[] {
    return (globalThis as { process?: { argv?: string[] } }).process?.argv ?? [];
}

const TOP_LEVEL_COMMANDS = new Set([
    "home",
    "help",
    "doctor",
    "init",
    "ingest",
    "query",
    "context",
    "agent",
    "agents",
    "evolve",
    "daemon",
    "memory",
    "dashboard"
]);

function normalizeArgs(args: string[]): string[] {
    if (args.length === 0) {
        return args;
    }

    let normalized = [...args];
    while (normalized.length > 0 && normalized[0] === "--") {
        normalized = normalized.slice(1);
    }

    if (normalized.length === 0) {
        return normalized;
    }

    const first = normalized[0].toLowerCase();
    if (first.startsWith("--") && first.length > 2) {
        const candidate = first.slice(2);
        if (TOP_LEVEL_COMMANDS.has(candidate)) {
            normalized[0] = candidate;
        }
    }

    return normalized;
}

function printHome(unknownCommand?: string): void {
    console.log(renderCliHome({ unknownCommand }));
}

function tokenizeInteractiveInput(input: string): string[] {
    const matches = input.match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g) ?? [];
    return matches.map((token) => {
        const isQuotedDouble = token.startsWith("\"") && token.endsWith("\"") && token.length >= 2;
        const isQuotedSingle = token.startsWith("'") && token.endsWith("'") && token.length >= 2;

        if (!isQuotedDouble && !isQuotedSingle) {
            return token;
        }

        return token.slice(1, -1).replace(/\\(["'\\])/g, "$1");
    });
}

async function runInteractiveShell(options: { stopInProcessDaemonOnExit?: boolean } = {}): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        printHome();
        logger.warn("Interactive shell is unavailable because this terminal is non-interactive.");
        return;
    }

    printHome();
    logger.info("Interactive shell ready. Type a command, or `exit` to quit.");

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true
    });

    rl.setPrompt("cortexa> ");
    rl.prompt();

    try {
        for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed) {
                rl.prompt();
                continue;
            }

            const lowered = trimmed.toLowerCase();
            if (lowered === "exit" || lowered === "quit") {
                rl.close();
                break;
            }

            const commandArgs = normalizeArgs(tokenizeInteractiveInput(trimmed));
            await runCommand(commandArgs);
            rl.prompt();
        }
    } finally {
        rl.close();
    }

    if (options.stopInProcessDaemonOnExit) {
        const { daemonCommand, hasInProcessDaemon } = require("./commands/daemon") as typeof import("./commands/daemon");
        if (hasInProcessDaemon()) {
            logger.info("Stopping in-process daemon before exiting interactive shell.");
            await daemonCommand("stop");
        }
    }
}

async function runCommand(args: string[]): Promise<void> {
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
            {
                const explicitPathProvided = typeof args[1] === "string" && !args[1].startsWith("-");
                const ingestPath = explicitPathProvided ? args[1] : ".";
                const ingestArgs = explicitPathProvided ? args.slice(2) : args.slice(1);

                if (!explicitPathProvided) {
                    logger.info("No ingest path provided. Using current directory.");
                }

                await ingestCommand(ingestPath, ingestArgs);
            }
            return;
        case "query":
            await queryCommand(args.slice(1));
            return;
        case "context":
            await contextCommand(args.slice(1));
            return;
        case "doctor":
            await doctor();
            return;
        case "evolve":
            await evolveCommand(args.slice(1));
            return;
        case "agents":
            await agentsCommand(args.slice(1));
            return;
        case "agent":
            await agentsCommand(args.slice(1));
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

export async function runCli(): Promise<void> {
    const args = normalizeArgs(argv().slice(2));

    if (args.length === 0) {
        const { daemonCommand } = require("./commands/daemon") as typeof import("./commands/daemon");
        logger.info("No command provided. Starting daemon by default. Use `cortexa help` for command list.");
        await daemonCommand("start");
        await runInteractiveShell({ stopInProcessDaemonOnExit: true });
        return;
    }

    await runCommand(args);
}

if (require.main === module) {
    void runCli().catch((error) => {
        logger.error(error instanceof Error ? error.message : String(error));
    });
}
