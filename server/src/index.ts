import { integrationsRouter } from "./integrations.js";
import { ComposioIntegrations } from "./composio.js";
import { ZodError } from "zod";
import { AgentStore } from "./agent-store.js";
import { agentInputSchema, publicAgent } from "./agent-schema.js";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { AgentBackend } from "./backend.js";
import { CloudflareDurableObjectBackend } from "./cloudflare-backend.js";
import { LocalImageStore, MAX_IMAGE_BYTES } from "./image-store.js";

// This is a very important part of the architecture. These routes NEED to handle the security and authorization of requests going to the Durable Object.
// When a user wants to connect to an agent, this proxy needs to determine if they have access to it!
// This proxy can live anywhere, ideally, it's your pre-existing backend that has access to your DB.
// Yes, you could do this in the outer worker, but it's already super crowded in there! + I'd imagine you'd want all ACL and User management in one place.

const port = Number(process.env.PORT ?? 8790);
const host = process.env.HOST ?? "127.0.0.1";
const internalSecret = requiredSetting("TERSE_INTERNAL_SECRET", "terse_internal_dev");
const workerURL = new URL(process.env.DURABLE_WORKFLOW_URL ?? "http://127.0.0.1:8791");
const backend: AgentBackend = new CloudflareDurableObjectBackend(workerURL, internalSecret);
// I am sure you are doing something here for image storing, we should re-use that.
const images = new LocalImageStore();
const agents = new AgentStore();
const integrations = new ComposioIntegrations(agents);

const MAX_PROMPT_IMAGES = 4;
const MAX_JSON_BYTES = 1_000_000;
const jsonBody = express.json({ limit: MAX_JSON_BYTES });
const imageBody = express.raw({
  type: "multipart/form-data",
  limit: MAX_IMAGE_BYTES + 64 * 1024,
});

const app = express();
app.disable("x-powered-by");
app.use(cors);
app.use("/v1/integrations", jsonBody, integrationsRouter(integrations));

app.get("/health", async (_request, response) => {
  try {
    await backend.health();
    response.json({ ok: true });
  } catch (error) {
    sendError(response, 503, "backend_unavailable", messageFrom(error));
  }
});

app.get("/v1/assets/:assetId", async (request, response) => {
  const { assetId } = request.params;
  if (!validIdentifier(assetId)) {
    sendError(response, 404, "not_found", "That image does not exist.");
    return;
  }

  const image = await images.get(assetId);
  if (!image) {
    sendError(response, 404, "not_found", "That image does not exist.");
    return;
  }

  response
    .status(200)
    .set({
      "content-type": image.metadata.mimeType,
      "content-length": String(image.bytes.byteLength),
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    })
    .send(image.bytes);
});

app.param("agentId", (request, response, next, agentId: string) => {
  if (!validIdentifier(agentId)) {
    sendError(response, 400, "invalid_agent_id", "Agent IDs must be 1–100 safe characters.");
    return;
  }
  if (!agents.get(agentId)) {
    sendError(response, 404, "agent_not_found", "That agent no longer exists. Refresh the agent list.");
    return;
  }
  next();
});

app.get("/v1/agents", (_request, response) => response.json({ agents: agents.list().map(publicAgent) }));
app.post("/v1/agents", jsonBody, async (request, response) => {
  const input = agentInputSchema.parse(request.body);
  const sessionId = await integrations.configure(input);
  const agent = agents.create(input, sessionId);
  integrations.markManaged(agent);
  response.status(201).json(publicAgent(agent));
});
app.get("/v1/agents/:agentId", (request, response) => response.json(publicAgent(agents.get(request.params.agentId)!)));
app.put("/v1/agents/:agentId", jsonBody, async (request, response) => {
  const input = agentInputSchema.parse(request.body);
  const sessionId = await integrations.configure(input, agents.get(request.params.agentId));
  const agent = agents.update(request.params.agentId, input, sessionId);
  if (!agent) {
    sendError(response, 404, "agent_not_found", "That agent no longer exists. Refresh the agent list.");
    return;
  }
  integrations.markManaged(agent);
  response.json(publicAgent(agent));
});

app.delete("/v1/agents/:agentId", (request, response) => {
  agents.delete(request.params.agentId);
  response.status(204).end();
});

app.post("/v1/agents/:agentId/connections", jsonBody, async (request, response) => {
  const body = request.body as { name?: unknown };
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 40) {
    sendError(response, 400, "invalid_name", "A name of 1–40 characters is required.");
    return;
  }

  response.status(201).json(await backend.connectUser(request.params.agentId, name));
});

app.delete(
  "/v1/agents/:agentId/connections/:connectionId",
  async (request, response) => {
    const connectionId = requireConnectionId(request, response);
    if (!connectionId) return;

    await backend.disconnectUser(request.params.agentId, connectionId);
    response.status(204).end();
  },
);

app.put("/v1/agents/:agentId/connections/:connectionId", async (request, response) => {
  const connectionId = requireConnectionId(request, response);
  if (!connectionId) return;

  await backend.heartbeatUser(request.params.agentId, connectionId);
  response.status(204).end();
});

app.get("/v1/agents/:agentId/users", async (request, response) => {
  response.json({ users: await backend.getConnectedUsers(request.params.agentId) });
});

app.put(
  "/v1/agents/:agentId/composer-lock/:connectionId",
  jsonBody,
  async (request, response) => {
    const connectionId = requireConnectionId(request, response);
    if (!connectionId) return;

    const body = request.body as { leaseId?: unknown; startedAt?: unknown };
    const leaseId = typeof body?.leaseId === "string" ? body.leaseId : "";
    const startedAt = typeof body?.startedAt === "number" ? body.startedAt : 0;
    if (!validIdentifier(leaseId) || !Number.isSafeInteger(startedAt) || startedAt <= 0) {
      sendError(response, 400, "invalid_composer_lease", "A valid composer lease is required.");
      return;
    }

    response.json(
      await backend.acquireComposerLock(
        request.params.agentId,
        connectionId,
        leaseId,
        startedAt,
      ),
    );
  },
);

app.delete(
  "/v1/agents/:agentId/composer-lock/:connectionId",
  async (request, response) => {
    const connectionId = requireConnectionId(request, response);
    if (!connectionId) return;

    const leaseId = queryString(request, "lease_id");
    if (!validIdentifier(leaseId)) {
      sendError(response, 400, "invalid_composer_lease", "A valid composer lease is required.");
      return;
    }

    await backend.releaseComposerLock(request.params.agentId, connectionId, leaseId);
    response.status(204).end();
  },
);

app.put(
  "/v1/agents/:agentId/composer-draft/:connectionId",
  jsonBody,
  async (request, response) => {
    const connectionId = requireConnectionId(request, response);
    if (!connectionId) return;

    const body = request.body as {
      attachmentIds?: unknown;
      leaseId?: unknown;
      sequence?: unknown;
      text?: unknown;
    };
    const leaseId = typeof body?.leaseId === "string" ? body.leaseId : "";
    const sequence = typeof body?.sequence === "number" ? body.sequence : 0;
    const text = typeof body?.text === "string" ? body.text : "";
    const attachmentIds = body?.attachmentIds;

    if (!validIdentifier(leaseId) || !Number.isSafeInteger(sequence) || sequence <= 0) {
      sendError(
        response,
        400,
        "invalid_composer_draft",
        "A valid composer draft update is required.",
      );
      return;
    }
    if (text.length > 4_000) {
      sendError(response, 400, "invalid_prompt", "Prompts can be up to 4,000 characters.");
      return;
    }
    if (!validAttachmentIds(attachmentIds, true)) {
      sendError(response, 400, "invalid_attachments", "Attach up to four uploaded images.");
      return;
    }

    const uniqueAttachmentIds = attachmentIds
      ? [...new Set(attachmentIds as string[])]
      : undefined;
    response.json(
      await backend.updateComposerDraft(
        request.params.agentId,
        connectionId,
        leaseId,
        text,
        sequence,
        uniqueAttachmentIds === undefined
          ? undefined
          : await images.forPrompt(request.params.agentId, uniqueAttachmentIds),
      ),
    );
  },
);

app.delete("/v1/agents/:agentId/history", async (request, response) => {
  const attachmentIds = await backend.clearHistory(request.params.agentId);
  await images.deleteMany(attachmentIds);
  response.status(204).end();
});

app.get("/v1/agents/:agentId/events", async (request, response) => {
  const connectionId = queryString(request, "connection_id") || undefined;
  if (connectionId && !validIdentifier(connectionId)) {
    sendError(response, 400, "invalid_connection", "That connection ID is invalid.");
    return;
  }

  response.json(await backend.createEventSocket(request.params.agentId, connectionId));
});

app.post(
  "/v1/agents/:agentId/attachments",
  imageBody,
  async (request, response) => {
    const form = await readFormData(request);
    const image = form.get("image");
    if (!image || typeof image === "string") {
      sendError(response, 400, "invalid_image", "Choose an image to upload.");
      return;
    }

    const attachment = await images.save(
      request.params.agentId,
      image.name,
      image.type,
      new Uint8Array(await image.arrayBuffer()),
    );
    response.status(201).json(attachment);
  },
);

app.post("/v1/agents/:agentId/prompts", jsonBody, async (request, response) => {
  const body = request.body as {
    prompt?: unknown;
    connectionId?: unknown;
    composerLeaseId?: unknown;
    attachmentIds?: unknown;
  };
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim().slice(0, 4_000) : "";
  const connectionId =
    typeof body?.connectionId === "string" ? body.connectionId : "";
  const composerLeaseId =
    typeof body?.composerLeaseId === "string" ? body.composerLeaseId : "";
  const attachmentIds = body?.attachmentIds ?? [];

  if (!prompt) {
    sendError(response, 400, "invalid_prompt", "A prompt is required.");
    return;
  }
  if (!validIdentifier(connectionId)) {
    sendError(response, 400, "invalid_connection", "A valid connection ID is required.");
    return;
  }
  if (!validIdentifier(composerLeaseId)) {
    sendError(response, 400, "invalid_composer_lease", "A valid composer lease is required.");
    return;
  }
  if (!validAttachmentIds(attachmentIds)) {
    sendError(response, 400, "invalid_attachments", "Attach up to four uploaded images.");
    return;
  }

  const uniqueAttachmentIds = [...new Set(attachmentIds as string[])];
  const configuration = agents.get(request.params.agentId);
  if (!configuration) {
    sendError(response, 404, "agent_not_found", "That agent no longer exists. Refresh the agent list.");
    return;
  }
  await backend.sendPrompt(
    request.params.agentId,
    prompt,
    connectionId,
    composerLeaseId,
    await images.forPrompt(request.params.agentId, uniqueAttachmentIds),
    configuration,
  );
  response.status(204).end();
});

app.all(
  /^\/v1\/agents\/[^/]+\/(?:attachments|connections|users|prompts|events|history|composer-lock|composer-draft)(?:\/[^/]+)?$/,
  (_request, response) => {
    sendError(response, 405, "method_not_allowed", "That method is not supported.");
  },
);

app.use((_request, response) => {
  sendError(response, 404, "not_found", "That Terse API route does not exist.");
});

const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof ZodError) {
    sendError(response, 400, "invalid_agent", error.issues.map((issue) => `${issue.path.join(".") || "agent"}: ${issue.message}`).join(" "));
    return;
  }
  const requestError = error as Error & { status?: number; type?: string };
  if (requestError.type === "entity.parse.failed") {
    sendError(response, 400, "backend_error", "Request body must be valid JSON.");
    return;
  }
  if (requestError.type === "entity.too.large") {
    sendError(response, 413, "backend_error", "Request body is too large.");
    return;
  }

  sendError(response, requestError.status ?? 502, "backend_error", messageFrom(error));
};
app.use(handleError);

const server = app.listen(port, host, (error) => {
  if (error) throw error;
  const address = server.address();
  console.log(`Terse gateway ready on http://${host}:${typeof address === "object" && address ? address.port : port}`);
  console.log(`Backend: ${workerURL.origin}`);
});

function requiredSetting(name: string, developmentDefault: string): string {
  const value = process.env[name];
  if (value) return value;
  if (process.env.NODE_ENV === "production") throw new Error(`${name} is required in production`);
  return developmentDefault;
}

function cors(request: Request, response: Response, next: NextFunction): void {
  response.set({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  next();
}

function requireConnectionId(request: Request, response: Response): string | null {
  const { connectionId } = request.params;
  if (!validIdentifier(connectionId)) {
    sendError(response, 400, "invalid_connection", "That connection ID is invalid.");
    return null;
  }
  return connectionId;
}

function validAttachmentIds(value: unknown, optional = false): boolean {
  if (value === undefined) return optional;
  return (
    Array.isArray(value) &&
    value.length <= MAX_PROMPT_IMAGES &&
    value.every((id) => typeof id === "string" && validIdentifier(id))
  );
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(value);
}

function queryString(request: Request, name: string): string {
  const value = request.query[name];
  return typeof value === "string" ? value : "";
}

async function readFormData(request: Request): Promise<FormData> {
  const contentType = request.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data;")) {
    throw Object.assign(new Error("Image uploads must use multipart/form-data."), { status: 415 });
  }
  if (!Buffer.isBuffer(request.body)) {
    throw Object.assign(new Error("Choose an image to upload."), { status: 400 });
  }

  return await new globalThis.Request("http://localhost/upload", {
    method: "POST",
    headers: { "content-type": contentType },
    body: new Uint8Array(request.body),
  }).formData();
}

function sendError(response: Response, status: number, code: string, message: string): void {
  response.status(status).json({ error: { code, message } });
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected server error";
}
