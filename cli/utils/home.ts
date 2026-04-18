interface CliHomeOptions {
    unknownCommand?: string;
}

interface StyledPalette {
    readonly enabled: boolean;
    readonly reset: string;
    brand(text: string): string;
    accent(text: string): string;
    muted(text: string): string;
    success(text: string): string;
    warning(text: string): string;
    bold(text: string): string;
}

function createPalette(): StyledPalette {
    const enabled = Boolean(process.stdout?.isTTY) && process.env.NO_COLOR !== "1";
    const reset = "\x1b[0m";

    const colorize = (text: string, code: string): string => (enabled ? `${code}${text}${reset}` : text);

    return {
        enabled,
        reset,
        brand: (text: string) => colorize(text, "\x1b[38;5;81m"),
        accent: (text: string) => colorize(text, "\x1b[38;5;117m"),
        muted: (text: string) => colorize(text, "\x1b[38;5;246m"),
        success: (text: string) => colorize(text, "\x1b[38;5;77m"),
        warning: (text: string) => colorize(text, "\x1b[38;5;214m"),
        bold: (text: string) => colorize(text, "\x1b[1m")
    };
}

function padRight(value: string, width: number): string {
    if (value.length >= width) {
        return value;
    }

    return value + " ".repeat(width - value.length);
}

function renderCommandRows(
    palette: StyledPalette,
    rows: Array<{ command: string; description: string }>,
    commandWidth = 34
): string[] {
    return rows.map((row) => {
        const left = palette.accent(padRight(row.command, commandWidth));
        return `  ${left} ${palette.muted(row.description)}`;
    });
}

export function renderCliHome(options: CliHomeOptions = {}): string {
    const palette = createPalette();
    const hr = palette.muted("─".repeat(86));
    const lines: string[] = [];

    const logo = [
        " ██████╗ ██████╗ ██████╗ ████████╗███████╗██╗  ██╗ █████╗ ",
        "██╔════╝██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝╚██╗██╔╝██╔══██╗",
        "██║     ██║   ██║██████╔╝   ██║   █████╗   ╚███╔╝ ███████║",
        "██║     ██║   ██║██╔══██╗   ██║   ██╔══╝   ██╔██╗ ██╔══██║",
        "╚██████╗╚██████╔╝██║  ██║   ██║   ███████╗██╔╝ ██╗██║  ██║",
        " ╚═════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝"
    ];

    for (const row of logo) {
        lines.push(palette.brand(row));
    }

    lines.push(palette.bold("\nCORTEXA CLI"), palette.muted("Local-first memory runtime for your dev workflow."));
    lines.push(hr);

    if (options.unknownCommand) {
        lines.push(palette.warning(`⚠ Unknown command: ${options.unknownCommand}`));
        lines.push(palette.muted("  Showing the command home screen. Try one of the commands below."));
        lines.push(hr);
    }

    lines.push(palette.bold("Quick start"));
    lines.push(`  ${palette.success("$ pnpm run cortexa -- init")}`);
    lines.push(`  ${palette.success("$ pnpm run cortexa -- ingest . --project-id=my-project")}`);
    lines.push(`  ${palette.success("$ pnpm run cortexa -- query \"how did we solve retry jitter?\"")}`);
    lines.push(`  ${palette.success("$ pnpm run cortexa -- context \"prepare implementation plan\"")}`);
    lines.push("", palette.bold("Core commands"));

    lines.push(
        ...renderCommandRows(palette, [
            { command: "init", description: "Initialize SQLite schema and vector collection." },
            {
                command: "ingest <path> [options]",
                description: "Ingest code and optional chat sessions into memory."
            },
            { command: "query <text>", description: "Run hybrid retrieval over memories." },
            { command: "context <text>", description: "Compile a token-bounded context payload." },
            { command: "daemon <start|stop|status>", description: "Control local daemon API runtime." }
        ])
    );

    lines.push("", palette.bold("Memory commands"));
    lines.push(
        ...renderCommandRows(
            palette,
            [
                { command: "memory list [projectId] [--limit=<n>]", description: "List recent memories." },
                {
                    command: "memory search <query> [--project-id=<id>]",
                    description: "Search memory store with scoring."
                },
                { command: "memory get <id> [--full]", description: "Show memory content." },
                { command: "memory resurrect <id> [--full]", description: "Read restored compact content." },
                { command: "memory delete <id>", description: "Delete one memory item." },
                { command: "memory stats [--project-id=<id>]", description: "Compaction and integrity stats." },
                {
                    command: "memory backfill [--apply] [--limit=<n>]",
                    description: "Dry-run/apply compaction backfill."
                },
                { command: "memory dashboard [options]", description: "Compaction dashboard payload/report." }
            ],
            45
        )
    );

    lines.push("", palette.bold("Aliases + help"));
    lines.push(
        ...renderCommandRows(
            palette,
            [
                { command: "dashboard [options]", description: "Alias of: memory dashboard [options]." },
                { command: "help | -h | --help", description: "Show this home screen." }
            ],
            28
        )
    );

    lines.push(hr);
    lines.push(
        palette.muted(
            "Tip: use -- after pnpm script invocation, e.g. pnpm run cortexa -- dashboard --json --out-json=./tmp/dashboard.json"
        )
    );

    return lines.join("\n");
}
