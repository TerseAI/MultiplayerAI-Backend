import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { AgentDefinition, AgentInput } from "./agent-schema.js";

export class AgentStore {
  private readonly db: DatabaseSync;

  constructor(path = process.env.AGENT_DB_PATH ?? fileURLToPath(new URL("../.data/agents.sqlite", import.meta.url))) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, definition TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      if (!this.db.prepare("SELECT version FROM migrations WHERE version = 1").get()) {
        for (const [id, name, description] of [
          ["hello-world", "General Agent", "Default playground room"],
          ["research-agent", "Research Agent", "Independent test room"],
          ["planning-agent", "Planning Agent", "Independent test room"],
        ]) {
          this.insert({
            id, name, description,
            systemPrompt: "You are a helpful assistant.",
            composioSessionId: "",
            enabledTools: [],
          });
        }
        this.db.exec("INSERT INTO migrations VALUES (1)");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw error;
    }
  }

  list(): AgentDefinition[] {
    return this.db.prepare("SELECT definition FROM agents ORDER BY rowid").all().map((row) => JSON.parse(row.definition as string));
  }

  get(id: string): AgentDefinition | undefined {
    const row = this.db.prepare("SELECT definition FROM agents WHERE id = ?").get(id);
    return row ? JSON.parse(row.definition as string) : undefined;
  }

  create(input: AgentInput, composioSessionId = ""): AgentDefinition {
    const agent = { ...input, composioSessionId, id: randomUUID() };
    this.insert(agent);
    return agent;
  }

  update(id: string, input: AgentInput, composioSessionId = ""): AgentDefinition | undefined {
    const agent = { ...input, composioSessionId, id };
    const result = this.db.prepare("UPDATE agents SET definition = ? WHERE id = ?")
      .run(JSON.stringify(agent), id);
    return result.changes ? agent : undefined;
  }

  delete(id: string): boolean {
    return Boolean(this.db.prepare("DELETE FROM agents WHERE id = ?").run(id).changes);
  }

  setting(key: string): string | undefined {
    return this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value as string | undefined;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  workspaceId(): string {
    let id = this.setting("workspaceId");
    if (!id) { id = `workspace-${randomUUID()}`; this.setSetting("workspaceId", id); }
    return id;
  }

  close(): void {
    this.db.close();
  }

  private insert(agent: AgentDefinition): void {
    this.db.prepare("INSERT INTO agents (id, definition) VALUES (?, ?)").run(agent.id, JSON.stringify(agent));
  }
}
