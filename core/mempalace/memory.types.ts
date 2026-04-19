export type MemoryKind =
    | "episodic"
    | "semantic"
    | "procedural"
    | "code_entity"
    | "chat_turn"
    | "refactor_plan";

export type MemorySourceType = "code" | "chat" | "manual" | "system";

export type MemoryBranchName = string;

export interface MemoryRecord {
    id: string;
    logicalId?: string;
    projectId: string;
    branch?: MemoryBranchName;
    parentBranch?: MemoryBranchName;
    forkedFromCommit?: string;
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
    logicalId?: string;
    projectId?: string;
    branch?: MemoryBranchName;
    parentBranch?: MemoryBranchName;
    forkedFromCommit?: string;
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
    branch?: MemoryBranchName;
    topK?: number;
    minScore?: number;
    asOf?: number;
}

export interface MemoryBranchRecord {
    id: string;
    projectId: string;
    branch: MemoryBranchName;
    parentBranch?: MemoryBranchName;
    forkedFromCommit?: string;
    createdAt: number;
    updatedAt: number;
}

export interface CreateMemoryBranchInput {
    projectId: string;
    branch: MemoryBranchName;
    fromBranch?: MemoryBranchName;
    forkedFromCommit?: string;
}

export interface MergeMemoryBranchInput {
    projectId: string;
    sourceBranch: MemoryBranchName;
    targetBranch: MemoryBranchName;
    strategy?: "source-wins" | "target-wins";
}

export interface MergeMemoryBranchResult {
    projectId: string;
    sourceBranch: MemoryBranchName;
    targetBranch: MemoryBranchName;
    strategy: "source-wins" | "target-wins";
    mergedRows: number;
    appliedUpserts: number;
    appliedDeletes: number;
    skipped: number;
    completedAt: number;
}

export interface MemoryTemporalDiffItem {
    logicalId: string;
    kind: MemoryKind;
    sourceType: MemorySourceType;
    title: string;
    branch: MemoryBranchName;
    before?: {
        summary: string;
        content: string;
        sourceRef?: string;
        confidence: number;
        importance: number;
    };
    after?: {
        summary: string;
        content: string;
        sourceRef?: string;
        confidence: number;
        importance: number;
    };
    changeType: "added" | "removed" | "modified";
}

export interface MemoryTemporalDiffOptions {
    projectId: string;
    branch?: MemoryBranchName;
    from: number;
    to: number;
    limit?: number;
}

export interface MemoryTemporalDiffResult {
    projectId: string;
    branch: MemoryBranchName;
    from: number;
    to: number;
    totals: {
        added: number;
        removed: number;
        modified: number;
    };
    items: MemoryTemporalDiffItem[];
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

export interface MemoryCompactionOpportunityOptions {
    projectId?: string;
    limit?: number;
    scanLimit?: number;
    minContentChars?: number;
}

export interface MemoryCompactionOpportunityItem {
    id: string;
    projectId: string;
    kind: MemoryKind;
    sourceType: MemorySourceType;
    title: string;
    sourceRef?: string;
    lastAccessedAt: number;
    contentChars: number;
    estimatedStoredChars: number;
    estimatedSavedChars: number;
    estimatedSavedPercent: number;
    estimatedCompressionRatio: number;
}

export interface MemoryCompactionOpportunityReport {
    generatedAt: number;
    projectId?: string;
    scannedRows: number;
    plainRows: number;
    candidates: number;
    totalEstimatedSavedChars: number;
    items: MemoryCompactionOpportunityItem[];
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

export interface MemoryResurrectionAuditOptions {
    projectId?: string;
    limit?: number;
    maxIssues?: number;
}

export interface MemoryResurrectionAuditIssue {
    id: string;
    projectId: string;
    kind: MemoryKind;
    sourceType: MemorySourceType;
    title: string;
    integrity: "invalid_checksum" | "decode_error";
    preview: string;
    storedChars: number;
    originalChars: number;
    savedChars: number;
    lastAccessedAt: number;
}

export interface MemoryResurrectionAuditReport {
    projectId?: string;
    scannedRows: number;
    compactedRows: number;
    plainRows: number;
    validCompactedRows: number;
    anomalies: MemoryCompactionIntegrityAnomalies;
    anomalyRate: number;
    compactionOpportunityRate: number;
    issueSamples: MemoryResurrectionAuditIssue[];
    recommendations: string[];
}

export interface ScoredMemory extends MemoryRecord {
    score: number;
    similarity: number;
    recency: number;
}
