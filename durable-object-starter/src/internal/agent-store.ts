import type {
	AgentToolConfig,
	ChatMessage,
	ComposerDraft,
	ComposerLock,
	StoredConnectedUser,
} from "./types";

const CONNECTION_KEY_PREFIX = "connection:";
const MESSAGE_KEY_PREFIX = "message:";
const COMPOSER_LOCK_KEY = "composer-lock";
const COMPOSER_DRAFT_KEY = "composer-draft";
const TOOL_CONFIG_KEY = "tool-config";

export class AgentStore {
	constructor(private readonly storage: DurableObjectStorage) {}

	async toolConfig(): Promise<AgentToolConfig | null> {
		return (await this.storage.get<AgentToolConfig>(TOOL_CONFIG_KEY)) ?? null;
	}

	async saveToolConfig(config: AgentToolConfig): Promise<void> {
		await this.storage.put(TOOL_CONFIG_KEY, config);
	}

	async connectedUser(connectionId: string): Promise<StoredConnectedUser | null> {
		return (
			(await this.storage.get<StoredConnectedUser>(
				`${CONNECTION_KEY_PREFIX}${connectionId}`,
			)) ?? null
		);
	}

	async connectedUsers(): Promise<StoredConnectedUser[]> {
		const users = await this.storage.list<StoredConnectedUser>({
			prefix: CONNECTION_KEY_PREFIX,
		});
		return [...users.values()].sort((left, right) => left.connectedAt - right.connectedAt);
	}

	async saveConnectedUser(user: StoredConnectedUser): Promise<void> {
		await this.storage.put(`${CONNECTION_KEY_PREFIX}${user.connectionId}`, user);
	}

	async touchConnectedUser(connectionId: string): Promise<StoredConnectedUser> {
		const user = await this.connectedUser(connectionId);
		if (!user) throw new Error("That connection is no longer active");
		const refreshedUser = { ...user, lastSeenAt: Date.now() };
		await this.saveConnectedUser(refreshedUser);
		return refreshedUser;
	}

	async deleteConnectedUser(connectionId: string): Promise<boolean> {
		return await this.storage.delete(`${CONNECTION_KEY_PREFIX}${connectionId}`);
	}

	async deleteConnectedUsers(connectionIds: string[]): Promise<void> {
		if (connectionIds.length === 0) return;
		await this.storage.delete(
			connectionIds.map((connectionId) => `${CONNECTION_KEY_PREFIX}${connectionId}`),
		);
	}

	async messages(): Promise<ChatMessage[]> {
		const messages = await this.storage.list<ChatMessage>({ prefix: MESSAGE_KEY_PREFIX });
		return [...messages.values()];
	}

	async saveMessage(message: ChatMessage): Promise<void> {
		const timestamp = String(message.createdAt).padStart(13, "0");
		const position = message.role === "user" ? "0" : "1";
		await this.storage.put(
			`${MESSAGE_KEY_PREFIX}${timestamp}:${position}:${message.id}`,
			message,
		);
	}

	async deleteMessages(): Promise<ChatMessage[]> {
		const messages = await this.storage.list<ChatMessage>({ prefix: MESSAGE_KEY_PREFIX });
		const keys = [...messages.keys()];
		for (let index = 0; index < keys.length; index += 128) {
			await this.storage.delete(keys.slice(index, index + 128));
		}
		return [...messages.values()];
	}

	async promptLock(): Promise<ComposerLock | null> {
		return (await this.storage.get<ComposerLock>(COMPOSER_LOCK_KEY)) ?? null;
	}

	async savePromptLock(lock: ComposerLock): Promise<void> {
		await this.storage.put(COMPOSER_LOCK_KEY, lock);
	}

	async deletePromptLock(): Promise<void> {
		await this.storage.delete(COMPOSER_LOCK_KEY);
	}

	async schedulePromptLockExpiration(expiresAt: number): Promise<void> {
		await this.storage.setAlarm(expiresAt);
	}

	async clearPromptLockExpiration(): Promise<void> {
		await this.storage.deleteAlarm();
	}

	async promptDraft(): Promise<ComposerDraft | null> {
		return (await this.storage.get<ComposerDraft>(COMPOSER_DRAFT_KEY)) ?? null;
	}

	async savePromptDraft(draft: ComposerDraft): Promise<void> {
		await this.storage.put(COMPOSER_DRAFT_KEY, draft);
	}
}
