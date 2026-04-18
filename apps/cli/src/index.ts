#!/usr/bin/env node

import { Command } from "commander";
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

function normalizeArgv(argv: string[]): string[] {
    if (argv.length >= 4 && argv[2] === "--") {
        return [argv[0], argv[1], ...argv.slice(3)];
    }
    return argv;
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

program
    .addCommand(initCommand)
    .addCommand(ingestCommand)
    .addCommand(ingestChatCommand)
    .addCommand(queryCommand)
    .addCommand(contextCommand)
    .addCommand(watchCommand)
    .addCommand(refactorCommand)
    .addCommand(evolveCommand);

void program
    .parseAsync(normalizeArgv(process.argv))
    .catch((error: unknown) => {
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
    });
