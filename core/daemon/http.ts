export type JsonRecord = Record<string, unknown>;

export function toRecord(value: unknown): JsonRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    return value as JsonRecord;
}

export function toTrimmedString(value: unknown, maxLength = 4096): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

export function toBoolean(value: unknown, fallback = false): boolean {
    if (typeof value === "boolean") {
        return value;
    }

    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["1", "true", "yes", "on"].includes(normalized)) {
            return true;
        }
        if (["0", "false", "no", "off"].includes(normalized)) {
            return false;
        }
    }

    return fallback;
}

export function toFiniteNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return undefined;
}

export function toBoundedInt(value: unknown, min: number, max: number): number | undefined {
    const parsed = toFiniteNumber(value);
    if (parsed === undefined) {
        return undefined;
    }

    const rounded = Math.trunc(parsed);
    if (!Number.isFinite(rounded)) {
        return undefined;
    }

    return Math.min(max, Math.max(min, rounded));
}

export function toBoundedNumber(value: unknown, min: number, max: number): number | undefined {
    const parsed = toFiniteNumber(value);
    if (parsed === undefined) {
        return undefined;
    }

    return Math.min(max, Math.max(min, parsed));
}

export function toStringArray(value: unknown, maxItems = 64, maxItemLength = 256): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const output: string[] = [];
    for (const item of value) {
        const normalized = toTrimmedString(item, maxItemLength);
        if (!normalized) {
            continue;
        }
        output.push(normalized);
        if (output.length >= maxItems) {
            break;
        }
    }

    return output;
}

export function toPort(value: unknown, fallback: number): number {
    const parsed = toBoundedInt(value, 1, 65535);
    return parsed ?? fallback;
}
