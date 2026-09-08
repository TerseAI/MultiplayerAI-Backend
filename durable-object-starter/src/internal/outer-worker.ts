import { Hono } from "hono";
import type {
	AppEnv,
	ComposerDraftRequest,
	ComposerLockRequest,
	ConfigureAgentToolsRequest,
	ConnectUserRequest,
	ExecuteAgentToolRequest,
	PromptRequest,
} from "./types";
import { validIdentifier } from "./validation";
import { authorized, authorizedEventSocket, unauthorized } from "./worker-auth";

type WorkerEnv = {
	Bindings: AppEnv;
	Variables: { agent: ReturnType<AppEnv["AGENTS"]["getByName"]> };
};
const app = new Hono<WorkerEnv>();

app.get("/v1/agents/:agentId/events", async (c) => {
	// Hono also matches HEAD to GET handlers; only GET may upgrade a socket.
	if (c.req.method !== "GET") return c.notFound();
	const url = new URL(c.req.url);
	const agentId = c.req.param("agentId");
	const connectionId = c.req.query("connection_id") ?? null;
	if (c.req.header("Upgrade") !== "websocket") return c.text("Expected a WebSocket upgrade", 426);
	if (connectionId && !validIdentifier(connectionId)) return unauthorized();
	if (!(await authorizedEventSocket(url, c.env, agentId, connectionId))) return unauthorized();
	// Forward the original request and upgrade response without wrapping the socket.
	return c.env.AGENTS.getByName(agentId).fetch(c.req.raw);
});

app.all("/internal/health", (c) => authorized(c.req.raw, c.env) ? c.json({ ok: true }) : unauthorized());

const agents = new Hono<WorkerEnv>();
// Restrict middleware and method fallbacks to the existing resource paths.
const resources = ["connections", "users", "prompts", "history", "composer-lock", "composer-draft", "tools"];
for (const resource of resources) {
	agents.use(`/:agentId/${resource}/:target?`, async (c, next) => {
		if (!authorized(c.req.raw, c.env)) return unauthorized();
		c.set("agent", c.env.AGENTS.getByName(c.req.param("agentId")!));
		await next();
	});
}

agents.post("/:agentId/connections", async (c) => {
	const body = await c.req.json<ConnectUserRequest>();
	return c.json(await c.var.agent.connectUser(body.name ?? ""), 201);
});
agents.delete("/:agentId/connections/:connectionId", async (c) => {
	await c.var.agent.disconnectUser(c.req.param("connectionId"));
	return c.body(null, 204);
});
agents.put("/:agentId/connections/:connectionId", async (c) => {
	await c.var.agent.heartbeatUser(c.req.param("connectionId"));
	return c.body(null, 204);
});
agents.get("/:agentId/users", async (c) => {
	if (c.req.method !== "GET") return methodNotAllowed();
	return c.json({ users: await c.var.agent.getConnectedUsers() });
});
agents.delete("/:agentId/history", async (c) => c.json({ attachmentIds: await c.var.agent.clearHistory() }));

agents.put("/:agentId/composer-lock/:connectionId", async (c) => {
	const body = await c.req.json<ComposerLockRequest>();
	return c.json(await c.var.agent.acquirePromptLock(c.req.param("connectionId"), body.leaseId ?? "", body.startedAt ?? 0));
});
agents.delete("/:agentId/composer-lock/:connectionId", async (c) => {
	const leaseId = c.req.query("lease_id");
	if (!leaseId) throw new Error("A composer lease is required");
	const connectionId = c.req.param("connectionId");
	await c.var.agent.heartbeatUser(connectionId);
	await c.var.agent.releasePromptLock(connectionId, leaseId);
	return c.body(null, 204);
});
agents.put("/:agentId/composer-draft/:connectionId", async (c) => {
	const body = await c.req.json<ComposerDraftRequest>();
	return c.json(await c.var.agent.updatePromptDraft(c.req.param("connectionId"), body.leaseId ?? "", body.text ?? "", body.sequence ?? 0, body.attachments));
});
agents.post("/:agentId/prompts", async (c) => {
	const body = await c.req.json<PromptRequest>();
	const text = await c.var.agent.sendPrompt(body.prompt ?? "", body.connectionId, body.composerLeaseId, body.attachments ?? [], body.configuration);
	return c.text(text);
});
agents.put("/:agentId/tools", async (c) => {
	const body = await c.req.json<ConfigureAgentToolsRequest>();
	return c.json(await c.var.agent.configureTools(body.composioSessionId ?? "", body.enabledTools ?? []));
});
agents.get("/:agentId/tools", async (c) => {
	if (c.req.method !== "GET") return methodNotAllowed();
	return c.json({ config: await c.var.agent.getToolConfig() });
});
agents.post("/:agentId/tools/:tool", async (c) => {
	const body = await c.req.json<ExecuteAgentToolRequest>();
	return c.json(await c.var.agent.executeTool(c.req.param("tool"), body.arguments ?? {}));
});

for (const resource of resources) agents.all(`/:agentId/${resource}/:target?`, methodNotAllowed);
agents.onError((error, c) => c.json({ error: { code: "agent_error", message: error.message } }, 400));
app.route("/internal/agents", agents);
app.notFound((c) => c.json({ error: { code: "not_found", message: "That route does not exist." } }, 404));

function methodNotAllowed(): Response {
	return Response.json({ error: { code: "method_not_allowed", message: "That method is not supported." } }, { status: 405 });
}

export default app;
