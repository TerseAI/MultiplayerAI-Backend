import type { AgentGenerationRunner } from "./agent-generation.js"
import type { AgentStore } from "./agent-store.js"
import type { PromptSessionDependencies } from "./prompt-session.js"
import type { ActiveGeneration, AgentEvent, AppEnv, EventSocketAttachment } from "./types.js"

type AgentOperation = { type: "generating"; generation: ActiveGeneration } | { type: "clearing_history" } | null

type EventConnection = { readonly id: string; readonly metadata: EventSocketAttachment }

export class AgentRuntime {
    operation: AgentOperation = null

    constructor(
        readonly store: AgentStore,
        readonly env: AppEnv,
        readonly connections: () => Promise<readonly EventConnection[]>,
        readonly broadcast: (event: AgentEvent) => void,
        readonly generate: AgentGenerationRunner
    ) {}

    promptSession(): PromptSessionDependencies {
        return {
            store: this.store,
            isGenerating: () => this.operation?.type === "generating",
            emit: event => this.broadcast(event)
        }
    }
    activeGeneration(): ActiveGeneration | null {
        return this.operation?.type === "generating" ? this.operation.generation : null
    }
    finishGeneration(generationId: string): void {
        if (this.activeGeneration()?.message.id === generationId) this.operation = null
    }
}
