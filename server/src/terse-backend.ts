import { actors } from "./terse.actors/index.js";
import type { AgentDefinition } from "./agent-schema.js";
import type { AgentBackend, ImageAttachmentInput } from "./backend.js";

type AgentAccess = Pick<typeof actors.Agent, "get" | "prepareWebsocket">;

export class TerseActorBackend implements AgentBackend {
  constructor(private readonly agents: AgentAccess, private readonly checkHealth: () => Promise<void>) {}

  connectUser(agentId: string, name: string) { return this.agents.get(agentId).connectUser(name); }
  disconnectUser(agentId: string, connectionId: string) { return this.agents.get(agentId).disconnectUser(connectionId); }
  heartbeatUser(agentId: string, connectionId: string) { return this.agents.get(agentId).heartbeatUser(connectionId); }
  getConnectedUsers(agentId: string) { return this.agents.get(agentId).getConnectedUsers(); }
  acquireComposerLock(agentId: string, connectionId: string, leaseId: string, startedAt: number) {
    return this.agents.get(agentId).acquirePromptLock(connectionId, leaseId, startedAt);
  }
  releaseComposerLock(agentId: string, connectionId: string, leaseId: string) {
    return this.agents.get(agentId).releasePromptLock(connectionId, leaseId);
  }
  updateComposerDraft(agentId: string, connectionId: string, leaseId: string, text: string, sequence: number, attachments?: ImageAttachmentInput[]) {
    return this.agents.get(agentId).updatePromptDraft(connectionId, leaseId, text, sequence, attachments?.map(({ bytes: _bytes, ...attachment }) => attachment));
  }
  clearHistory(agentId: string) { return this.agents.get(agentId).clearHistory(); }
  async createEventSocket(agentId: string, connectionId?: string) {
    const grant = await this.agents.prepareWebsocket({ actorId: agentId, metadata: { connectionId: connectionId ?? null } });
    return { url: grant.websocketUrl, expiresAt: grant.connectByMs };
  }
  async sendPrompt(agentId: string, prompt: string, connectionId: string, composerLeaseId: string, attachments: ImageAttachmentInput[], configuration: AgentDefinition): Promise<void> {
    await this.agents.get(agentId).sendPrompt(prompt, connectionId, composerLeaseId,
      attachments.map(({ bytes, ...attachment }) => ({ ...attachment, dataUrl: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}` })),
      { systemPrompt: configuration.systemPrompt, composioSessionId: configuration.composioSessionId, enabledTools: configuration.enabledTools });
  }
  health() { return this.checkHealth(); }
}

export function createTerseBackend(): AgentBackend {
  const actorUrl = process.env.TERSE_ACTOR_URL;
  const apiKey = process.env.TERSE_API_KEY;
  if (!actorUrl || !apiKey) throw new Error("Terse requires TERSE_ACTOR_URL and TERSE_API_KEY. Use npm run dev:terse from the repo root.");
  const contractUrl = actorUrl.replace(/\/actors\/?$/, "/deployment/contract");
  return new TerseActorBackend(actors.Agent, async () => {
    const response = await fetch(contractUrl, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Terse runtime returned ${response.status}`);
  });
}
