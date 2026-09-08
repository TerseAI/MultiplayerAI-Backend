import type { AgentDefinition } from "./agent-schema.js";
export type ConnectedUser = {
  connectionId: string;
  name: string;
  connectedAt: number;
};

export type ComposerLock = {
  leaseId: string;
  startedAt: number;
  user: ConnectedUser;
  expiresAt: number;
};

export type ComposerDraft = {
  leaseId: string | null;
  sequence: number;
  text: string;
  attachments: ImageAttachment[];
  updatedAt: number;
};

export type EventSocketDescriptor = {
  url: string;
  expiresAt: number;
};

export type ImageAttachment = {
  id: string;
  type: "image";
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  size: number;
  url: string;
};

export type ImageAttachmentInput = ImageAttachment & {
  bytes: Uint8Array;
};

export interface AgentBackend {
  connectUser(agentId: string, name: string): Promise<ConnectedUser>;
  disconnectUser(agentId: string, connectionId: string): Promise<void>;
  heartbeatUser(agentId: string, connectionId: string): Promise<void>;
  getConnectedUsers(agentId: string): Promise<ConnectedUser[]>;
  acquireComposerLock(
    agentId: string,
    connectionId: string,
    leaseId: string,
    startedAt: number,
  ): Promise<ComposerLock>;
  releaseComposerLock(agentId: string, connectionId: string, leaseId: string): Promise<void>;
  updateComposerDraft(
    agentId: string,
    connectionId: string,
    leaseId: string,
    text: string,
    sequence: number,
    attachments?: ImageAttachmentInput[],
  ): Promise<ComposerDraft>;
  clearHistory(agentId: string): Promise<string[]>;
  createEventSocket(agentId: string, connectionId?: string): Promise<EventSocketDescriptor>;
  sendPrompt(
    agentId: string,
    prompt: string,
    connectionId: string,
    composerLeaseId: string,
    attachments: ImageAttachmentInput[],
    configuration: AgentDefinition,
  ): Promise<void>;
  health(): Promise<void>;
}
