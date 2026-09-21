import { snapshotEvents } from "./agent-events.js"
import type { AgentRuntime } from "./agent-runtime.js"
import { currentPromptDraft, currentPromptLock, releasePromptLock } from "./prompt-session.js"
import type { AgentEvent, ConnectedUser, StoredConnectedUser } from "./types.js"

const CONNECTION_TTL_MS = 90_000

export async function connectUser(runtime: AgentRuntime, name: string): Promise<ConnectedUser> {
    const cleanName = name.trim()
    if (!cleanName) throw new Error("A user name is required")
    if (cleanName.length > 40) throw new Error("User names must be 40 characters or fewer")

    const existingUser = (await runtime.store.connectedUsers()).find(user => user.name === cleanName)
    if (existingUser) {
        return publicUser(await runtime.store.touchConnectedUser(existingUser.connectionId))
    }

    const user: StoredConnectedUser = {
        connectionId: crypto.randomUUID(),
        name: cleanName,
        connectedAt: Date.now(),
        lastSeenAt: Date.now()
    }
    await runtime.store.saveConnectedUser(user)
    await broadcastConnectedUsers(runtime)
    return publicUser(user)
}

export async function heartbeatUser(runtime: AgentRuntime, connectionId: string): Promise<void> {
    await runtime.store.touchConnectedUser(connectionId)
}

export async function disconnectUser(runtime: AgentRuntime, connectionId: string): Promise<void> {
    await releasePromptLock(runtime.promptSession(), connectionId)
    await runtime.store.deleteConnectedUser(connectionId)
    await broadcastConnectedUsers(runtime)
}

export async function getConnectedUsers(runtime: AgentRuntime): Promise<ConnectedUser[]> {
    await pruneDisconnectedUsers(runtime)
    return (await runtime.store.connectedUsers()).map(publicUser)
}

export async function closeEventStream(
    runtime: AgentRuntime,
    connectionId: string | null,
    socketId: string
): Promise<void> {
    if (!connectionId) return
    const sockets = await runtime.connections()
    if (sockets.some(socket => socket.id !== socketId && socket.metadata.connectionId === connectionId)) return
    const deleted = await runtime.store.deleteConnectedUser(connectionId)
    if (deleted) {
        await releasePromptLock(runtime.promptSession(), connectionId)
        await broadcastConnectedUsers(runtime)
    }
}

export function publicUser(user: ConnectedUser): ConnectedUser {
    return {
        connectionId: user.connectionId,
        name: user.name,
        connectedAt: user.connectedAt
    }
}

export async function currentSnapshotEvents(runtime: AgentRuntime): Promise<AgentEvent[]> {
    const messages = await runtime.store.messages()
    const connectedUsers = await getConnectedUsers(runtime)
    const promptLock = await currentPromptLock(runtime.promptSession())
    const promptDraft = await currentPromptDraft(runtime.store)
    return snapshotEvents({
        messages,
        connectedUsers,
        promptLock,
        promptDraft,
        activeGeneration: runtime.activeGeneration()
    })
}

async function broadcastConnectedUsers(runtime: AgentRuntime): Promise<void> {
    runtime.broadcast({ type: "connected_users", users: await getConnectedUsers(runtime) })
}

async function pruneDisconnectedUsers(runtime: AgentRuntime): Promise<void> {
    const liveConnectionIds = new Set((await runtime.connections()).map(socket => socket.metadata.connectionId))
    const now = Date.now()
    const staleConnectionIds = (await runtime.store.connectedUsers())
        .filter(
            user =>
                !liveConnectionIds.has(user.connectionId) &&
                now - (user.lastSeenAt ?? user.connectedAt) > CONNECTION_TTL_MS
        )
        .map(user => user.connectionId)

    if (staleConnectionIds.length === 0) return
    await runtime.store.deleteConnectedUsers(staleConnectionIds)
    const lock = await currentPromptLock(runtime.promptSession())
    if (lock && staleConnectionIds.includes(lock.user.connectionId)) {
        await releasePromptLock(runtime.promptSession(), lock.user.connectionId)
    }
}
