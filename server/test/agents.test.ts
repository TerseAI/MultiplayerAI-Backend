import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ZodError } from "zod";
import { AgentStore } from "../src/agent-store.js";
import { agentInputSchema } from "../src/agent-schema.js";

const input = { name: "Custom agent", description: "Test room", systemPrompt: "Respond only in French.", enabledTools: ["TOOL_ONE"] };

test("SQLite persists edits and deletions without reseeding an empty catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "terse-agents-"));
  try {
    const path = join(dir, "agents.sqlite");
    let store = new AgentStore(path);
    assert.equal(store.list().length, 3);
    const agent = store.create(agentInputSchema.parse(input));
    const workspaceId = store.workspaceId();
    store.close(); store = new AgentStore(path);
    assert.equal(store.workspaceId(), workspaceId);
    assert.deepEqual(store.get(agent.id), agent);
    assert.equal(store.update(agent.id, { ...input, systemPrompt: "Updated" })?.systemPrompt, "Updated");
    for (const item of store.list()) store.delete(item.id);
    store.close(); store = new AgentStore(path);
    assert.deepEqual(store.list(), []);
    assert.equal(store.update(agent.id, input), undefined);
    store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("agent configuration validation rejects invalid tools and excessive input", () => {
  for (const value of [null, [], { ...input, name: " " }, { ...input, systemPrompt: "" }, { ...input, systemPrompt: "x".repeat(20001) }, { ...input, enabledTools: ["bad tool"] }, { ...input, enabledTools: "all" }]) {
    assert.throws(() => agentInputSchema.parse(value), ZodError);
  }
  assert.deepEqual(agentInputSchema.parse({ ...input, enabledTools: ["TOOL_ONE", "TOOL_ONE"] }).enabledTools, ["TOOL_ONE"]);
  assert.deepEqual(agentInputSchema.parse({ ...input, enabledTools: [], composioSessionId: "" }).enabledTools, []);
});

test("gateway CRUD gates deleted agents and forwards saved configuration for each run", async () => {
  const chatInput = { ...input, enabledTools: [] };
  const dir = await mkdtemp(join(tmpdir(), "terse-api-"));
  const calls: any[] = [];
  const worker = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ url: request.url, body: body ? JSON.parse(body) : null });
    response.end("ok");
  });
  worker.listen(0, "127.0.0.1"); await once(worker, "listening");
  const address = worker.address() as { port: number };
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(), env: { ...process.env, PORT: "0", AGENT_DB_PATH: join(dir, "agents.sqlite"), COMPOSIO_API_KEY: "", DURABLE_WORKFLOW_URL: `http://127.0.0.1:${address.port}` }, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Gateway did not start: " + output)), 10000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/ready on (http:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(output)); });
    });
    const api = (path = "", method = "GET", body?: unknown) => fetch(`${base}/v1/agents${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await (await api()).json()).agents.length, 3);
    assert.equal((await api("", "POST", { ...input, enabledTools: ["bad tool"] })).status, 400);
    let response = await api("", "POST", chatInput);
    assert.equal(response.status, 201);
    const agent = await response.json();
    const hijack = await api(`/${agent.id}`, "PUT", { ...chatInput, composioSessionId: "untrusted-session" });
    assert.equal(hijack.status, 200);
    assert.deepEqual(await (await api(`/${agent.id}`)).json(), agent);
    const invalidUpdate = await api(`/${agent.id}`, "PUT", { ...input, systemPrompt: "" });
    assert.equal(invalidUpdate.status, 400);
    assert.equal((await invalidUpdate.json()).error.code, "invalid_agent");
    assert.deepEqual(await (await api(`/${agent.id}`)).json(), agent);
    const prompt = { prompt: "Hello", connectionId: "test-user", composerLeaseId: "test-lease" };
    assert.equal((await api(`/${agent.id}/prompts`, "POST", { ...prompt, configuration: { systemPrompt: "client override" } })).status, 204);
    assert.deepEqual(calls.at(-1).body.configuration, { ...agent, composioSessionId: "" });
    assert.equal("composioSessionId" in agent, false);
    const invalidTools = await api(`/${agent.id}`, "PUT", input);
    assert.equal(invalidTools.status, 503);
    assert.deepEqual(await (await api(`/${agent.id}`)).json(), agent);
    const callsBeforeManagement = calls.length;
    assert.equal((await fetch(`${base}/v1/integrations/apps`)).status, 503);
    assert.equal((await fetch(`${base}/v1/integrations/tools?app=bad%20slug`)).status, 400);
    assert.equal(calls.length, callsBeforeManagement, "Management must not call the room backend");
    const updated = { ...input, systemPrompt: "New instructions", enabledTools: [], composioSessionId: "" };
    assert.equal((await api(`/${agent.id}`, "PUT", updated)).status, 200);
    assert.equal((await api(`/${agent.id}/prompts`, "POST", prompt)).status, 204);
    assert.deepEqual(calls.at(-1).body.configuration.enabledTools, []);
    assert.equal(calls.at(-1).body.configuration.systemPrompt, "New instructions");
    assert.equal((await api(`/${agent.id}`, "DELETE")).status, 204);
    const previousCalls = calls.length;
    for (const [path, method] of [["", "GET"], ["", "PUT"], ["", "DELETE"], ["/connections", "POST"], ["/prompts", "POST"], ["/events", "GET"], ["/users", "GET"]]) {
      assert.equal((await api(`/${agent.id}${path}`, method, method === "POST" || method === "PUT" ? input : undefined)).status, 404);
    }
    assert.equal(calls.length, previousCalls);
  } finally {
    child.kill(); if (child.exitCode === null) await once(child, "exit");
    worker.close(); await once(worker, "close");
    await rm(dir, { recursive: true, force: true });
  }
});
