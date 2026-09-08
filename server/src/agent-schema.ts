import { z } from "zod";

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/;

export const agentInputSchema = z.object({
  name: z.string().trim().min(1, "A name is required.").max(80),
  description: z.string().trim().max(240),
  systemPrompt: z.string().trim().min(1, "A system prompt is required.").max(20_000),
  enabledTools: z.array(z.string().regex(identifier, "Enter a valid tool name."))
    .max(100)
    .transform((tools) => [...new Set(tools)]),
});

export type AgentInput = z.infer<typeof agentInputSchema>;
export type AgentDefinition = AgentInput & { id: string; composioSessionId: string };

export function publicAgent({ composioSessionId: _sessionId, ...agent }: AgentDefinition): AgentInput & { id: string } {
  return agent;
}
