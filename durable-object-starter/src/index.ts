import type { AgentConfiguration } from "./internal/types";
import { DurableObject } from "cloudflare:workers";
import {
	clearHistory as clearAgentHistory,
	sendPrompt as sendAgentPrompt,
} from "./internal/agent-chat";
import {
	closeEventStream,
	connectUser as connectAgentUser,
	disconnectUser as disconnectAgentUser,
	getConnectedUsers,
	heartbeatUser,
	openEventStream,
} from "./internal/agent-connections";
import { AgentRuntime } from "./internal/agent-runtime";
import {
	configureTools as configureAgentTools,
	executeTool as executeAgentTool,
	getToolConfig,
} from "./internal/agent-tools";
import {
	acquirePromptLock as acquireAgentPromptLock,
	handlePromptSessionAlarm,
	releasePromptLock as releaseAgentPromptLock,
	updatePromptDraft as updateAgentPromptDraft,
} from "./internal/prompt-session";
import type {
	AgentToolConfig,
	AppEnv,
	ComposerDraft,
	ComposerLock,
	ConnectedUser,
	ImageAttachment,
	PromptImageAttachment,
} from "./internal/types";

export { default } from "./internal/outer-worker";

export class AgentDurableObject extends DurableObject<AppEnv> {
	private readonly runtime: AgentRuntime;

	constructor(ctx: DurableObjectState, env: AppEnv) {
		super(ctx, env);
		this.runtime = new AgentRuntime(ctx, env);
	}

	// Tools

	async configureTools(
		composioSessionId: string,
		enabledTools: string[],
	): Promise<AgentToolConfig> {
		return await configureAgentTools(this.runtime, composioSessionId, enabledTools);
	}

	async getToolConfig(): Promise<AgentToolConfig | null> {
		return await getToolConfig(this.runtime);
	}

	async executeTool(tool: string, arguments_: Record<string, unknown>) {
		return await executeAgentTool(this.runtime, tool, arguments_);
	}

	// Connections

	async connectUser(name: string): Promise<ConnectedUser> {
		return await connectAgentUser(this.runtime, name);
	}

	async heartbeatUser(connectionId: string): Promise<void> {
		await heartbeatUser(this.runtime, connectionId);
	}

	async disconnectUser(connectionId: string): Promise<void> {
		await disconnectAgentUser(this.runtime, connectionId);
	}

	async getConnectedUsers(): Promise<ConnectedUser[]> {
		return await getConnectedUsers(this.runtime);
	}

	// Events

	async fetch(request: Request): Promise<Response> {
		return await openEventStream(this.runtime, request);
	}

	async webSocketClose(socket: WebSocket): Promise<void> {
		await closeEventStream(this.runtime, socket);
	}

	async webSocketError(socket: WebSocket): Promise<void> {
		await closeEventStream(this.runtime, socket);
	}

	// Shared prompt

	async acquirePromptLock(
		connectionId: string,
		leaseId: string,
		startedAt: number,
	): Promise<ComposerLock> {
		return await acquireAgentPromptLock(
			this.runtime.promptSession(),
			connectionId,
			leaseId,
			startedAt,
		);
	}

	async releasePromptLock(connectionId: string, leaseId?: string): Promise<void> {
		await releaseAgentPromptLock(this.runtime.promptSession(), connectionId, leaseId);
	}

	async updatePromptDraft(
		connectionId: string,
		leaseId: string,
		text: string,
		sequence: number,
		attachments?: ImageAttachment[],
	): Promise<ComposerDraft> {
		return await updateAgentPromptDraft(
			this.runtime.promptSession(),
			connectionId,
			leaseId,
			text,
			sequence,
			attachments,
		);
	}

	async alarm(): Promise<void> {
		await handlePromptSessionAlarm(this.runtime.promptSession());
	}

	// Chat

	async clearHistory(): Promise<string[]> {
		return await clearAgentHistory(this.runtime);
	}

	async sendPrompt(
		prompt: string,
		connectionId?: string,
		composerLeaseId?: string,
		attachments: PromptImageAttachment[] = [],
		configuration?: AgentConfiguration,
	): Promise<string> {
		return await sendAgentPrompt(
			this.runtime,
			prompt,
			connectionId,
			composerLeaseId,
			attachments,
			configuration,
		);
	}
}
