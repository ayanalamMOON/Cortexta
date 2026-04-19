#!/usr/bin/env node

import { Command } from "commander";
import { runCli as runPrimaryCli } from "../../../cli/index";
import { contextCommand } from "./commands/context";
import { evolveCommand } from "./commands/evolve";
import { ingestCommand } from "./commands/ingest";
import { ingestChatCommand } from "./commands/ingest-chat";
import { initCommand } from "./commands/init";
import { queryCommand } from "./commands/query";
import { refactorCommand } from "./commands/refactor";
import { watchCommand } from "./commands/watch";

const program = new Command();
program.name("cortexa").description("CORTEXA CLI");

program.showHelpAfterError();
program.exitOverride();

const PRIMARY_CLI_COMMANDS = new Set([
    "home",
    "help",
    "-h",
    "--help",
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

export function normalizeArgv(argv: string[]): string[] {
    if (argv.length < 3) {
        return argv;
    }

    let index = 2;
    while (index < argv.length && argv[index] === "--") {
        index += 1;
    }

    if (index !== 2) {
        argv = [argv[0], argv[1], ...argv.slice(index)];
    }

    const first = (argv[2] ?? "").toLowerCase();
    if (first.startsWith("--") && first.length > 2) {
        const candidate = first.slice(2);
        if (PRIMARY_CLI_COMMANDS.has(candidate)) {
            return [argv[0], argv[1], candidate, ...argv.slice(3)];
        }
    }

    return argv;
}

export function shouldRouteToPrimaryCli(argv: string[]): boolean {
    const normalized = normalizeArgv(argv);
    const command = (normalized[2] ?? "home").toLowerCase();
    return PRIMARY_CLI_COMMANDS.has(command);
}

interface CommanderLikeError {
    code: string;
    exitCode?: number;
}

function toCommanderLikeError(error: unknown): CommanderLikeError | null {
    if (!error || typeof error !== "object") {
        return null;
    }

    const candidate = error as { code?: unknown; exitCode?: unknown };
    if (typeof candidate.code !== "string") {
        return null;
    }

    const exitCode = typeof candidate.exitCode === "number" ? candidate.exitCode : undefined;
    return {
        code: candidate.code,
        exitCode
    };
}

function isExpectedCommanderExit(error: CommanderLikeError): boolean {
    return error.code === "commander.helpDisplayed" || error.code === "commander.version";
}

function handleCliError(error: unknown): void {
    const commanderError = toCommanderLikeError(error);
    if (commanderError) {
        if (isExpectedCommanderExit(commanderError)) {
            return;
        }
        process.exitCode = commanderError.exitCode ?? 1;
        return;
    }

    if (error instanceof Error) {
        console.error(`[cortexa:cli] ${error.message}`);
        return;
    }
    console.error("[cortexa:cli] command failed", error);
}

program
    .addCommand(initCommand)
    .addCommand(ingestCommand)
    .addCommand(ingestChatCommand)
    .addCommand(queryCommand)
    .addCommand(contextCommand)
    .addCommand(watchCommand)
    .addCommand(refactorCommand)
    .addCommand(evolveCommand);

export async function runAppsCli(argv: string[] = process.argv): Promise<void> {
    const normalizedArgv = normalizeArgv(argv);

    if (shouldRouteToPrimaryCli(normalizedArgv)) {
        const originalArgv = process.argv;
        process.argv = normalizedArgv;
        try {
            await runPrimaryCli();
        } finally {
            process.argv = originalArgv;
        }
        return;
    }

    await program.parseAsync(normalizedArgv);
}

if (require.main === module) {
    void runAppsCli().catch((error: unknown) => {
        handleCliError(error);
    });
}
