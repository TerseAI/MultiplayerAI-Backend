import { Composio } from "@composio/core";
import type { TSchema } from "@earendil-works/pi-ai";
import type { AgentToolExecution } from "./types";

type ComposioToolDefinition = {
	name: string;
	description?: string;
	parameters: TSchema;
};

export class ComposioTools {
	private readonly composio: Composio;

	constructor(apiKey: string) {
		this.composio = new Composio({
			apiKey,
			allowTracking: false,
			disableVersionCheck: true,
		});
	}

	async definitions(
		sessionId: string,
		enabledTools: string[],
	): Promise<ComposioToolDefinition[]> {
		const session = await this.composio.use(sessionId);
		const enabled = new Set(enabledTools);

		return (await session.tools()).flatMap((tool) =>
			tool.type === "function" && enabled.has(tool.function.name)
				? [
						{
							name: tool.function.name,
							description: tool.function.description,
							parameters: tool.function.parameters as TSchema,
						},
					]
				: [],
		);
	}

	async execute(
		sessionId: string,
		tool: string,
		arguments_: Record<string, unknown>,
	): Promise<AgentToolExecution> {
		const session = await this.composio.use(sessionId);
		const result = await session.execute(tool, arguments_);

		if (result.error) throw new Error(`${tool} failed: ${result.error}`);

		return {
			tool,
			data: result.data,
			logId: result.logId,
		};
	}
}
