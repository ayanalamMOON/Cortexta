import type { PlannerPlan } from "./planner.agent";

export interface RefactorSuggestion {
    title: string;
    rationale: string;
    actions: string[];
    tests: string[];
    risks: string[];
    transformedSummary: string;
}

export interface RefactorAgentInput {
    text: string;
    plan?: PlannerPlan;
    memoryAnchors?: string[];
}

function compactSummary(text: string, maxChars = 280): string {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length <= maxChars) {
        return clean;
    }
    return `${clean.slice(0, maxChars - 1).trimEnd()}…`;
}

function buildActions(text: string, plan?: PlannerPlan): string[] {
    const lowered = text.toLowerCase();
    const actions: string[] = [];

    if (lowered.includes("duplicate") || lowered.includes("redundant")) {
        actions.push("Extract duplicated logic into a shared utility with a stable interface.");
    }
    if (lowered.includes("long") || lowered.includes("complex") || lowered.includes("nested")) {
        actions.push("Split large or nested control flow into focused helper functions.");
    }
    if (lowered.includes("state") || lowered.includes("mutable")) {
        actions.push("Isolate mutable state behind explicit invariants and transition helpers.");
    }
    if (lowered.includes("recursion") || lowered.includes("stack")) {
        actions.push("Evaluate iterative or memoized strategy to reduce recursion overhead.");
    }
    if (lowered.includes("error") || lowered.includes("exception")) {
        actions.push("Normalize error handling boundaries and propagate typed failures consistently.");
    }

    if (plan?.intent === "refactor") {
        actions.push("Preserve external behavior while improving internal structure.");
    }

    if (actions.length === 0) {
        actions.push("Apply small, behavior-preserving refactors around the highest-friction area first.");
    }

    return [...new Set(actions)].slice(0, 8);
}

function buildTests(plan?: PlannerPlan): string[] {
    const tests = [
        "Run existing unit and integration tests before and after each change.",
        "Add regression tests for modified branching and error paths."
    ];

    if (plan?.intent === "performance") {
        tests.push("Add benchmark/assertion checks for key latency or throughput paths.");
    }

    if (plan?.intent === "debugging") {
        tests.push("Capture failing reproduction as a dedicated regression test.");
    }

    return [...new Set(tests)];
}

function buildRisks(plan?: PlannerPlan): string[] {
    const risks = ["Behavior drift in indirectly-coupled modules."];
    if (plan?.intent === "refactor") {
        risks.push("Breaking implicit contracts relied upon by callers.");
    }
    if (plan?.intent === "performance") {
        risks.push("Trading readability for negligible performance gain.");
    }
    return [...new Set(risks)];
}

export function refactorAgent(input: RefactorAgentInput): RefactorSuggestion {
    const plan = input.plan;
    const anchors = (input.memoryAnchors ?? []).filter((anchor) => anchor.trim().length > 0);
    const actions = buildActions(input.text, plan);
    const rationale = plan
        ? `Plan intent=${plan.intent}, strategy=${plan.strategy}. Apply refactor incrementally with explicit checkpoints.`
        : "No explicit planner output provided; using heuristic refactor strategy.";

    const anchorSuffix = anchors.length > 0
        ? ` Anchors: ${anchors.slice(0, 3).join(" | ")}`
        : "";

    return {
        title: "Refactor execution recommendation",
        rationale,
        actions,
        tests: buildTests(plan),
        risks: buildRisks(plan),
        transformedSummary: compactSummary(`${input.text}${anchorSuffix}`)
    };
}
