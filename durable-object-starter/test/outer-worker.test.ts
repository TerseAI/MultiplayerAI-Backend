import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import app from "../src/internal/outer-worker";
import type { AppEnv } from "../src/internal/types";

function fixture() {
	const calls: { method: string; args: unknown[] }[] = [];
	const names: string[] = [];
	const stub = new Proxy({}, { get: (_, method: string) => async (...args: unknown[]) => {
		calls.push({ method, args });
		if (method === "sendPrompt") return "Hello";
		if (method === "fetch") return new Response("socket forwarded");
		if (method === "getConnectedUsers" || method === "clearHistory") return [];
		return { ok: true };
	} });
	const env = { TERSE_INTERNAL_SECRET: "test-secret", AGENTS: { getByName: (name: string) => { names.push(name); return stub; } } } as unknown as AppEnv;
	const request = (path: string, method = "GET", body?: unknown, authenticated = true) => app.request(path, {
		method, headers: authenticated ? { "x-terse-internal": "test-secret" } : {},
		body: body === undefined ? undefined : JSON.stringify(body),
	}, env);
	return { calls, names, env, request };
}

test("internal routing preserves RPC arguments, response codes, and configuration snapshots", async () => {
	const f = fixture();
	const configuration = { id: "room", name: "Agent", description: "", systemPrompt: "Saved instructions", enabledTools: [], composioSessionId: "" };
	const cases: [string, string, unknown, string, unknown[], number][] = [
		["connections", "POST", { name: "Alice" }, "connectUser", ["Alice"], 201],
		["connections/user", "PUT", undefined, "heartbeatUser", ["user"], 204],
		["connections/user", "DELETE", undefined, "disconnectUser", ["user"], 204],
		["users", "GET", undefined, "getConnectedUsers", [], 200],
		["history", "DELETE", undefined, "clearHistory", [], 200],
		["composer-lock/user", "PUT", { leaseId: "lease", startedAt: 5 }, "acquirePromptLock", ["user", "lease", 5], 200],
		["composer-lock/user?lease_id=lease", "DELETE", undefined, "releasePromptLock", ["user", "lease"], 204],
		["composer-draft/user", "PUT", { leaseId: "lease", text: "Draft", sequence: 2, attachments: [] }, "updatePromptDraft", ["user", "lease", "Draft", 2, []], 200],
		["prompts", "POST", { prompt: "Hi", connectionId: "user", composerLeaseId: "lease", configuration }, "sendPrompt", ["Hi", "user", "lease", [], configuration], 200],
		["tools", "PUT", { composioSessionId: "session", enabledTools: ["READ"] }, "configureTools", ["session", ["READ"]], 200],
		["tools", "GET", undefined, "getToolConfig", [], 200],
		["tools/READ", "POST", { arguments: { id: 1 } }, "executeTool", ["READ", { id: 1 }], 200],
	];
	for (const [path, method, body, rpc, args, status] of cases) {
		const response = await f.request(`/internal/agents/room%20one/${path}`, method, body);
		assert.equal(response.status, status, `${method} ${path}: ${await response.text()}`);
		assert.deepEqual(f.calls.at(-1), { method: rpc, args });
		assert.equal(f.names.at(-1), "room one");
	}
	const releaseIndex = f.calls.findIndex(call => call.method === "releasePromptLock");
	assert.equal(f.calls[releaseIndex - 1].method, "heartbeatUser");
});

test("auth, malformed requests, missing leases, unsupported methods, and unknown routes retain their boundaries", async () => {
	const f = fixture();
	assert.equal((await f.request("/internal/health", "GET", undefined, false)).status, 401);
	assert.equal((await f.request("/internal/health")).status, 200);
	assert.equal((await f.request("/internal/agents/room/connections", "POST", {}, false)).status, 401);
	assert.equal(f.names.length, 0, "Unauthorized requests cannot access an object");
	assert.equal((await f.request("/internal/agents/room/composer-lock/user", "DELETE")).status, 400);
	assert.equal(f.calls.length, 0);
	const malformed = await app.request("/internal/agents/room/prompts", { method: "POST", headers: { "x-terse-internal": "test-secret" }, body: "{" }, f.env);
	assert.equal(malformed.status, 400);
	assert.equal((await malformed.json() as { error: { code: string } }).error.code, "agent_error");
	for (const [path, method] of [["users", "POST"], ["users", "HEAD"], ["tools", "HEAD"], ["connections", "GET"], ["prompts/user", "POST"]]) {
		assert.equal((await f.request(`/internal/agents/room/${path}`, method)).status, 405);
	}
	for (const path of ["/missing", "/internal/agents/room/unknown", "/internal/agents/room/users/", "/internal/integrations"]) {
		assert.equal((await f.request(path, "GET", undefined, false)).status, 404);
	}
});

test("event routes verify signed identity and expiry before forwarding the original request", async () => {
	const f = fixture();
	const path = "/v1/agents/room/events";
	assert.equal((await f.request(path)).status, 426);
	assert.equal((await f.request(path, "HEAD")).status, 404);
	const expires = Date.now() + 60_000;
	const signature = createHmac("sha256", "test-secret").update(`room:user:${expires}`).digest("base64url");
	const url = `http://localhost${path}?connection_id=user&expires=${expires}&signature=${signature}`;
	for (const invalid of [url.replace("connection_id=user", "connection_id=other"), url.replace(String(expires), "1"), url.replace(signature, "invalid")]) {
		assert.equal((await app.request(invalid, { headers: { Upgrade: "websocket" } }, f.env)).status, 401);
	}
	assert.equal(f.calls.length, 0);
	const request = new Request(url, { headers: { Upgrade: "websocket" } });
	assert.equal((await app.fetch(request, f.env)).status, 200);
	assert.equal(f.calls.at(-1)?.method, "fetch");
	assert.equal(f.calls.at(-1)?.args[0], request);
});
