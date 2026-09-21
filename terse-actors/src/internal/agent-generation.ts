import { Agent, type AgentTool } from "@earendil-works/pi-agent-core"
import { createModels, type ImageContent } from "@earendil-works/pi-ai"
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter"
import type { PromptImageAttachment } from "./types.js"

export type AgentGenerationOptions = {
    apiKey: string
    modelId?: string
    tools: AgentTool[]
    prompt: string
    systemPrompt?: string
    attachments: PromptImageAttachment[]
    onReasoningDelta: (delta: string) => void
    onTextDelta: (delta: string) => void
}

export type AgentGenerationResult = {
    text: string
    reasoning: string
}

export async function runAgentGeneration({
    apiKey,
    modelId = "openai/gpt-5-nano",
    tools,
    systemPrompt = "",
    prompt,
    attachments,
    onReasoningDelta,
    onTextDelta
}: AgentGenerationOptions): Promise<AgentGenerationResult> {
    const models = createModels()
    models.setProvider(openrouterProvider())

    const model = models.getModel("openrouter", modelId)
    if (!model) throw new Error(`Unknown OpenRouter model: ${modelId}`)

    let text = ""
    let reasoning = ""
    const agent = new Agent({
        initialState: {
            model,
            systemPrompt,
            thinkingLevel: "medium",
            tools
        },
        streamFn: (selectedModel, context, options) =>
            models.streamSimple(selectedModel, context, { ...options, apiKey }),
        toolExecution: "sequential"
    })

    agent.subscribe(event => {
        if (event.type !== "message_update") return

        const update = event.assistantMessageEvent
        if (update.type === "thinking_delta") {
            reasoning += update.delta
            onReasoningDelta(update.delta)
        } else if (update.type === "text_delta") {
            text += update.delta
            onTextDelta(update.delta)
        }
    })

    await agent.prompt(prompt, attachments.map(imageContent))
    if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)

    return { text, reasoning }
}

function imageContent(attachment: PromptImageAttachment): ImageContent {
    const prefix = `data:${attachment.mimeType};base64,`
    if (!attachment.dataUrl.startsWith(prefix)) {
        throw new Error(`Invalid image data for ${attachment.name}`)
    }
    return {
        type: "image",
        data: attachment.dataUrl.slice(prefix.length),
        mimeType: attachment.mimeType
    }
}

export type AgentGenerationRunner = (options: AgentGenerationOptions) => Promise<AgentGenerationResult>
