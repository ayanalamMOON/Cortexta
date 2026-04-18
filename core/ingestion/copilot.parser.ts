export interface CopilotTurn {
    prompt: string;
    response: string;
    timestamp?: number;
    files?: string[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === "object" && value !== null;
}

function toTimestamp(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
            return undefined;
        }

        const fromNumber = Number(trimmed);
        if (Number.isFinite(fromNumber)) {
            return fromNumber;
        }

        const parsed = Date.parse(trimmed);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
}

function asTrimmedString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function collectStrings(value: unknown): string[] {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed ? [trimmed] : [];
    }

    if (Array.isArray(value)) {
        const out: string[] = [];
        for (const item of value) {
            out.push(...collectStrings(item));
        }
        return out;
    }

    if (isRecord(value)) {
        return [
            asTrimmedString(value.path),
            asTrimmedString(value.file),
            asTrimmedString(value.uri)
        ].filter(Boolean);
    }

    return [];
}

const NON_RESPONSE_KINDS = new Set([
    "thinking",
    "preparetoolinvocation",
    "toolinvocationserialized",
    "texteditgroup",
    "mcpserversstarting"
]);

function uniqueLines(values: string[]): string {
    const out: string[] = [];
    const seen = new Set<string>();

    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) {
            continue;
        }

        seen.add(trimmed);
        out.push(trimmed);
    }

    return out.join("\n").trim();
}

function extractPromptText(value: unknown): string {
    if (typeof value === "string") {
        return value.trim();
    }

    if (!isRecord(value)) {
        return "";
    }

    const direct =
        asTrimmedString(value.text) ||
        asTrimmedString(value.prompt) ||
        asTrimmedString(value.message) ||
        asTrimmedString(value.content) ||
        asTrimmedString(value.body) ||
        asTrimmedString(value.value);

    if (direct) {
        return direct;
    }

    if (Array.isArray(value.parts)) {
        return uniqueLines(value.parts.map((part) => extractPromptText(part)).filter(Boolean));
    }

    return "";
}

function extractResponseText(value: unknown): string {
    if (typeof value === "string") {
        return value.trim();
    }

    if (Array.isArray(value)) {
        const chunks: string[] = [];

        for (const item of value) {
            if (typeof item === "string") {
                const trimmed = item.trim();
                if (trimmed) {
                    chunks.push(trimmed);
                }
                continue;
            }

            if (!isRecord(item)) {
                continue;
            }

            const kind = asTrimmedString(item.kind).toLowerCase();
            if (kind && NON_RESPONSE_KINDS.has(kind)) {
                continue;
            }

            const direct =
                asTrimmedString(item.value) ||
                asTrimmedString(item.text) ||
                asTrimmedString(item.content) ||
                asTrimmedString(item.message);

            if (direct) {
                chunks.push(direct);
                continue;
            }

            const nestedMessage = extractPromptText(item.message);
            if (nestedMessage) {
                chunks.push(nestedMessage);
            }
        }

        return uniqueLines(chunks);
    }

    if (!isRecord(value)) {
        return "";
    }

    return (
        extractResponseText(value.response) ||
        extractResponseText(value.answer) ||
        extractResponseText(value.output) ||
        extractPromptText(value)
    );
}

function toIndex(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        return value;
    }

    if (typeof value === "string") {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed >= 0) {
            return parsed;
        }
    }

    return undefined;
}

function extractItemsFromEventLog(records: UnknownRecord[]): UnknownRecord[] {
    const requestsByIndex = new Map<number, UnknownRecord>();

    for (const record of records) {
        const snapshot = isRecord(record.v) ? record.v : undefined;
        if (snapshot && Array.isArray(snapshot.requests)) {
            for (let index = 0; index < snapshot.requests.length; index += 1) {
                const request = snapshot.requests[index];
                if (!isRecord(request)) {
                    continue;
                }

                requestsByIndex.set(index, {
                    ...(requestsByIndex.get(index) ?? {}),
                    ...request
                });
            }
        }

        if (!Array.isArray(record.k) || record.k.length < 3) {
            continue;
        }

        if (`${record.k[0]}` !== "requests") {
            continue;
        }

        const requestIndex = toIndex(record.k[1]);
        if (requestIndex === undefined) {
            continue;
        }

        const field = `${record.k[2]}`;
        const current = requestsByIndex.get(requestIndex) ?? {};

        if (field === "response") {
            requestsByIndex.set(requestIndex, { ...current, response: record.v });
            continue;
        }

        if (field === "message") {
            requestsByIndex.set(requestIndex, { ...current, message: record.v });
            continue;
        }

        if (field === "timestamp" || field === "time") {
            requestsByIndex.set(requestIndex, { ...current, [field]: record.v });
        }
    }

    return [...requestsByIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, request]) => request);
}

function collectFiles(container: UnknownRecord, item: UnknownRecord): string[] {
    return [
        ...collectStrings(container.files),
        ...collectStrings(item.files),
        ...collectStrings(container.references),
        ...collectStrings(item.references),
        ...collectStrings(container.attachments),
        ...collectStrings(item.attachments)
    ].filter(Boolean);
}

function extractItems(raw: unknown): UnknownRecord[] {
    if (Array.isArray(raw)) {
        const records = raw.filter(isRecord);
        const fromEventLog = extractItemsFromEventLog(records);
        return fromEventLog.length > 0 ? fromEventLog : records;
    }

    if (!isRecord(raw)) {
        return [];
    }

    const candidates = [raw.requests, raw.messages, raw.turns, raw.events, raw.items];
    for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
            return candidate.filter(isRecord);
        }
    }

    return [raw];
}

function resolveContainer(item: UnknownRecord): UnknownRecord {
    return isRecord(item.data) ? item.data : item;
}

function parseExplicitTurn(item: UnknownRecord, container: UnknownRecord): CopilotTurn | null {
    const prompt =
        asTrimmedString(container.prompt) ||
        asTrimmedString(container.request) ||
        asTrimmedString(container.user) ||
        asTrimmedString(container.input) ||
        extractPromptText(container.message) ||
        asTrimmedString(item.prompt) ||
        asTrimmedString(item.request) ||
        asTrimmedString(item.user) ||
        extractPromptText(item.message);

    const response =
        asTrimmedString(container.response) ||
        asTrimmedString(container.answer) ||
        asTrimmedString(container.assistant) ||
        asTrimmedString(container.output) ||
        extractResponseText(container.response) ||
        extractResponseText(container.answer) ||
        extractResponseText(container.output) ||
        asTrimmedString(item.response) ||
        asTrimmedString(item.answer) ||
        asTrimmedString(item.assistant) ||
        extractResponseText(item.response) ||
        extractResponseText(item.answer);

    if (!prompt && !response) {
        return null;
    }

    const timestamp =
        toTimestamp(container.timestamp) ??
        toTimestamp(container.time) ??
        toTimestamp(item.timestamp) ??
        toTimestamp(item.time);

    const files = collectFiles(container, item);

    return {
        prompt,
        response,
        timestamp,
        files
    };
}

type Role = "user" | "assistant";

function inferRole(item: UnknownRecord, container: UnknownRecord): Role | undefined {
    const typeValue = `${asTrimmedString(item.type)} ${asTrimmedString(container.type)}`.toLowerCase();
    if (typeValue.includes("user")) {
        return "user";
    }
    if (typeValue.includes("assistant")) {
        return "assistant";
    }

    const role = asTrimmedString(container.role).toLowerCase();
    if (role === "user" || role === "assistant") {
        return role;
    }

    return undefined;
}

function extractRoleContent(item: UnknownRecord, container: UnknownRecord): string {
    return (
        asTrimmedString(container.content) ||
        asTrimmedString(container.message) ||
        asTrimmedString(container.text) ||
        asTrimmedString(container.body) ||
        asTrimmedString(item.content) ||
        asTrimmedString(item.message) ||
        asTrimmedString(item.text)
    );
}

export function parseCopilotSession(raw: unknown): CopilotTurn[] {
    const items = extractItems(raw);
    const turns: CopilotTurn[] = [];

    let pendingUser:
        | {
            prompt: string;
            timestamp?: number;
            files: string[];
        }
        | undefined;

    for (const item of items) {
        const container = resolveContainer(item);

        const explicit = parseExplicitTurn(item, container);
        if (explicit) {
            turns.push(explicit);
            pendingUser = undefined;
            continue;
        }

        const role = inferRole(item, container);
        const content = extractRoleContent(item, container);
        if (!role || !content) {
            continue;
        }

        const timestamp =
            toTimestamp(container.timestamp) ??
            toTimestamp(container.time) ??
            toTimestamp(item.timestamp) ??
            toTimestamp(item.time);

        const files = collectFiles(container, item);

        if (role === "user") {
            if (pendingUser?.prompt) {
                turns.push({
                    prompt: pendingUser.prompt,
                    response: "",
                    timestamp: pendingUser.timestamp,
                    files: pendingUser.files
                });
            }

            pendingUser = {
                prompt: content,
                timestamp,
                files
            };
            continue;
        }

        if (pendingUser?.prompt) {
            turns.push({
                prompt: pendingUser.prompt,
                response: content,
                timestamp: timestamp ?? pendingUser.timestamp,
                files: [...new Set([...(pendingUser.files ?? []), ...files])]
            });
            pendingUser = undefined;
            continue;
        }

        turns.push({
            prompt: "",
            response: content,
            timestamp,
            files
        });
    }

    if (pendingUser?.prompt) {
        turns.push({
            prompt: pendingUser.prompt,
            response: "",
            timestamp: pendingUser.timestamp,
            files: pendingUser.files
        });
    }

    return turns
        .map((turn) => ({
            ...turn,
            prompt: turn.prompt.trim(),
            response: turn.response.trim(),
            files: (turn.files ?? []).map((file) => String(file).trim()).filter(Boolean)
        }))
        .filter((turn) => turn.prompt.length > 0 || turn.response.length > 0);
}
