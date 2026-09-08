import { broadcastAgentEvent } from "./agent-events";
import { AgentStore } from "./agent-store";
import type { PromptSessionDependencies } from "./prompt-session";
import type { ActiveGeneration, AgentEvent, AppEnv } from "./types";

type AgentOperation =
	| { type: "generating"; generation: ActiveGeneration }
	| { type: "clearing_history" }
	| null;

export class AgentRuntime {
	readonly store: AgentStore;
	operation: AgentOperation = null;

	constructor(
		readonly ctx: DurableObjectState,
		readonly env: AppEnv,
	) {
		this.store = new AgentStore(ctx.storage);
	}

	broadcast(event: AgentEvent): void {
		broadcastAgentEvent(this.ctx, event);
	}

	promptSession(): PromptSessionDependencies {
		return {
			store: this.store,
			isGenerating: () => this.operation?.type === "generating",
			emit: (event) => this.broadcast(event),
		};
	}

	activeGeneration(): ActiveGeneration | null {
		return this.operation?.type === "generating" ? this.operation.generation : null;
	}

	finishGeneration(generationId: string): void {
		if (this.activeGeneration()?.message.id === generationId) this.operation = null;
	}
}
