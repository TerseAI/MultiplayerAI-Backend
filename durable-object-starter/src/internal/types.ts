export type AppEnv = Env & {
	COMPOSIO_API_KEY?: string;
	OPEN_ROUTER_API_KEY?: string;
	OPEN_ROUTER_MODEL?: string;
	TERSE_INTERNAL_SECRET?: string;
};

export type AgentToolConfig = {
	composioSessionId: string;
	enabledTools: string[];
	updatedAt: number;
};

export type ConfigureAgentToolsRequest = {
	composioSessionId?: string;
	enabledTools?: string[];
};

export type ExecuteAgentToolRequest = {
	arguments?: Record<string, unknown>;
};

export type AgentToolExecution = {
	tool: string;
	data: Record<string, unknown>;
	logId: string;
};

export type ConnectedUser = {
	connectionId: string;
	name: string;
	connectedAt: number;
};

export type StoredConnectedUser = ConnectedUser & {
	lastSeenAt: number;
};

export type ComposerLock = {
	leaseId: string;
	startedAt: number;
	user: ConnectedUser;
	expiresAt: number;
};

export type ComposerLockEvent = {
	type: "composer_lock";
	lock: ComposerLock | null;
};

export type ComposerDraft = {
	leaseId: string | null;
	sequence: number;
	text: string;
	attachments: ImageAttachment[];
	updatedAt: number;
};

export type ComposerDraftEvent = {
	type: "composer_draft";
	draft: ComposerDraft;
};

export type ImageAttachment = {
	id: string;
	type: "image";
	name: string;
	mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
	size: number;
	url: string;
};

export type PromptImageAttachment = ImageAttachment & {
	dataUrl: string;
};

export type ChatMessage = {
	id: string;
	role: "user" | "assistant";
	author: string;
	text: string;
	reasoning?: string;
	createdAt: number;
	status: "streaming" | "complete" | "failed";
	attachments?: ImageAttachment[];
};

export type AgentEvent =
	| { type: "history"; messages: ChatMessage[] }
	| { type: "connected_users"; users: ConnectedUser[] }
	| ComposerLockEvent
	| ComposerDraftEvent
	| {
			type: "generation_started";
			generationId: string;
			prompt: string;
			user: ConnectedUser;
			createdAt: number;
			attachments: ImageAttachment[];
		}
	| { type: "reasoning_delta"; generationId: string; delta: string }
	| { type: "text_delta"; generationId: string; delta: string }
	| {
			type: "generation_completed";
			generationId: string;
			text: string;
			reasoning: string;
		}
	| { type: "generation_failed"; generationId: string; message: string };

export type EventSocketAttachment = {
	connectionId: string | null;
};

export type ActiveGeneration = {
	message: ChatMessage;
	text: string;
	reasoning: string;
};

export type PromptGeneration = {
	generationId: string;
	prompt: string;
	user: ConnectedUser;
	attachments: ImageAttachment[];
	userMessage: ChatMessage;
	assistantMessage: ChatMessage;
};

export type ConnectUserRequest = {
	name?: string;
};

export type ComposerLockRequest = {
	leaseId?: string;
	startedAt?: number;
};

export type ComposerDraftRequest = {
	attachments?: ImageAttachment[];
	leaseId?: string;
	sequence?: number;
	text?: string;
};

export type PromptRequest = {
 configuration?: AgentConfiguration;
	prompt?: string;
	connectionId?: string;
	composerLeaseId?: string;
	attachments?: PromptImageAttachment[];
};

export type AgentConfiguration = {
 systemPrompt: string;
 composioSessionId: string;
 enabledTools: string[];
};
