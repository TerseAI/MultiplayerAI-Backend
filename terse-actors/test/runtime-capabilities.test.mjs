import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const project = fileURLToPath(new URL("..", import.meta.url))
const runtimeSdk = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("little-actors"))))
const { startLocalActors } = await import("little-actors/dev")
const { createActorTransport } = await import("little-actors/backend")
const { SocketProxy } = await import("little-actors/proxy")
const { buildActor } = await import(pathToFileURL(path.join(runtimeSdk, "dist/compiler/actor-build.js")))

for (const artifact of [false, true]) {
    test(
        `Agent keeps joins, snapshots, and heartbeats responsive during generation (${artifact ? "artifact" : "source"})`,
        { timeout: 60000 },
        async t => {
            assert.ok(
                process.env.DURABLE_OBJECT_BINARY,
                "Set DURABLE_OBJECT_BINARY to the locally built little-actors binary"
            )
            const root = await mkdtemp(path.join(os.tmpdir(), "agent-reentrant-"))
            const sockets = new Set()
            const entered = deferred()
            let finish
            let runtime
            const gate = createServer((_request, response) => {
                finish = () => response.end("continue")
                entered.resolve()
            })
            gate.listen(0, "127.0.0.1")
            await new Promise(resolve => gate.once("listening", resolve))
            const savedEnvironment = { apiKey: process.env.OPEN_ROUTER_API_KEY, gate: process.env.TEST_GENERATION_GATE }
            process.env.OPEN_ROUTER_API_KEY = "local-test-only"
            process.env.TEST_GENERATION_GATE = `http://127.0.0.1:${gate.address().port}`
            t.after(async () => {
                finish?.()
                for (const socket of sockets) socket.close()
                await runtime?.stop()
                gate.closeAllConnections()
                await new Promise(resolve => gate.close(resolve))
                for (const [key, value] of [
                    ["OPEN_ROUTER_API_KEY", savedEnvironment.apiKey],
                    ["TEST_GENERATION_GATE", savedEnvironment.gate]
                ]) {
                    if (value === undefined) delete process.env[key]
                    else process.env[key] = value
                }
                await rm(root, { recursive: true, force: true })
            })
            await prepareProject(root, artifact)
            const start = () =>
                startLocalActors({
                    projectId: "agent-reentrancy-test",
                    project: root,
                    entrypoint: artifact ? "actors.mjs" : "src/actors.ts",
                    quiet: true
                })
            runtime = await start()
            const { projectId, controlPlaneUrl, apiKey } = runtime.connection
            const transport = createActorTransport({ projectId, controlPlaneUrl, apiKey })
            const invoke = (method, ...args) => transport.invoke("Agent", "room", method, args)
            const proxy = new SocketProxy({ Agent: {} }, runtime.connection)
            const connect = async connectionId => {
                const grant = await proxy.handle({ actorName: "Agent", actorId: "room", metadata: { connectionId } })
                const socket = new WebSocket(grant.websocketUrl)
                sockets.add(socket)
                return messages(socket, t.signal)
            }
            const alice = await invoke("connectUser", "Alice")
            const observer = await connect(alice.connectionId)
            assert.deepEqual((await observer.next(event => event.type === "history")).messages, [])
            await invoke("acquirePromptLock", alice.connectionId, "alice-lease", Date.now())
            await invoke("updatePromptDraft", alice.connectionId, "alice-lease", "Hi", 1)
            let completed = false
            const generation = invoke("sendPrompt", "Hi", alice.connectionId, "alice-lease").finally(() => {
                completed = true
            })
            void generation.catch(() => {})
            await Promise.race([
                entered.promise,
                generation.then(() => assert.fail("generation completed before the gate opened"))
            ])
            assert.equal((await observer.next(event => event.type === "text_delta")).delta, "Hello")
            const bob = await invoke("connectUser", "Bob")
            const newcomer = await connect(bob.connectionId)
            const history = await newcomer.next(event => event.type === "history")
            assert.equal(history.messages.at(-1).text, "Hello")
            assert.equal(history.messages.at(-1).reasoning, "Thinking")
            assert.equal(history.messages.at(-1).status, "streaming")
            await invoke("heartbeatUser", bob.connectionId)
            assert.deepEqual(
                (await invoke("getConnectedUsers")).map(user => user.name),
                ["Alice", "Bob"]
            )
            const snapshot = await invoke("getSnapshot")
            assert.equal(snapshot.find(event => event.type === "history").messages.at(-1).status, "streaming")
            await assert.rejects(invoke("sendPrompt", "Second prompt"), /already generating/)
            await assert.rejects(invoke("clearHistory"), /current response/)
            assert.equal(completed, false)
            newcomer.socket.close()
            await observer.next(event => event.type === "connected_users" && event.users.length === 1)
            assert.equal(completed, false)
            finish()
            assert.equal(await generation, "Hello world")
            assert.equal((await observer.next(event => event.type === "generation_completed")).text, "Hello world")
            const final = await invoke("getSnapshot")
            assert.equal(final.find(event => event.type === "history").messages.at(-1).status, "complete")
            for (const socket of sockets) socket.close()
            sockets.clear()
            await runtime.stop()
            await cp(
                path.join(project, "src/internal/agent-generation.ts"),
                path.join(root, "src/internal/agent-generation.ts")
            )
            if (artifact) await buildActor(path.join(root, "src/actors.ts"), path.join(root, "actors.mjs"))
            runtime = await start()
            const recoveredSettings = runtime.connection
            const recovered = await createActorTransport({
                projectId: recoveredSettings.projectId,
                controlPlaneUrl: recoveredSettings.controlPlaneUrl,
                apiKey: recoveredSettings.apiKey
            }).invoke("Agent", "room", "getSnapshot", [])
            assert.equal(recovered.find(event => event.type === "history").messages.at(-1).text, "Hello world")
            t.diagnostic(
                "late joiner received partial history; reads, heartbeats, and disconnect completed while generation was held; completed history survived restart"
            )
        }
    )
}

async function prepareProject(root, artifact) {
    await cp(path.join(project, "src"), path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }))
    await cp(path.join(project, "tsconfig.json"), path.join(root, "tsconfig.json"))
    await mkdir(path.join(root, "node_modules"))
    for (const name of [
        "terse-sdk",
        "zod",
        "@composio/core",
        "@earendil-works/pi-agent-core",
        "@earendil-works/pi-ai",
        "@types/node"
    ]) {
        const destination = path.join(root, "node_modules", name)
        await mkdir(path.dirname(destination), { recursive: true })
        await symlink(path.join(project, "node_modules", name), destination)
    }
    await symlink(runtimeSdk, path.join(root, "node_modules/little-actors"))
    // Replace only the model boundary in the isolated test copy; the actor and chat flow are unchanged.
    const original = await readFile(path.join(root, "src/internal/agent-generation.ts"), "utf8")
    const types = original.slice(0, original.indexOf("export async function runAgentGeneration"))
    await writeFile(
        path.join(root, "src/internal/agent-generation.ts"),
        `${types}
export type AgentGenerationRunner = (options: AgentGenerationOptions) => Promise<AgentGenerationResult>;
export const runAgentGeneration: AgentGenerationRunner = async options => {
    options.onReasoningDelta("Thinking");
    options.onTextDelta("Hello");
    const response = await fetch(process.env.TEST_GENERATION_GATE ?? "");
    if (!response.ok) throw new Error("controlled model failure");
    await response.text();
    options.onTextDelta(" world");
    return { text: "Hello world", reasoning: "Thinking" };
};
`
    )
    if (artifact) await buildActor(path.join(root, "src/actors.ts"), path.join(root, "actors.mjs"))
}

function deferred() {
    let resolve = () => {}
    const promise = new Promise(done => {
        resolve = done
    })
    return { promise, resolve }
}

function messages(socket, signal) {
    const queued = []
    const waiting = []
    let failure
    const fail = error => {
        failure = error
        for (const pending of waiting.splice(0)) pending.reject(error)
    }
    socket.addEventListener("error", () => fail(new Error("agent WebSocket failed")))
    socket.addEventListener("message", event => {
        const value = JSON.parse(String(event.data))
        const index = waiting.findIndex(pending => pending.matches(value))
        if (index < 0) queued.push(value)
        else waiting.splice(index, 1)[0].resolve(value)
    })
    signal.addEventListener("abort", () => fail(new Error("test aborted")), { once: true })
    return {
        socket,
        next(matches) {
            const index = queued.findIndex(matches)
            if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0])
            if (failure) return Promise.reject(failure)
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("expected agent event did not arrive")), 10000)
                waiting.push({
                    matches,
                    resolve: value => {
                        clearTimeout(timer)
                        resolve(value)
                    },
                    reject: error => {
                        clearTimeout(timer)
                        reject(error)
                    }
                })
            })
        }
    }
}
