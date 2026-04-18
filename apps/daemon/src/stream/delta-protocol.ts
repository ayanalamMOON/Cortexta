export interface ReplaceSpan {
    start: number;
    end: number;
}

export interface StreamDelta {
    sessionId: string;
    projectId?: string;
    step: number;
    deltaType: "snapshot" | "append" | "replace" | "remove";
    payload: unknown;
    tokenEstimate?: number;
    replaceSpan?: ReplaceSpan;
    checksum?: string;
    timestamp?: number;
}

function fnv1a(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

export function makeDelta(params: Omit<StreamDelta, "checksum" | "timestamp">): StreamDelta {
    const body = JSON.stringify(params.payload ?? null);
    return {
        ...params,
        timestamp: Date.now(),
        checksum: fnv1a(`${params.sessionId}:${params.step}:${params.deltaType}:${body}`)
    };
}

export function isStreamDelta(value: unknown): value is StreamDelta {
    if (!value || typeof value !== "object") return false;
    const row = value as StreamDelta;

    const hasValidReplaceSpan =
        row.replaceSpan === undefined ||
        (typeof row.replaceSpan === "object" &&
            row.replaceSpan !== null &&
            typeof row.replaceSpan.start === "number" &&
            Number.isFinite(row.replaceSpan.start) &&
            row.replaceSpan.start >= 0 &&
            typeof row.replaceSpan.end === "number" &&
            Number.isFinite(row.replaceSpan.end) &&
            row.replaceSpan.end >= row.replaceSpan.start);

    const hasValidTokenEstimate = row.tokenEstimate === undefined || (typeof row.tokenEstimate === "number" && Number.isFinite(row.tokenEstimate));

    return (
        typeof row.sessionId === "string" &&
        (row.projectId === undefined || typeof row.projectId === "string") &&
        typeof row.step === "number" &&
        Number.isFinite(row.step) &&
        row.step >= 0 &&
        (row.deltaType === "snapshot" || row.deltaType === "append" || row.deltaType === "replace" || row.deltaType === "remove")
        && hasValidTokenEstimate
        && hasValidReplaceSpan
    );
}
