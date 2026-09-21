import type { AgentConfiguration } from "./types.js"
import { publicUser } from "./agent-connections.js"
import type { AgentRuntime } from "./agent-runtime.js"
import { modelTools } from "./agent-tools.js"
import { assertOwnsPromptLock, clearPromptDraft, currentPromptLock, releasePromptLock } from "./prompt-session.js"
import type { ChatMessage, ConnectedUser, PromptGeneration, PromptImageAttachment } from "./types.js"

export async function clearHistory(runtime: AgentRuntime): Promise<string[]> {
    if (runtime.operation?.type === "generating") {
        throw new Error("Wait for the current response to finish before clearing history")
    }
    if (runtime.operation?.type === "clearing_history") {
        throw new Error("Chat history is already being cleared")
    }

    runtime.operation = { type: "clearing_history" }
    try {
        const messages = await runtime.store.deleteMessages()
        const attachmentIds = [
            ...new Set(messages.flatMap(message => (message.attachments ?? []).map(attachment => attachment.id)))
        ]
        runtime.broadcast({ type: "history", messages: [] })
        return attachmentIds
    } finally {
        if (runtime.operation?.type === "clearing_history") runtime.operation = null
    }
}

export async function sendPrompt(
    runtime: AgentRuntime,
    prompt: string,
    connectionId?: string,
    composerLeaseId?: string,
    attachments: PromptImageAttachment[] = [],
    configuration?: AgentConfiguration
): Promise<string> {
    const apiKey = runtime.env.OPEN_ROUTER_API_KEY
    if (!apiKey) throw new Error("Missing OPEN_ROUTER_API_KEY")

    const generation = await beginGeneration(runtime, prompt, connectionId, composerLeaseId, attachments)

    try {
        const result = await runtime.generate({
            apiKey,
            modelId: runtime.env.OPEN_ROUTER_MODEL,
            tools: await modelTools(runtime, configuration ? { ...configuration, updatedAt: 0 } : undefined),
            systemPrompt: configuration?.systemPrompt,
            prompt: generation.prompt,
            attachments,
            onReasoningDelta: delta => {
                receiveGenerationDelta(runtime, generation.generationId, "reasoning", delta)
            },
            onTextDelta: delta => {
                receiveGenerationDelta(runtime, generation.generationId, "text", delta)
            }
        })
        await storeAssistantMessage(runtime, generation, result.text, result.reasoning, "complete")
        runtime.broadcast({
            type: "generation_completed",
            generationId: generation.generationId,
            ...result
        })
        return result.text
    } catch (error) {
        const activeGeneration = runtime.activeGeneration()
        const text = activeGeneration?.text || "Request failed."
        const reasoning = activeGeneration?.reasoning ?? ""
        await storeAssistantMessage(runtime, generation, text, reasoning, "failed")
        runtime.broadcast({
            type: "generation_failed",
            generationId: generation.generationId,
            message: errorMessage(error)
        })
        throw error
    } finally {
        runtime.finishGeneration(generation.generationId)
    }
}

async function beginGeneration(
    runtime: AgentRuntime,
    prompt: string,
    connectionId: string | undefined,
    composerLeaseId: string | undefined,
    attachments: PromptImageAttachment[]
): Promise<PromptGeneration> {
    assertCanStartGeneration(runtime)
    const cleanPrompt = prompt.trim()
    if (!cleanPrompt) throw new Error("A prompt is required")

    const storedUser = connectionId ? await runtime.store.touchConnectedUser(connectionId) : null
    const user = storedUser ? publicUser(storedUser) : directAPIUser()
    const promptSession = runtime.promptSession()
    const lock = await currentPromptLock(promptSession)
    assertOwnsPromptLock(lock, user, connectionId, composerLeaseId)

    // RPC calls can interleave at awaits, so claim the transient operation before awaiting again.
    assertCanStartGeneration(runtime)
    const generation = promptGeneration(cleanPrompt, user, attachments)
    runtime.operation = {
        type: "generating",
        generation: { message: generation.assistantMessage, text: "", reasoning: "" }
    }
    try {
        if (lock && connectionId) {
            await clearPromptDraft(promptSession, lock.leaseId)
            await releasePromptLock(promptSession, user.connectionId, lock.leaseId)
        }
        await runtime.store.saveMessage(generation.userMessage)
        runtime.broadcast({
            type: "generation_started",
            generationId: generation.generationId,
            prompt: generation.prompt,
            user: generation.user,
            createdAt: generation.userMessage.createdAt,
            attachments: generation.attachments
        })
        return generation
    } catch (error) {
        runtime.finishGeneration(generation.generationId)
        throw error
    }
}

function receiveGenerationDelta(
    runtime: AgentRuntime,
    generationId: string,
    kind: "reasoning" | "text",
    delta: string
): void {
    const active = runtime.activeGeneration()
    if (!active || active.message.id !== generationId) return

    if (kind === "reasoning") {
        active.reasoning += delta
        runtime.broadcast({ type: "reasoning_delta", generationId, delta })
    } else {
        active.text += delta
        runtime.broadcast({ type: "text_delta", generationId, delta })
    }
}

async function storeAssistantMessage(
    runtime: AgentRuntime,
    generation: PromptGeneration,
    text: string,
    reasoning: string,
    status: "complete" | "failed"
): Promise<void> {
    await runtime.store.saveMessage({
        ...generation.assistantMessage,
        text,
        reasoning,
        status
    } satisfies ChatMessage)
}

function assertCanStartGeneration(runtime: AgentRuntime): void {
    if (runtime.operation?.type === "clearing_history") {
        throw new Error("Wait for chat history to finish clearing before sending a prompt")
    }
    if (runtime.operation?.type === "generating") {
        throw new Error("The agent is already generating")
    }
}

function directAPIUser(): ConnectedUser {
    return { connectionId: "direct", name: "Direct API", connectedAt: Date.now() }
}

function promptGeneration(prompt: string, user: ConnectedUser, attachments: PromptImageAttachment[]): PromptGeneration {
    const generationId = crypto.randomUUID()
    const createdAt = Date.now()
    const storedAttachments = attachments.map(({ dataUrl: _dataUrl, ...attachment }) => attachment)
    const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        author: user.name,
        text: prompt,
        createdAt,
        status: "complete",
        attachments: storedAttachments
    }
    const assistantMessage: ChatMessage = {
        id: generationId,
        role: "assistant",
        author: "Cloud Agent",
        text: "",
        createdAt,
        status: "streaming"
    }

    return {
        generationId,
        prompt,
        user,
        attachments: storedAttachments,
        userMessage,
        assistantMessage
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unexpected generation error"
}
