import { Composio, type Tool } from "@composio/core";
import { z } from "zod";
import type { IntegrationApps, IntegrationTool, IntegrationTools } from "../../shared/integrations.js";
import type { AgentDefinition, AgentInput } from "./agent-schema.js";
import type { AgentStore } from "./agent-store.js";

type CatalogSession = Awaited<ReturnType<Composio["use"]>>;
export type ComposioClient = Pick<Composio, "use" | "sessions" | "tools" | "toolkits" | "connectedAccounts">;

// Management belongs with the agent catalog. The worker only receives saved execution configuration.
export class ComposioIntegrations {
  private client?: ComposioClient;
  private initializing?: Promise<CatalogSession>;
  private readonly appNames = new Map<string, string>();

  constructor(private readonly store: AgentStore, client?: ComposioClient) {
    this.client = client;
  }

  private sdk(): ComposioClient {
    if (!this.client) {
      const apiKey = process.env.COMPOSIO_API_KEY;
      if (!apiKey) throw Object.assign(new Error("App connections are not configured. Add COMPOSIO_API_KEY to the Node server environment."), { status: 503 });
      this.client = new Composio({ apiKey, allowTracking: false, disableVersionCheck: true });
    }
    return this.client;
  }

  private catalogSession(): Promise<CatalogSession> {
    this.initializing ??= this.loadCatalogSession().finally(() => { this.initializing = undefined; });
    return this.initializing;
  }

  private async loadCatalogSession(): Promise<CatalogSession> {
    const composio = this.sdk();
    const saved = this.store.setting("catalogSessionId");
    if (saved) {
      try { return await composio.use(saved); }
      catch (error) {
        const status = z.object({ status: z.number() }).safeParse(error);
        if (!status.success || ![404, 410].includes(status.data.status)) throw error;
      }
    }
    const session = await composio.sessions.create(this.store.workspaceId(), { sandbox: { enable: false } });
    this.store.setSetting("catalogSessionId", session.sessionId);
    return session;
  }

  async apps(query: { search?: string; cursor?: string; app?: string }): Promise<IntegrationApps> {
    const session = await this.catalogSession();
    const result = await session.toolkits({
      search: query.search || undefined, cursor: query.cursor, limit: 30,
      ...(query.app ? { toolkits: [query.app] } : {}),
    });
    const items = await Promise.all(result.items.map(async (app) => {
      let accountLabel: string | null = null;
      if (app.connection?.isActive && app.connection.connectedAccount) {
        const account = await this.sdk().connectedAccounts.get(app.connection.connectedAccount.id);
        accountLabel = account.alias || "Shared workspace account";
      }
      return { slug: app.slug, name: app.name, logo: app.logo ?? null,
        connected: app.connection?.isActive ?? false, requiresAuth: !app.isNoAuth, accountLabel };
    }));
    return { items, cursor: result.cursor ?? null };
  }

  async tools(app: string, search?: string): Promise<IntegrationTools> {
    const tools = await this.sdk().tools.getRawComposioTools({ toolkits: [app], search: search || undefined, limit: 100, important: false });
    return { items: await this.describeTools(tools.filter((tool) => !tool.isDeprecated)), truncated: tools.length >= 100 };
  }

  async resolve(tools: string[]): Promise<IntegrationTools> {
    if (!tools.length) return { items: [], truncated: false };
    const result = await this.sdk().tools.getRawComposioTools({ tools });
    return { items: await this.describeTools(result.filter((tool) => !tool.isDeprecated)), truncated: false };
  }

  async authorize(app: string): Promise<{ url: string }> {
    const session = await this.catalogSession();
    const link = await session.authorize(app);
    return { url: z.url().startsWith("https://").parse(link.redirectUrl) };
  }

  async configure(input: AgentInput, previous?: AgentDefinition): Promise<string> {
    if (!input.enabledTools.length) return "";
    const managed = previous && this.store.setting(`managedSession:${previous.id}`) === previous.composioSessionId;
    if (managed && [...previous.enabledTools].sort().join(",") === [...input.enabledTools].sort().join(",")) return previous.composioSessionId;

    const composio = this.sdk();
    const tools = await composio.tools.getRawComposioTools({ tools: input.enabledTools });
    if (tools.length !== input.enabledTools.length || tools.some((tool) => !input.enabledTools.includes(tool.slug) || tool.isDeprecated || !tool.toolkit)) {
      throw Object.assign(new Error("One of the selected actions is no longer available. Remove it and choose another."), { status: 400 });
    }
    const byApp: Record<string, string[]> = {};
    for (const tool of tools) (byApp[tool.toolkit!.slug] ??= []).push(tool.slug);
    const catalog = await this.catalogSession();
    const appSlugs = Object.keys(byApp);
    const batches = await Promise.all([appSlugs.slice(0, 50), appSlugs.slice(50)].filter((batch) => batch.length)
      .map((toolkits) => catalog.toolkits({ toolkits, limit: 50 })));
    const apps = batches.flatMap((batch) => batch.items);
    for (const slug of appSlugs) {
      const app = apps.find((item) => item.slug === slug);
      if (!app || (!app.isNoAuth && !app.connection?.isActive)) {
        throw Object.assign(new Error(`Connect ${app?.name ?? slug} before saving its actions.`), { status: 400 });
      }
    }
    const session = await composio.sessions.create(this.store.workspaceId(), {
      toolkits: appSlugs, tools: byApp, sessionPreset: "direct_tools",
      manageConnections: false, sandbox: { enable: false },
    });
    return session.sessionId;
  }

  markManaged(agent: AgentDefinition): void {
    this.store.setSetting(`managedSession:${agent.id}`, agent.composioSessionId);
  }

  private async describeTools(tools: Tool[]): Promise<IntegrationTool[]> {
    const appSlugs = [...new Set(tools.flatMap((tool) => tool.toolkit ? [tool.toolkit.slug] : []))];
    await Promise.all(appSlugs.map(async (slug) => {
      if (!this.appNames.has(slug)) this.appNames.set(slug, (await this.sdk().toolkits.get(slug)).name);
    }));
    return tools.map((tool) => ({
      slug: tool.slug, name: tool.name, description: tool.description ?? "",
      appSlug: tool.toolkit?.slug ?? "", appName: this.appNames.get(tool.toolkit?.slug ?? "") ?? tool.toolkit?.name ?? "App",
      readOnly: tool.tags?.includes("readOnlyHint") ?? false,
    }));
  }
}
