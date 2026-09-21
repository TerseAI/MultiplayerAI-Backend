import type { AgentToolConfig, ChatMessage, ComposerDraft, ComposerLock, StoredConnectedUser } from "./types.js"

export type AgentState = {
    toolConfig: AgentToolConfig | null
    users: StoredConnectedUser[]
    messages: ChatMessage[]
    promptLock: ComposerLock | null
    promptDraft: ComposerDraft | null
}

export function emptyAgentState(): AgentState {
    return { toolConfig: null, users: [], messages: [], promptLock: null, promptDraft: null }
}

export class AgentStore {
    constructor(private readonly state: () => AgentState) {}

    async toolConfig(): Promise<AgentToolConfig | null> {
        return this.state().toolConfig
    }
    async saveToolConfig(config: AgentToolConfig): Promise<void> {
        this.state().toolConfig = config
    }
    async connectedUser(connectionId: string): Promise<StoredConnectedUser | null> {
        return this.state().users.find(user => user.connectionId === connectionId) ?? null
    }
    async connectedUsers(): Promise<StoredConnectedUser[]> {
        return [...this.state().users].sort((left, right) => left.connectedAt - right.connectedAt)
    }
    async saveConnectedUser(user: StoredConnectedUser): Promise<void> {
        const state = this.state()
        state.users = [...state.users.filter(existing => existing.connectionId !== user.connectionId), user]
    }
    async touchConnectedUser(connectionId: string): Promise<StoredConnectedUser> {
        const user = await this.connectedUser(connectionId)
        if (!user) throw new Error("That connection is no longer active")
        const refreshed = { ...user, lastSeenAt: Date.now() }
        await this.saveConnectedUser(refreshed)
        return refreshed
    }
    async deleteConnectedUser(connectionId: string): Promise<boolean> {
        const state = this.state()
        const before = state.users.length
        state.users = state.users.filter(user => user.connectionId !== connectionId)
        return state.users.length !== before
    }
    async deleteConnectedUsers(connectionIds: string[]): Promise<void> {
        const state = this.state()
        state.users = state.users.filter(user => !connectionIds.includes(user.connectionId))
    }
    async messages(): Promise<ChatMessage[]> {
        return [...this.state().messages]
    }
    async saveMessage(message: ChatMessage): Promise<void> {
        const state = this.state()
        state.messages = [...state.messages.filter(existing => existing.id !== message.id), message].sort(
            compareMessages
        )
    }
    async deleteMessages(): Promise<ChatMessage[]> {
        const state = this.state()
        const messages = state.messages
        state.messages = []
        return messages
    }
    async promptLock(): Promise<ComposerLock | null> {
        return this.state().promptLock
    }
    async savePromptLock(lock: ComposerLock): Promise<void> {
        this.state().promptLock = lock
    }
    async deletePromptLock(): Promise<void> {
        this.state().promptLock = null
    }
    async promptDraft(): Promise<ComposerDraft | null> {
        return this.state().promptDraft
    }
    async savePromptDraft(draft: ComposerDraft): Promise<void> {
        this.state().promptDraft = draft
    }
}

function compareMessages(left: ChatMessage, right: ChatMessage): number {
    return (
        left.createdAt - right.createdAt ||
        Number(left.role === "assistant") - Number(right.role === "assistant") ||
        left.id.localeCompare(right.id)
    )
}
