export type IntentCategory =
    | "debugging"
    | "testing"
    | "refactor"
    | "performance"
    | "security"
    | "documentation"
    | "feature"
    | "general";

export interface IntentSignal {
    category: IntentCategory;
    confidence: number;
    matchedKeywords: string[];
}

export interface ProactiveContextSuggestion {
    query: string;
    projectId?: string;
    branch: string;
    asOf?: number;
    intent: IntentSignal;
    recommendedTopK: number;
    recommendedMaxTokens: number;
    recommendedScope: string;
    recommendedConstraints: string[];
    reason: string;
}

interface IntentRule {
    category: IntentCategory;
    patterns: RegExp[];
    topK: number;
    maxTokens: number;
    scope: string;
    constraints: string[];
}

const MAIN_BRANCH = "main";
const DEFAULT_CONFIDENCE = 0.45;
const HISTORY = new Map<string, { category: IntentCategory; count: number; lastSeenAt: number }>();

const INTENT_RULES: IntentRule[] = [
    {
        category: "debugging",
        patterns: [/\berror\b/i, /\bexception\b/i, /\bbug\b/i, /\bfail(?:ed|ing)?\b/i, /\bcrash\b/i, /stack trace/i],
        topK: 16,
        maxTokens: 5600,
        scope: "runtime + diagnostics + memory",
        constraints: ["prioritize failure context", "prefer latest affected entities"]
    },
    {
        category: "testing",
        patterns: [/\btest(?:s|ing)?\b/i, /\bunit\b/i, /\bintegration\b/i, /\be2e\b/i, /\bcoverage\b/i],
        topK: 14,
        maxTokens: 5200,
        scope: "tests + related implementation",
        constraints: ["include assertions and edge cases", "surface flaky points"]
    },
    {
        category: "refactor",
        patterns: [/\brefactor\b/i, /\bcleanup\b/i, /\bsimplif(?:y|ication)\b/i, /\bextract\b/i, /\brename\b/i],
        topK: 12,
        maxTokens: 4600,
        scope: "design + dependencies + hotspots",
        constraints: ["preserve behavior", "highlight coupling"]
    },
    {
        category: "performance",
        patterns: [/\bperformance\b/i, /\bslow\b/i, /\blatency\b/i, /optimi[sz]e/i, /\bthroughput\b/i, /\bmemory leak\b/i],
        topK: 15,
        maxTokens: 5200,
        scope: "hot paths + algorithmic complexity",
        constraints: ["prioritize hot-path code", "highlight complexity drivers"]
    },
    {
        category: "security",
        patterns: [/\bsecurity\b/i, /\bvuln(?:erability)?\b/i, /\bcve\b/i, /\bauth(?:entication|orization)?\b/i, /\bxss\b/i, /\bcsrf\b/i],
        topK: 16,
        maxTokens: 5400,
        scope: "auth + input validation + secret handling",
        constraints: ["surface trust boundaries", "flag dangerous defaults"]
    },
    {
        category: "documentation",
        patterns: [/\bdocs?\b/i, /\breadme\b/i, /\bexplain\b/i, /\bguide\b/i, /\bhow to\b/i],
        topK: 10,
        maxTokens: 3800,
        scope: "architecture + APIs + examples",
        constraints: ["prefer concise context", "include canonical references"]
    },
    {
        category: "feature",
        patterns: [/\bimplement\b/i, /\badd\b/i, /\bbuild\b/i, /\bcreate\b/i, /\bsupport\b/i, /\bfeature\b/i],
        topK: 13,
        maxTokens: 4800,
        scope: "requirements + touched modules",
        constraints: ["identify dependencies", "capture migration impacts"]
    }
];

function normalizeBranch(value: unknown): string {
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized || MAIN_BRANCH;
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.min(1, Math.max(0, value));
}

function scoreIntent(query: string, rule: IntentRule): { score: number; matchedKeywords: string[] } {
    const matches = rule.patterns.filter((pattern) => pattern.test(query));
    const matchedKeywords = matches.map((pattern) => pattern.source);

    if (matches.length === 0) {
        return {
            score: 0,
            matchedKeywords
        };
    }

    const score = clamp01(0.38 + matches.length * 0.12);
    return {
        score,
        matchedKeywords
    };
}

function historyKey(projectId: string | undefined, branch: string): string {
    return `${projectId?.trim() || "global"}::${branch}`;
}

function adjustByHistory(key: string, category: IntentCategory, baseConfidence: number): number {
    const prior = HISTORY.get(key);
    if (!prior) {
        HISTORY.set(key, {
            category,
            count: 1,
            lastSeenAt: Date.now()
        });
        return baseConfidence;
    }

    if (prior.category === category) {
        prior.count += 1;
        prior.lastSeenAt = Date.now();
        HISTORY.set(key, prior);
        return clamp01(baseConfidence + Math.min(0.12, prior.count * 0.02));
    }

    HISTORY.set(key, {
        category,
        count: 1,
        lastSeenAt: Date.now()
    });
    return baseConfidence;
}

export function inferIntentSignal(query: string, context?: { projectId?: string; branch?: string }): IntentSignal {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
        return {
            category: "general",
            confidence: 0,
            matchedKeywords: []
        };
    }

    let bestRule: IntentRule | undefined;
    let bestScore = 0;
    let bestKeywords: string[] = [];

    for (const rule of INTENT_RULES) {
        const scored = scoreIntent(normalizedQuery, rule);
        if (scored.score <= bestScore) {
            continue;
        }

        bestRule = rule;
        bestScore = scored.score;
        bestKeywords = scored.matchedKeywords;
    }

    if (!bestRule) {
        const confidence = adjustByHistory(
            historyKey(context?.projectId, normalizeBranch(context?.branch)),
            "general",
            DEFAULT_CONFIDENCE
        );

        return {
            category: "general",
            confidence,
            matchedKeywords: []
        };
    }

    const confidence = adjustByHistory(
        historyKey(context?.projectId, normalizeBranch(context?.branch)),
        bestRule.category,
        bestScore
    );

    return {
        category: bestRule.category,
        confidence,
        matchedKeywords: bestKeywords
    };
}

function findRuleByCategory(category: IntentCategory): IntentRule | undefined {
    return INTENT_RULES.find((rule) => rule.category === category);
}

export function buildProactiveContextSuggestion(params: {
    query: string;
    projectId?: string;
    branch?: string;
    asOf?: number;
}): ProactiveContextSuggestion {
    const branch = normalizeBranch(params.branch);
    const intent = inferIntentSignal(params.query, {
        projectId: params.projectId,
        branch
    });
    const rule = findRuleByCategory(intent.category);

    const recommendedTopK = rule?.topK ?? 12;
    const recommendedMaxTokens = rule?.maxTokens ?? 4200;
    const recommendedScope = rule?.scope ?? "project + memory + retrieval";
    const recommendedConstraints = rule?.constraints ?? ["prefer high-confidence memories", "keep context concise"];

    const reason = intent.category === "general"
        ? "No dominant intent detected. Using balanced context defaults."
        : `Detected ${intent.category} intent from query signals; proactively tuned context packing.`;

    return {
        query: params.query,
        projectId: params.projectId,
        branch,
        asOf: typeof params.asOf === "number" && Number.isFinite(params.asOf) ? Math.trunc(params.asOf) : undefined,
        intent,
        recommendedTopK,
        recommendedMaxTokens,
        recommendedScope,
        recommendedConstraints,
        reason
    };
}

export function shouldEmitProactiveSuggestion(
    suggestion: ProactiveContextSuggestion,
    threshold = 0.55
): boolean {
    return suggestion.intent.confidence >= clamp01(threshold);
}
