export interface ParsedCliArgs {
    positionals: string[];
    options: Record<string, string | true>;
}

export function parseCliArgs(tokens: string[]): ParsedCliArgs {
    const positionals: string[] = [];
    const options: Record<string, string | true> = {};

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (!token.startsWith("--")) {
            positionals.push(token);
            continue;
        }

        const trimmed = token.slice(2);
        if (!trimmed) {
            continue;
        }

        const eqIndex = trimmed.indexOf("=");
        if (eqIndex >= 0) {
            const key = trimmed.slice(0, eqIndex).trim();
            const value = trimmed.slice(eqIndex + 1).trim();
            if (!key) {
                continue;
            }
            options[key] = value || true;
            continue;
        }

        const key = trimmed.trim();
        const next = tokens[index + 1];
        if (next && !next.startsWith("--")) {
            options[key] = next;
            index += 1;
            continue;
        }

        options[key] = true;
    }

    return {
        positionals,
        options
    };
}

export function readStringOption(
    parsed: ParsedCliArgs,
    names: string[]
): string | undefined {
    for (const name of names) {
        const raw = parsed.options[name];
        if (typeof raw === "string") {
            const trimmed = raw.trim();
            if (trimmed) {
                return trimmed;
            }
        }
    }

    return undefined;
}

export function readBooleanOption(
    parsed: ParsedCliArgs,
    names: string[],
    fallback = false
): boolean {
    for (const name of names) {
        const raw = parsed.options[name];
        if (raw === true) {
            return true;
        }

        if (typeof raw === "string") {
            const normalized = raw.trim().toLowerCase();
            if (["1", "true", "yes", "on"].includes(normalized)) {
                return true;
            }
            if (["0", "false", "no", "off"].includes(normalized)) {
                return false;
            }
        }
    }

    return fallback;
}

export function readNumberOption(
    parsed: ParsedCliArgs,
    names: string[]
): number | undefined {
    for (const name of names) {
        const raw = parsed.options[name];
        if (typeof raw !== "string") {
            continue;
        }

        const parsedNumber = Number(raw);
        if (Number.isFinite(parsedNumber)) {
            return parsedNumber;
        }
    }

    return undefined;
}

export function hasFlag(parsed: ParsedCliArgs, names: string[]): boolean {
    for (const name of names) {
        if (parsed.options[name] === true) {
            return true;
        }
    }

    return false;
}

export function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, Math.trunc(value)));
}
