import assert from "node:assert/strict";
import { test } from "node:test";
import { TerseActorBackend } from "../src/terse-backend.js";

test("the gateway forwards room operations to the matching Terse Agent", async () => {
  const calls: unknown[][] = [];
  const user = { connectionId: "alice", name: "Alice", connectedAt: 1 };
  const lock = { leaseId: "lease", startedAt: 1, user, expiresAt: 2 };
  const draft = { leaseId: "lease", sequence: 1, text: "Hi", attachments: [], updatedAt: 1 };
  const stub = {
    async connectUser(...args: unknown[]) { calls.push(["connectUser", ...args]); return user; },
    async disconnectUser(...args: unknown[]) { calls.push(["disconnectUser", ...args]); },
    async heartbeatUser(...args: unknown[]) { calls.push(["heartbeatUser", ...args]); },
    async getConnectedUsers() { return [user]; },
    async acquirePromptLock(...args: unknown[]) { calls.push(["acquirePromptLock", ...args]); return lock; },
    async releasePromptLock(...args: unknown[]) { calls.push(["releasePromptLock", ...args]); },
    async updatePromptDraft(...args: unknown[]) { calls.push(["updatePromptDraft", ...args]); return draft; },
    async clearHistory() { return ["image"]; },
    async sendPrompt(...args: unknown[]) { calls.push(["sendPrompt", ...args]); return "Hello"; },
    async getSnapshot() { return []; },
    async configureTools() { return { composioSessionId: "", enabledTools: [], updatedAt: 0 }; },
    async getToolConfig() { return null; },
    async executeTool() { return { tool: "", data: {}, logId: "" }; },
  };
  const backend = new TerseActorBackend({
    get(id) { assert.equal(id, "room"); return stub; },
    async prepareWebsocket(authorization) {
      calls.push(["socket", authorization]);
      return { websocketUrl: "ws://localhost/socket", transport: "websocket", homeRegion: "local", connectByMs: 100, authorizedUntilMs: 200 };
    },
  }, async () => { calls.push(["health"]); });
  assert.deepEqual(await backend.connectUser("room", "Alice"), user);
  await backend.heartbeatUser("room", "alice");
  assert.deepEqual(await backend.getConnectedUsers("room"), [user]);
  assert.deepEqual(await backend.acquireComposerLock("room", "alice", "lease", 1), lock);
  const attachment = { id: "image", type: "image" as const, name: "one.png", mimeType: "image/png" as const, size: 1, url: "/v1/assets/image", bytes: Uint8Array.of(97) };
  await backend.updateComposerDraft("room", "alice", "lease", "Hi", 1, [attachment]);
  const draftArgs = calls.at(-1)!;
  assert.equal("bytes" in (draftArgs[5] as object[])[0]!, false);
  const configuration = { id: "room", name: "Agent", description: "", systemPrompt: "Be concise", enabledTools: [], composioSessionId: "" };
  await backend.sendPrompt("room", "Hi", "alice", "lease", [attachment], configuration);
  assert.deepEqual(calls.at(-1), ["sendPrompt", "Hi", "alice", "lease", [{ id: "image", type: "image", name: "one.png", mimeType: "image/png", size: 1, url: "/v1/assets/image", dataUrl: "data:image/png;base64,YQ==" }], { systemPrompt: "Be concise", enabledTools: [], composioSessionId: "" }]);
  assert.deepEqual(await backend.createEventSocket("room", "alice"), { url: "ws://localhost/socket", expiresAt: 100 });
  assert.deepEqual(calls.at(-1), ["socket", { actorId: "room", metadata: { connectionId: "alice" } }]);
  await backend.createEventSocket("room");
  assert.deepEqual(calls.at(-1), ["socket", { actorId: "room", metadata: { connectionId: null } }]);
  await backend.releaseComposerLock("room", "alice", "lease");
  await backend.disconnectUser("room", "alice");
  assert.deepEqual(await backend.clearHistory("room"), ["image"]);
  await backend.health();
  assert.deepEqual(calls.at(-1), ["health"]);
});
