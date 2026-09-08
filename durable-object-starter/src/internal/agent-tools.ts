import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentRuntime } from "./agent-runtime";
import { ComposioTools } from "./composio";
import type { AgentToolConfig } from "./types";
import { validIdentifier } from "./validation";

export async function configureTools(
	runtime: AgentRuntime,
	composioSessionId: string,
	enabledTools: string[],
): Promise<AgentToolConfig> {
	const cleanSessionId = composioSessionId.trim();
	if (!validIdentifier(cleanSessionId)) throw new Error("A valid Composio session ID is required");

	const cleanTools = [...new Set(enabledTools.map((tool) => tool.trim()))];
	if (cleanTools.some((tool) => !validIdentifier(tool))) {
		throw new Error("Every enabled tool must have a valid tool name");
	}

	const config: AgentToolConfig = {
		composioSessionId: cleanSessionId,
		enabledTools: cleanTools,
		updatedAt: Date.now(),
	};
	await runtime.store.saveToolConfig(config);
	return config;
}

export async function getToolConfig(runtime: AgentRuntime): Promise<AgentToolConfig | null> {
	return await runtime.store.toolConfig();
}

export async function executeTool(
	runtime: AgentRuntime,
	tool: string,
	arguments_: Record<string, unknown>,
) {
	const composio = composioTools(runtime);
	const config = await getToolConfig(runtime);
	if (!config) throw new Error("Tools have not been configured for this agent");
	if (!config.enabledTools.includes(tool)) throw new Error(`${tool} is not enabled for this agent`);

	return await composio.execute(config.composioSessionId, tool, arguments_);
}

export async function modelTools(runtime: AgentRuntime, configuration?: AgentToolConfig): Promise<AgentTool[]> {
	const config = configuration ?? await getToolConfig(runtime);
	if (!config?.enabledTools.length) return [];

	const definitions = await composioTools(runtime).definitions(
		config.composioSessionId,
		config.enabledTools,
	);
	if (definitions.length !== config.enabledTools.length) {
		throw new Error("An enabled tool is unavailable in the Composio session");
	}

	return definitions.map((definition) => ({
		name: definition.name,
		label: definition.name,
		description: definition.description ?? definition.name,
		parameters: definition.parameters,
		executionMode: "sequential",
		execute: async (_toolCallId, arguments_) => {
			const execution = await composioTools(runtime).execute(
				config.composioSessionId,
				definition.name,
				arguments_ as Record<string, unknown>,
			);
			return {
				content: [{ type: "text", text: JSON.stringify(execution.data) }],
				details: execution,
			};
		},
	}));
}

function composioTools(runtime: AgentRuntime): ComposioTools {
	const apiKey = runtime.env.COMPOSIO_API_KEY;
	if (!apiKey) throw new Error("Missing COMPOSIO_API_KEY");
	return new ComposioTools(apiKey);
}
