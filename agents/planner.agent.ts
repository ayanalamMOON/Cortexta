export type PlannerIntent =
    | "debugging"
    | "refactor"
    | "feature"
    | "performance"
    | "testing"
    | "general";

export interface PlannerStep {
    id: number;
    title: string;
    detail: string;
}

export interface PlannerPlan {
    intent: PlannerIntent;
    objective: string;
    strategy: "diagnostic" | "incremental" | "refactor" | "delivery";
    constraints: string[];
    risks: string[];
    steps: PlannerStep[];
}

export interface PlannerOptions {
    context?: string;
    maxSteps?: number;
}

function detectIntent(text: string): PlannerIntent {
    const lowered = text.toLowerCase();

    if (/(error|exception|failing|crash|debug)/.test(lowered)) {
        return "debugging";
    }
    if (/(refactor|cleanup|rewrite|modulari[sz]e|simplif)/.test(lowered)) {
        return "refactor";
    }
    if (/(feature|implement|add|support|introduce)/.test(lowered)) {
        return "feature";
    }
    if (/(performance|optimi[sz]e|latency|throughput|slow)/.test(lowered)) {
        return "performance";
    }
    if (/(test|spec|coverage|regression)/.test(lowered)) {
        return "testing";
    }

    return "general";
}

function buildBaseSteps(intent: PlannerIntent): Array<{ title: string; detail: string }> {
    if (intent === "debugging") {
        return [
            {
                title: "Reproduce and isolate",
                detail: "Capture a deterministic repro and isolate the smallest failing path."
            },
            {
                title: "Inspect signals",
                detail: "Use logs, stack traces, and memory anchors to identify likely root causes."
            },
            {
                title: "Patch incrementally",
                detail: "Implement a narrow fix, then verify with targeted regression tests."
            }
        ];
    }

    if (intent === "refactor") {
        return [
            {
                title: "Define invariants",
                detail: "Preserve public behavior and identify contracts that cannot change."
            },
            {
                title: "Split and extract",
                detail: "Break large units into focused modules with explicit boundaries."
            },
            {
                title: "Validate parity",
                detail: "Run existing tests and add coverage for modified control flow."
            }
        ];
    }

    if (intent === "feature") {
        return [
            {
                title: "Define acceptance criteria",
                detail: "Translate request into measurable behavior and edge cases."
            },
            {
                title: "Implement minimal vertical slice",
                detail: "Ship the smallest end-to-end behavior before broadening scope."
            },
            {
                title: "Expand safely",
                detail: "Iterate with tests, telemetry, and backward-compatible interfaces."
            }
        ];
    }

    if (intent === "performance") {
        return [
            {
                title: "Profile hotspots",
                detail: "Measure bottlenecks before optimization to avoid premature tuning."
            },
            {
                title: "Optimize dominant path",
                detail: "Target the largest cost center with algorithmic or data-structure improvements."
            },
            {
                title: "Verify gains",
                detail: "Re-measure and ensure correctness remains intact under representative load."
            }
        ];
    }

    if (intent === "testing") {
        return [
            {
                title: "Map risk boundaries",
                detail: "Prioritize brittle paths and integration seams for deeper validation."
            },
            {
                title: "Add focused tests",
                detail: "Cover high-risk behavior with deterministic assertions and fixtures."
            },
            {
                title: "Automate regression loop",
                detail: "Ensure tests run in CI and gate merges for repeated confidence."
            }
        ];
    }

    return [
        {
            title: "Clarify objective",
            detail: "Convert request into explicit outcomes and constraints."
        },
        {
            title: "Execute in bounded steps",
            detail: "Implement iteratively and validate each change before proceeding."
        },
        {
            title: "Close with verification",
            detail: "Summarize outcomes and capture follow-up actions."
        }
    ];
}

function inferStrategy(intent: PlannerIntent): PlannerPlan["strategy"] {
    if (intent === "debugging") {
        return "diagnostic";
    }
    if (intent === "refactor") {
        return "refactor";
    }
    if (intent === "feature") {
        return "delivery";
    }
    return "incremental";
}

function buildConstraints(intent: PlannerIntent, context?: string): string[] {
    const constraints = ["token-bounded context", "small reversible changes"];

    if (intent === "refactor") {
        constraints.push("preserve public behavior");
    }

    if (intent === "performance") {
        constraints.push("measure before and after optimization");
    }

    if (intent === "debugging") {
        constraints.push("reproduce before patching");
    }

    const loweredContext = context?.toLowerCase() ?? "";
    if (loweredContext.includes("backward") || loweredContext.includes("compat")) {
        constraints.push("maintain backward compatibility");
    }

    return [...new Set(constraints)];
}

function buildRisks(intent: PlannerIntent): string[] {
    const risks = ["regression risk in related modules"];

    if (intent === "refactor") {
        risks.push("behavior drift due to interface changes");
    }
    if (intent === "performance") {
        risks.push("micro-optimizations without real impact");
    }
    if (intent === "feature") {
        risks.push("scope creep and incomplete acceptance criteria");
    }
    if (intent === "debugging") {
        risks.push("fixing symptoms instead of root cause");
    }

    return [...new Set(risks)];
}

export function plannerAgent(query: string, options: PlannerOptions = {}): PlannerPlan {
    const objective = query.trim();
    const intent = detectIntent(objective);
    const maxSteps = Math.max(3, Math.min(12, Math.trunc(options.maxSteps ?? 6)));

    const baseSteps = buildBaseSteps(intent)
        .slice(0, maxSteps)
        .map((step, index) => ({
            id: index + 1,
            title: step.title,
            detail: step.detail
        }));

    return {
        intent,
        objective,
        strategy: inferStrategy(intent),
        constraints: buildConstraints(intent, options.context),
        risks: buildRisks(intent),
        steps: baseSteps
    };
}
