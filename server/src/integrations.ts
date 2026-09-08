import { Router } from "express";
import { z } from "zod";
import type { ComposioIntegrations } from "./composio.js";

const slug = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/);
const searchQuery = z.object({ search: z.string().trim().max(120).optional(), cursor: z.string().max(2000).optional(), app: slug.optional() });
const selectedTools = z.object({ tools: z.array(slug).max(100) });

export function integrationsRouter(integrations: ComposioIntegrations): Router {
  const router = Router();
  router.get("/apps", async (request, response) => {
    response.json(await integrations.apps(searchQuery.parse(request.query)));
  });
  router.get("/tools", async (request, response) => {
    const { app, search } = searchQuery.extend({ app: slug }).parse(request.query);
    response.json(await integrations.tools(app, search));
  });
  router.post("/tools/resolve", async (request, response) => {
    const { tools } = selectedTools.parse(request.body);
    response.json(await integrations.resolve(tools));
  });
  router.post("/apps/:app/connect", async (request, response) => {
    response.json(await integrations.authorize(slug.parse(request.params.app)));
  });
  return router;
}
