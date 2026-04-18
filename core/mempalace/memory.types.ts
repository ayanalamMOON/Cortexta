export type MemoryKind =
    | "episodic"
    | "semantic"
    | "procedural"
    | "code_entity"
    | "chat_turn"
    | "refactor_plan";

export type MemorySourceType = "code" | "chat" | "manual" | "system";

export interface MemoryRecord {
    id: string;
    projectId: string;
    kind: MemoryKind;
    sourceType: MemorySourceType;
    title: string;
    summary: string;
    content: string;
    tags: string[];
    importance: number;
    confidence: number;
    createdAt: number;
    lastAccessedAt: number;
    embeddingRef?: string;
    sourceRef?: string;
    copilotContent?: string;
    embedding?: number[];
}

export interface CreateMemoryInput {
    id?: string;
    projectId?: string;
    kind: MemoryKind;
    sourceType?: MemorySourceType;
    title: string;
    summary: string;
    content: string;
    tags?: string[];
    importance?: number;
    confidence?: number;
    embeddingRef?: string;
    sourceRef?: string;
    embedding?: number[];
}

export interface MemorySearchOptions {
    projectId?: string;
    topK?: number;
    minScore?: number;
}

export interface MemoryCompactionStats {
    projectId?: string;
    totalRows: number;
    compactedRows: number;
    plainRows: number;
    storedChars: number;
    originalChars: number;
    savedChars: number;
    savedPercent: number;
    compactionRate: number;
    averageCompressionRatio: number;
    integrityAnomalies: MemoryCompactionIntegrityAnomalies;
}

export interface MemoryCompactionIntegrityAnomalies {
    invalidChecksum: number;
    decodeError: number;
    total: number;
}

export interface MemoryCompactionTrendSnapshot {
    projectId?: string;
    createdAt: number;
    totalRows: number;
    compactedRows: number;
    plainRows: number;
    storedChars: number;
    originalChars: number;
    savedChars: number;
    savedPercent: number;
    compactionRate: number;
    invalidChecksum: number;
    decodeError: number;
    integrityAnomalyTotal: number;
}

export interface MemoryCompactionProjectBreakdownItem {
    projectId: string;
    stats: MemoryCompactionStats;
    lastAccessedAt?: number;
    riskLevel: "healthy" | "warning" | "critical";
}

export interface MemoryCompactionDashboardOptions {
    projectId?: string;
    lookbackDays?: number;
    maxTrendPoints?: number;
    maxProjects?: number;
    persistSnapshot?: boolean;
    perProjectSnapshotLimit?: number;
    snapshotRetentionDays?: number;
}

export interface MemoryCompactionDashboardPayload {
    generatedAt: number;
    lookbackDays: number;
    scopedProjectId?: string;
    current: MemoryCompactionStats;
    trend: {
        global: MemoryCompactionTrendSnapshot[];
        scopedProject: MemoryCompactionTrendSnapshot[];
    };
    perProject: MemoryCompactionProjectBreakdownItem[];
    integrityAnomalies: MemoryCompactionIntegrityAnomalies;
    totals: {
        projectCount: number;
        projectsWithAnomalies: number;
        projectsMostlyCompacted: number;
    };
}

export interface BackfillMemoryCompactionOptions {
    projectId?: string;
    limit?: number;
    dryRun?: boolean;
}

export interface BackfillMemoryCompactionResult {
    projectId?: string;
    dryRun: boolean;
    scanned: number;
    eligible: number;
    compacted: number;
    skipped: number;
    savedChars: number;
}

export interface ScoredMemory extends MemoryRecord {
    score: number;
    similarity: number;
    recency: number;
}
