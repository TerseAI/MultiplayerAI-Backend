import type { AgentStore } from "./agent-store.js"
import type {
    ComposerDraft,
    ComposerDraftEvent,
    ComposerLock,
    ComposerLockEvent,
    ConnectedUser,
    ImageAttachment
} from "./types.js"
import { MAX_PROMPT_IMAGES, MAX_PROMPT_LENGTH, validIdentifier, validImageAttachment } from "./validation.js"

const PROMPT_LOCK_TTL_MS = 20_000

export type PromptSessionDependencies = {
    store: AgentStore
    isGenerating: () => boolean
    emit: (event: ComposerLockEvent | ComposerDraftEvent) => void
}

export async function acquirePromptLock(
    dependencies: PromptSessionDependencies,
    connectionId: string,
    leaseId: string,
    startedAt: number
): Promise<ComposerLock> {
    if (dependencies.isGenerating()) {
        throw new Error("Wait for the current response to finish before editing")
    }
    if (!validIdentifier(leaseId)) throw new Error("That composer lease is invalid")
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0) {
        throw new Error("That composer lease start time is invalid")
    }

    const user = await dependencies.store.touchConnectedUser(connectionId)
    const current = await currentPromptLock(dependencies)
    if (current && current.user.connectionId !== connectionId) return current
    if (current && current.leaseId !== leaseId && current.startedAt >= startedAt) return current

    const lock: ComposerLock = {
        leaseId,
        startedAt: current?.leaseId === leaseId ? current.startedAt : startedAt,
        user: publicUser(user),
        expiresAt: Date.now() + PROMPT_LOCK_TTL_MS
    }
    await dependencies.store.savePromptLock(lock)
    dependencies.emit({ type: "composer_lock", lock })
    return lock
}

export async function releasePromptLock(
    dependencies: PromptSessionDependencies,
    connectionId: string,
    leaseId?: string
): Promise<void> {
    const current = await currentPromptLock(dependencies)
    if (!current || current.user.connectionId !== connectionId) return
    if (leaseId && current.leaseId !== leaseId) return

    await clearPromptLock(dependencies)
}

export async function updatePromptDraft(
    dependencies: PromptSessionDependencies,
    connectionId: string,
    leaseId: string,
    text: string,
    sequence: number,
    attachments?: ImageAttachment[]
): Promise<ComposerDraft> {
    if (!validIdentifier(leaseId)) throw new Error("That composer lease is invalid")
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new Error("That composer draft sequence is invalid")
    }
    if (text.length > MAX_PROMPT_LENGTH) {
        throw new Error(`Prompts must be ${MAX_PROMPT_LENGTH} characters or fewer`)
    }
    if (attachments && (attachments.length > MAX_PROMPT_IMAGES || !attachments.every(validImageAttachment))) {
        throw new Error(`Attach up to ${MAX_PROMPT_IMAGES} uploaded images`)
    }
    await dependencies.store.touchConnectedUser(connectionId)

    const lock = await currentPromptLock(dependencies)
    if (!lock || lock.user.connectionId !== connectionId || lock.leaseId !== leaseId) {
        throw new Error(lock ? `${lock.user.name} is editing the prompt` : "Reserve the composer before editing")
    }

    const current = await currentPromptDraft(dependencies.store)
    if (current.leaseId === leaseId && current.sequence >= sequence) return current

    const draft: ComposerDraft = {
        leaseId,
        sequence,
        text,
        attachments: attachments ?? current.attachments,
        updatedAt: Date.now()
    }
    await dependencies.store.savePromptDraft(draft)
    dependencies.emit({ type: "composer_draft", draft })
    return draft
}

export async function currentPromptDraft(store: AgentStore): Promise<ComposerDraft> {
    const stored = await store.promptDraft()
    return stored
        ? {
              ...stored,
              attachments: Array.isArray(stored.attachments) ? stored.attachments.filter(validImageAttachment) : []
          }
        : emptyPromptDraft()
}

export async function clearPromptDraft(dependencies: PromptSessionDependencies, leaseId: string): Promise<void> {
    const current = await currentPromptDraft(dependencies.store)
    const draft: ComposerDraft = {
        leaseId,
        sequence: current.leaseId === leaseId ? current.sequence + 1 : 1,
        text: "",
        attachments: [],
        updatedAt: Date.now()
    }
    await dependencies.store.savePromptDraft(draft)
    dependencies.emit({ type: "composer_draft", draft })
}

export async function currentPromptLock(dependencies: PromptSessionDependencies): Promise<ComposerLock | null> {
    const lock = await dependencies.store.promptLock()
    if (!lock) return null
    if (lock.expiresAt > Date.now()) return lock

    await clearPromptLock(dependencies)
    return null
}

export function assertOwnsPromptLock(
    lock: ComposerLock | null,
    user: ConnectedUser,
    connectionId?: string,
    leaseId?: string
): void {
    if (!connectionId) return
    if (lock && lock.user.connectionId === user.connectionId && lock.leaseId === leaseId) return

    throw new Error(lock ? `${lock.user.name} is editing the prompt` : "Reserve the composer before sending")
}

function emptyPromptDraft(): ComposerDraft {
    return {
        leaseId: null,
        sequence: 0,
        text: "",
        attachments: [],
        updatedAt: 0
    }
}

async function clearPromptLock(dependencies: PromptSessionDependencies): Promise<void> {
    await dependencies.store.deletePromptLock()
    dependencies.emit({ type: "composer_lock", lock: null })
}

function publicUser(user: ConnectedUser): ConnectedUser {
    return {
        connectionId: user.connectionId,
        name: user.name,
        connectedAt: user.connectedAt
    }
}
