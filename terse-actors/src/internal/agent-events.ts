import type { ActiveGeneration, AgentEvent, ChatMessage, ComposerDraft, ComposerLock, ConnectedUser } from "./types.js"

export type AgentSnapshot = {
    messages: ChatMessage[]
    connectedUsers: ConnectedUser[]
    promptLock: ComposerLock | null
    promptDraft: ComposerDraft
    activeGeneration: ActiveGeneration | null
}

export function snapshotEvents(snapshot: AgentSnapshot): AgentEvent[] {
    const messages = [...snapshot.messages]
    if (snapshot.activeGeneration) {
        messages.push({
            ...snapshot.activeGeneration.message,
            text: snapshot.activeGeneration.text,
            reasoning: snapshot.activeGeneration.reasoning
        })
    }

    return [
        { type: "history", messages },
        { type: "connected_users", users: snapshot.connectedUsers },
        { type: "composer_lock", lock: snapshot.promptLock },
        { type: "composer_draft", draft: snapshot.promptDraft }
    ]
}
