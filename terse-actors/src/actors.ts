import { Actor, Ephemeral, Persisted, Reentrant, type ActorSocket } from "terse-sdk"
import { clearHistory as clearAgentHistory, sendPrompt as sendAgentPrompt } from "./internal/agent-chat.js"
import {
    closeEventStream,
    connectUser as connectAgentUser,
    currentSnapshotEvents,
    disconnectUser as disconnectAgentUser,
    getConnectedUsers,
    heartbeatUser
} from "./internal/agent-connections.js"
import { runAgentGeneration } from "./internal/agent-generation.js"
import { AgentRuntime } from "./internal/agent-runtime.js"
import { AgentStore, emptyAgentState, type AgentState } from "./internal/agent-store.js"
import {
    configureTools as configureAgentTools,
    executeTool as executeAgentTool,
    getToolConfig
} from "./internal/agent-tools.js"
import {
    acquirePromptLock as acquireAgentPromptLock,
    releasePromptLock as releaseAgentPromptLock,
    updatePromptDraft as updateAgentPromptDraft
} from "./internal/prompt-session.js"
import type {
    JsonValue,
    AgentConfiguration,
    AgentEvent,
    AgentToolConfig,
    AgentToolExecution,
    ComposerDraft,
    ComposerLock,
    ConnectedUser,
    EventSocketAttachment,
    ImageAttachment,
    PromptImageAttachment
} from "./internal/types.js"

export class Agent extends Actor<EventSocketAttachment, never, AgentEvent> {
    @Persisted private data: AgentState = emptyAgentState()
    @Ephemeral private runtime = new AgentRuntime(
        new AgentStore(() => this.data),
        process.env,
        () => this.getConnections(),
        event => this.broadcast(event),
        runAgentGeneration
    )

    async configureTools(composioSessionId: string, enabledTools: string[]): Promise<AgentToolConfig> {
        return configureAgentTools(this.runtime, composioSessionId, enabledTools)
    }
    async getToolConfig(): Promise<AgentToolConfig | null> {
        return getToolConfig(this.runtime)
    }
    async executeTool(tool: string, arguments_: Record<string, JsonValue>): Promise<AgentToolExecution> {
        return executeAgentTool(this.runtime, tool, arguments_)
    }
    async connectUser(name: string): Promise<ConnectedUser> {
        return connectAgentUser(this.runtime, name)
    }
    async heartbeatUser(connectionId: string): Promise<void> {
        await heartbeatUser(this.runtime, connectionId)
    }
    async disconnectUser(connectionId: string): Promise<void> {
        await disconnectAgentUser(this.runtime, connectionId)
    }
    async getConnectedUsers(): Promise<ConnectedUser[]> {
        return getConnectedUsers(this.runtime)
    }
    async getSnapshot(): Promise<AgentEvent[]> {
        return currentSnapshotEvents(this.runtime)
    }

    async onConnect(socket: ActorSocket<EventSocketAttachment, AgentEvent>): Promise<void> {
        const connectionId = socket.metadata.connectionId
        if (connectionId && !(await this.runtime.store.connectedUser(connectionId))) {
            socket.reject(1008, "That connection is no longer active")
            return
        }
        for (const event of await currentSnapshotEvents(this.runtime)) socket.send(event)
    }
    async onDisconnect(socket: ActorSocket<EventSocketAttachment, AgentEvent>): Promise<void> {
        await closeEventStream(this.runtime, socket.metadata.connectionId, socket.id)
    }
    async acquirePromptLock(connectionId: string, leaseId: string, startedAt: number): Promise<ComposerLock> {
        return acquireAgentPromptLock(this.runtime.promptSession(), connectionId, leaseId, startedAt)
    }
    async releasePromptLock(connectionId: string, leaseId?: string): Promise<void> {
        await releaseAgentPromptLock(this.runtime.promptSession(), connectionId, leaseId)
    }
    async updatePromptDraft(
        connectionId: string,
        leaseId: string,
        text: string,
        sequence: number,
        attachments?: ImageAttachment[]
    ): Promise<ComposerDraft> {
        return updateAgentPromptDraft(this.runtime.promptSession(), connectionId, leaseId, text, sequence, attachments)
    }
    async clearHistory(): Promise<string[]> {
        return clearAgentHistory(this.runtime)
    }

    @Reentrant
    async sendPrompt(
        prompt: string,
        connectionId?: string,
        composerLeaseId?: string,
        attachments: PromptImageAttachment[] = [],
        configuration?: AgentConfiguration
    ): Promise<string> {
        return sendAgentPrompt(this.runtime, prompt, connectionId, composerLeaseId, attachments, configuration)
    }
}
