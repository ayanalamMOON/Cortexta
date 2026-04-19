import { agentBus } from "../agent-bus/bus";
import { makeDelta, type StreamDelta } from "./delta-protocol";

function nextStep(): number {
    return Math.max(1, Date.now());
}

export function emitDaemonStreamEvent(params: {
    projectId?: string;
    eventType: "contextSuggested" | "branchSwitched" | "agentStatus" | "sessionResurrectionStatus";
    payload: Record<string, unknown>;
    sessionId?: string;
}): StreamDelta {
    const delta = makeDelta({
        sessionId: params.sessionId ?? `daemon-${params.eventType}-${Date.now().toString(36)}`,
        projectId: params.projectId,
        step: nextStep(),
        deltaType: "append",
        payload: {
            eventType: params.eventType,
            ...params.payload
        }
    });

    agentBus.emitEvent("stream:delta", delta);
    return delta;
}
