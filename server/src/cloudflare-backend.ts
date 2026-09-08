import type { AgentDefinition } from "./agent-schema.js";
import { createHmac } from "node:crypto";
import type {
  AgentBackend,
  ComposerDraft,
  ComposerLock,
  ConnectedUser,
  ImageAttachmentInput,
  EventSocketDescriptor,
} from "./backend.js";

const EVENT_SOCKET_TICKET_LIFETIME = 60_000;

export class CloudflareDurableObjectBackend implements AgentBackend {
  constructor(
    private readonly workerURL: URL,
    private readonly internalSecret: string,
  ) {}

  async connectUser(agentId: string, name: string): Promise<ConnectedUser> {
    const response = await fetch(this.agentURL(agentId, "connections"), {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify({ name }),
    });
    return await readJSON<ConnectedUser>(response);
  }

  async disconnectUser(agentId: string, connectionId: string): Promise<void> {
    const response = await fetch(
      this.agentURL(agentId, `connections/${encodeURIComponent(connectionId)}`),
      { method: "DELETE", headers: this.headers() },
    );
    if (!response.ok) throw new Error(await errorMessage(response));
  }

  async heartbeatUser(agentId: string, connectionId: string): Promise<void> {
    const response = await fetch(
      this.agentURL(agentId, `connections/${encodeURIComponent(connectionId)}`),
      { method: "PUT", headers: this.headers() },
    );
    if (!response.ok) throw new Error(await errorMessage(response));
  }

  async getConnectedUsers(agentId: string): Promise<ConnectedUser[]> {
    const response = await fetch(this.agentURL(agentId, "users"), {
      headers: this.headers(),
    });
    const payload = await readJSON<{ users: ConnectedUser[] }>(response);
    return payload.users;
  }

  async acquireComposerLock(
    agentId: string,
    connectionId: string,
    leaseId: string,
    startedAt: number,
  ): Promise<ComposerLock> {
    const response = await fetch(
      this.agentURL(agentId, `composer-lock/${encodeURIComponent(connectionId)}`),
      {
        method: "PUT",
        headers: this.headers("application/json"),
        body: JSON.stringify({ leaseId, startedAt }),
      },
    );
    return await readJSON<ComposerLock>(response);
  }

  async releaseComposerLock(
    agentId: string,
    connectionId: string,
    leaseId: string,
  ): Promise<void> {
    const url = this.agentURL(agentId, `composer-lock/${encodeURIComponent(connectionId)}`);
    url.searchParams.set("lease_id", leaseId);
    const response = await fetch(url, { method: "DELETE", headers: this.headers() });
    if (!response.ok) throw new Error(await errorMessage(response));
  }

  async updateComposerDraft(
    agentId: string,
    connectionId: string,
    leaseId: string,
    text: string,
    sequence: number,
    attachments?: ImageAttachmentInput[],
  ): Promise<ComposerDraft> {
    const response = await fetch(
      this.agentURL(agentId, `composer-draft/${encodeURIComponent(connectionId)}`),
      {
        method: "PUT",
        headers: this.headers("application/json"),
        body: JSON.stringify({
          leaseId,
          text,
          sequence,
          ...(attachments
            ? {
                attachments: attachments.map(({ bytes: _bytes, ...attachment }) => attachment),
              }
            : {}),
        }),
      },
    );
    return await readJSON<ComposerDraft>(response);
  }

  async clearHistory(agentId: string): Promise<string[]> {
    const response = await fetch(this.agentURL(agentId, "history"), {
      method: "DELETE",
      headers: this.headers(),
    });
    const payload = await readJSON<{ attachmentIds: string[] }>(response);
    return payload.attachmentIds;
  }

  async createEventSocket(
    agentId: string,
    connectionId?: string,
  ): Promise<EventSocketDescriptor> {
    const expiresAt = Date.now() + EVENT_SOCKET_TICKET_LIFETIME;
    const signature = createHmac("sha256", this.internalSecret)
      .update(`${agentId}:${connectionId ?? ""}:${expiresAt}`)
      .digest("base64url");
    const url = new URL(`/v1/agents/${encodeURIComponent(agentId)}/events`, this.workerURL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (connectionId) url.searchParams.set("connection_id", connectionId);
    url.searchParams.set("expires", String(expiresAt));
    url.searchParams.set("signature", signature);
    return { url: url.toString(), expiresAt };
  }

  async sendPrompt(
    agentId: string,
    prompt: string,
    connectionId: string,
    composerLeaseId: string,
    attachments: ImageAttachmentInput[],
    configuration: AgentDefinition,
  ): Promise<void> {
    const providerAttachments = attachments.map(({ bytes, ...attachment }) => ({
      ...attachment,
      dataUrl: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
    }));
    const response = await fetch(this.agentURL(agentId, "prompts"), {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify({
        prompt,
        connectionId,
        composerLeaseId,
        attachments: providerAttachments,
        configuration,
      }),
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    await response.arrayBuffer();
  }

  async health(): Promise<void> {
    const response = await fetch(new URL("/internal/health", this.workerURL), {
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(`Cloudflare Worker returned ${response.status}`);
  }

  private agentURL(agentId: string, action: string): URL {
    return new URL(
      `/internal/agents/${encodeURIComponent(agentId)}/${action}`,
      this.workerURL,
    );
  }

  private headers(contentType?: string): HeadersInit {
    return {
      "x-terse-internal": this.internalSecret,
      ...(contentType ? { "content-type": contentType } : {}),
    };
  }
}

async function readJSON<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as T;
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const payload = JSON.parse(text) as { error?: { message?: string } };
    return payload.error?.message ?? `Cloudflare Worker returned ${response.status}`;
  } catch {
    return text || `Cloudflare Worker returned ${response.status}`;
  }
}
