import type {
	ActiveGeneration,
	AgentEvent,
	ChatMessage,
	ComposerDraft,
	ComposerLock,
	ConnectedUser,
	EventSocketAttachment,
} from "./types";

type AgentSnapshot = {
	messages: ChatMessage[];
	connectedUsers: ConnectedUser[];
	promptLock: ComposerLock | null;
	promptDraft: ComposerDraft;
	activeGeneration: ActiveGeneration | null;
};

export function snapshotEvents(snapshot: AgentSnapshot): AgentEvent[] {
	const messages = [...snapshot.messages];
	if (snapshot.activeGeneration) {
		messages.push({
			...snapshot.activeGeneration.message,
			text: snapshot.activeGeneration.text,
			reasoning: snapshot.activeGeneration.reasoning,
		});
	}

	return [
		{ type: "history", messages },
		{ type: "connected_users", users: snapshot.connectedUsers },
		{ type: "composer_lock", lock: snapshot.promptLock },
		{ type: "composer_draft", draft: snapshot.promptDraft },
	];
}

export function acceptEventSocket(
	ctx: DurableObjectState,
	connectionId: string | null,
	initialEvents: AgentEvent[],
): Response {
	const [client, server] = Object.values(new WebSocketPair());
	ctx.acceptWebSocket(server);
	server.serializeAttachment({ connectionId } satisfies EventSocketAttachment);
	for (const event of initialEvents) server.send(JSON.stringify(event));
	return new Response(null, { status: 101, webSocket: client });
}

export function broadcastAgentEvent(ctx: DurableObjectState, event: AgentEvent): void {
	const message = JSON.stringify(event);
	for (const socket of ctx.getWebSockets()) {
		try {
			socket.send(message);
		} catch {
			// Closed sockets disappear after the close handshake finishes.
		}
	}
}

export function socketConnectionId(socket: WebSocket): string | null {
	const attachment = socket.deserializeAttachment() as EventSocketAttachment | null;
	return typeof attachment?.connectionId === "string" ? attachment.connectionId : null;
}

export function hasOpenSocketForConnection(
	ctx: DurableObjectState,
	connectionId: string,
	excluding?: WebSocket,
): boolean {
	return ctx.getWebSockets().some(
		(socket) =>
			socket !== excluding &&
			socket.readyState === WebSocket.OPEN &&
			socketConnectionId(socket) === connectionId,
	);
}

export function liveSocketConnectionIds(ctx: DurableObjectState): Set<string> {
	return new Set(
		ctx
			.getWebSockets()
			.filter((socket) => socket.readyState === WebSocket.OPEN)
			.map(socketConnectionId)
			.filter((connectionId): connectionId is string => Boolean(connectionId)),
	);
}
