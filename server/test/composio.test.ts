import assert from "node:assert/strict";
import { test } from "node:test";
import { ComposioIntegrations, type ComposioClient } from "../src/composio.js";
import { AgentStore } from "../src/agent-store.js";

function fixture() {
  const store = new AgentStore(":memory:");
  const created: { user: string; options: any }[] = [];
  let connected = true;
  let expired = false;
  const tools = [
    { slug: "GITHUB_READ", name: "Read issue", toolkit: { slug: "github" }, tags: ["readOnlyHint"] },
    { slug: "PUBLIC_READ", name: "Read docs", toolkit: { slug: "public" } },
  ];
  const catalog = {
    sessionId: "catalog-session",
    toolkits: async () => ({ items: [
      { slug: "github", name: "GitHub", isNoAuth: false, connection: { isActive: connected, connectedAccount: { id: "account" } } },
      { slug: "public", name: "Public docs", isNoAuth: true },
    ] }),
    authorize: async () => ({ redirectUrl: "https://connect.composio.dev/test" }),
  };
  const client = {
    use: async () => { if (expired) throw Object.assign(new Error("Expired"), { status: 410 }); return catalog; },
    sessions: { create: async (user: string, options: any) => {
      created.push({ user, options });
      return options.sessionPreset ? { sessionId: `execution-${created.length}` } : catalog;
    } },
    tools: { getRawComposioTools: async (query: { tools?: string[]; toolkits?: string[] }) => tools.filter(tool => query.tools ? query.tools.includes(tool.slug) : query.toolkits?.includes(tool.toolkit.slug)) },
    toolkits: { get: async (slug: string) => ({ name: slug === "github" ? "GitHub" : "Public docs" }) },
    connectedAccounts: { get: async () => ({ alias: "Workspace account", credentials: "must-not-leak" }) },
  } as unknown as ComposioClient;
  return { store, client, created, setConnected: (value: boolean) => { connected = value; }, expire: () => { expired = true; } };
}

const input = { name: "Agent", description: "", systemPrompt: "Be helpful", enabledTools: ["GITHUB_READ", "PUBLIC_READ"] };

test("Node manages catalog, authorization, and exact action sessions without a room backend", async () => {
  const f = fixture();
  try {
    const service = new ComposioIntegrations(f.store, f.client);
    const [apps] = await Promise.all([service.apps({}), service.apps({})]);
    assert.equal(f.created.length, 1, "Concurrent discovery creates one catalog session");
    assert.equal(f.store.setting("catalogSessionId"), "catalog-session");
    assert.equal(apps.items[0].accountLabel, "Workspace account");
    assert.equal(JSON.stringify(apps).includes("must-not-leak"), false);
    assert.equal("sessionId" in apps, false);
    assert.deepEqual(await service.authorize("github"), { url: "https://connect.composio.dev/test" });
    assert.equal((await service.tools("github")).items[0].readOnly, true);
    assert.deepEqual(await service.resolve([]), { items: [], truncated: false });
    const sessionId = await service.configure(input);
    assert.deepEqual(f.created.at(-1), { user: f.store.workspaceId(), options: {
      toolkits: ["github", "public"], tools: { github: ["GITHUB_READ"], public: ["PUBLIC_READ"] },
      sessionPreset: "direct_tools", manageConnections: false, sandbox: { enable: false },
    } });
    const saved = f.store.create(input, sessionId); service.markManaged(saved);
    const restarted = new ComposioIntegrations(f.store, f.client);
    const before = f.created.length;
    assert.equal(await restarted.configure({ ...input, enabledTools: [...input.enabledTools].reverse() }, saved), sessionId);
    assert.equal(f.created.length, before, "Saved managed sessions survive service restarts");
    assert.equal(await restarted.configure({ ...input, enabledTools: [] }, saved), "");
    await restarted.apps({});
    assert.equal(f.created.length, before, "Persisted catalog session is reused");
  } finally { f.store.close(); }
});

test("Unavailable actions and disconnected accounts cannot create execution sessions", async () => {
  const f = fixture();
  try {
    const service = new ComposioIntegrations(f.store, f.client);
    await assert.rejects(service.configure({ ...input, enabledTools: ["UNKNOWN"] }), { status: 400 });
    f.setConnected(false);
    await assert.rejects(service.configure(input), { status: 400 });
    assert.equal(f.created.some(call => call.options.sessionPreset), false);
    assert.ok(await service.configure({ ...input, enabledTools: ["PUBLIC_READ"] }));
    f.store.setSetting("catalogSessionId", "expired-session"); f.expire();
    await service.apps({});
    assert.equal(f.store.setting("catalogSessionId"), "catalog-session");
  } finally { f.store.close(); }
});
