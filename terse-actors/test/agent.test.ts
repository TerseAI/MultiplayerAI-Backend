import assert from "node:assert/strict"
import { test } from "node:test"
import { AgentRuntime } from "../src/internal/agent-runtime.js"
import { AgentStore, emptyAgentState } from "../src/internal/agent-store.js"
import { sendPrompt, clearHistory } from "../src/internal/agent-chat.js"
import {
    connectUser,
    disconnectUser,
    getConnectedUsers,
    heartbeatUser,
    currentSnapshotEvents
} from "../src/internal/agent-connections.js"
import { acquirePromptLock, currentPromptLock, updatePromptDraft } from "../src/internal/prompt-session.js"
import type { AgentEvent } from "../src/internal/types.js"
import type { AgentGenerationRunner } from "../src/internal/agent-generation.js"

function deferred() {
    let resolve = () => {}
    const promise = new Promise<void>(done => {
        resolve = done
    })
    return { promise, resolve }
}

function setup(generate: AgentGenerationRunner) {
    const state = emptyAgentState()
    const events: AgentEvent[] = []
    const runtime = new AgentRuntime(
        new AgentStore(() => state),
        { OPEN_ROUTER_API_KEY: "test" },
        async () => [],
        event => events.push(event),
        generate
    )
    return { runtime, state, events }
}

test("a joining client sees live generation and heartbeats do not wait for it", async () => {
    const entered = deferred()
    const release = deferred()
    const { runtime, state, events } = setup(async options => {
        options.onReasoningDelta("Thinking")
        options.onTextDelta("Hello")
        entered.resolve()
        await release.promise
        options.onTextDelta(" world")
        return { text: "Hello world", reasoning: "Thinking" }
    })
    const alice = await connectUser(runtime, "Alice")
    const lease = await acquirePromptLock(runtime.promptSession(), alice.connectionId, "lease-1", Date.now())
    await updatePromptDraft(runtime.promptSession(), alice.connectionId, lease.leaseId, "Hi", 1)
    const generation = sendPrompt(runtime, "Hi", alice.connectionId, lease.leaseId)
    await entered.promise
    try {
        const bob = await connectUser(runtime, "Bob")
        await heartbeatUser(runtime, bob.connectionId)
        assert.equal((await getConnectedUsers(runtime)).length, 2)
        const history = (await currentSnapshotEvents(runtime)).find(event => event.type === "history")
        assert.ok(history?.type === "history")
        assert.equal(history.messages.at(-1)?.text, "Hello")
        assert.equal(history.messages.at(-1)?.status, "streaming")
        await assert.rejects(sendPrompt(runtime, "Second"), /already generating/)
        await assert.rejects(clearHistory(runtime), /current response/)
    } finally {
        release.resolve()
    }
    assert.equal(await generation, "Hello world")
    assert.equal(runtime.activeGeneration(), null)
    assert.equal(state.messages.at(-1)?.status, "complete")
    assert.ok(events.some(event => event.type === "generation_completed"))
})

test("failed generations preserve partial output and allow the next prompt", async () => {
    const { runtime, state, events } = setup(async options => {
        options.onTextDelta("Partial")
        throw new Error("model failed")
    })
    await assert.rejects(sendPrompt(runtime, "Hi"), /model failed/)
    assert.equal(runtime.activeGeneration(), null)
    assert.equal(state.messages.at(-1)?.text, "Partial")
    assert.equal(state.messages.at(-1)?.status, "failed")
    assert.ok(events.some(event => event.type === "generation_failed"))
    await assert.rejects(sendPrompt(runtime, "Try again"), /model failed/)
    assert.equal(state.messages.length, 4)
})

test("composer leases expire on access, reject stale drafts, and release on disconnect", async () => {
    const { runtime, state } = setup(async () => ({ text: "", reasoning: "" }))
    const alice = await connectUser(runtime, "Alice")
    const bob = await connectUser(runtime, "Bob")
    const first = await acquirePromptLock(runtime.promptSession(), alice.connectionId, "lease-1", Date.now())
    assert.equal(
        (await acquirePromptLock(runtime.promptSession(), bob.connectionId, "lease-2", Date.now())).leaseId,
        first.leaseId
    )
    await updatePromptDraft(runtime.promptSession(), alice.connectionId, first.leaseId, "New", 2)
    assert.equal(
        (await updatePromptDraft(runtime.promptSession(), alice.connectionId, first.leaseId, "Old", 1)).text,
        "New"
    )
    assert.ok(state.promptLock)
    state.promptLock.expiresAt = 0
    assert.equal(await currentPromptLock(runtime.promptSession()), null)
    await acquirePromptLock(runtime.promptSession(), bob.connectionId, "lease-2", Date.now())
    await disconnectUser(runtime, bob.connectionId)
    assert.equal(await currentPromptLock(runtime.promptSession()), null)
    assert.deepEqual(
        (await getConnectedUsers(runtime)).map(user => user.name),
        ["Alice"]
    )
})

test("the store follows hydrated state and returns attachment ids when clearing history", async () => {
    let state = emptyAgentState()
    const store = new AgentStore(() => state)
    state = {
        ...emptyAgentState(),
        messages: [
            {
                id: "image-message",
                role: "user",
                author: "Alice",
                text: "image",
                createdAt: 1,
                status: "complete",
                attachments: [
                    {
                        id: "image-1",
                        type: "image",
                        name: "image.png",
                        mimeType: "image/png",
                        size: 1,
                        url: "/v1/assets/image-1"
                    }
                ]
            }
        ]
    }
    const runtime = new AgentRuntime(
        store,
        {},
        async () => [],
        () => {},
        async () => ({ text: "", reasoning: "" })
    )
    assert.deepEqual(await clearHistory(runtime), ["image-1"])
    assert.deepEqual(state.messages, [])
})

test("prompt attachments and per-request model configuration retain the Durable Object contract", async () => {
    const attachment = {
        id: "image-1",
        type: "image" as const,
        name: "image.png",
        mimeType: "image/png" as const,
        size: 1,
        url: "/v1/assets/image-1",
        dataUrl: "data:image/png;base64,YQ=="
    }
    const { runtime, state } = setup(async options => {
        assert.equal(options.systemPrompt, "Be concise")
        assert.deepEqual(options.attachments, [attachment])
        assert.deepEqual(options.tools, [])
        return { text: "An image", reasoning: "" }
    })
    assert.equal(
        await sendPrompt(runtime, "Describe", undefined, undefined, [attachment], {
            systemPrompt: "Be concise",
            composioSessionId: "",
            enabledTools: []
        }),
        "An image"
    )
    assert.equal(state.messages[0]?.attachments?.[0]?.id, "image-1")
    assert.equal("dataUrl" in (state.messages[0]?.attachments?.[0] ?? {}), false)
    assert.deepEqual(await clearHistory(runtime), ["image-1"])
})
