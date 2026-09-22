import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readlink, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtimeRepo = path.resolve(process.env.LITTLE_ACTORS_REPO ?? path.join(root, "../little-durable-objects"));
const terseRepo = path.resolve(process.env.TERSE_REPO ?? path.join(root, "../ai-product-owner"));
const actorsDir = path.join(root, "terse-actors");
const serverDir = path.join(root, "server");
const runtimeSdk = path.join(runtimeRepo, "sdk");
const terseSdk = path.join(terseRepo, "packages/terse-sdk");
const terseCli = path.join(terseRepo, "packages/terse-cli");
const children = new Set();
let stopping = false;
process.once("SIGINT", () => { stopping = true; void stopChildren(); });
process.once("SIGTERM", () => { stopping = true; void stopChildren(); });

try {
  await main();
} catch (error) {
  if (!stopping) { console.error(error.message); process.exitCode = 1; }
} finally {
  await stopChildren();
}

async function main() {
  console.log("Preparing the local Terse SDK and runtime…");
  await linkPackages();
  await run("cargo", ["build", "--locked"], runtimeRepo);
  await run("pnpm", ["--dir", runtimeSdk, "build"], root);
  await run("pnpm", ["--dir", path.join(terseRepo, "terse-types"), "build"], root);
  await run("pnpm", ["--dir", terseSdk, "build"], root);
  await run("pnpm", ["--dir", terseCli, "build"], root);
  if (stopping) return;
  const environment = await localEnvironment();
  const configuration = JSON.parse(await readFile(path.join(actorsDir, "terse.config.json"), "utf8"));
  const runtimePort = Number(environment.TERSE_RUNTIME_PORT ?? 7100);
  if (!Number.isInteger(runtimePort) || runtimePort < 1 || runtimePort > 65535) throw new Error("TERSE_RUNTIME_PORT must be between 1 and 65535");
  const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
  const apiKey = randomBytes(24).toString("hex");
  const actorUrl = `${runtimeUrl}/v1/projects/${encodeURIComponent(configuration.projectId)}/actors`;
  const env = {
    ...environment,
    ACTOR_BACKEND: "terse",
    DURABLE_OBJECT_BINARY: path.join(runtimeRepo, "target/debug/little-actors"),
    DURABLE_OBJECT_API_KEY: apiKey,
    DURABLE_OBJECT_PARENT_LIFETIME_STDIN: "1",
    TERSE_ACTOR_URL: actorUrl,
    TERSE_API_KEY: apiKey,
  };
  if (!env.OPEN_ROUTER_API_KEY) console.log("Add OPEN_ROUTER_API_KEY to terse-actors/.env for live prompts (existing durable-object-starter/.dev.vars is also read).");
  const runtime = start(process.execPath, [path.join(runtimeSdk, "dist/cli.js"), "dev", "--project-id", configuration.projectId, "--project", actorsDir, "--entrypoint", "src/actors.ts", "--port", String(runtimePort), "--storage", "local"], actorsDir, env);
  await waitForContract(`${actorUrl.replace(/\/actors$/, "/deployment/contract")}`, apiKey, runtime);
  await run(process.execPath, [path.join(terseCli, "dist/index.js"), "actor", "generate", "--out-dir", "src/terse.actors"], serverDir, env);
  if (stopping) return;
  const gateway = start(process.execPath, ["--import", "tsx", "src/index.ts"], serverDir, env);
  console.log(`Local Terse runtime: ${runtimeUrl}`);
  console.log(`Gateway: http://${env.HOST ?? "127.0.0.1"}:${env.PORT ?? 8790}. Your app keeps using this URL.`);
  console.log("Actor source changes reload automatically. Ctrl+C stops both processes.");
  const result = await Promise.race([runtime.closed, gateway.closed]);
  if (!stopping) throw new Error(`Local service stopped (${result.code ?? result.signal ?? result.error?.message}).`);
}

async function linkPackages() {
  for (const [directory, name, target] of [
    [terseSdk, "little-actors", runtimeSdk],
    [terseCli, "little-actors", runtimeSdk],
    [actorsDir, "terse-sdk", terseSdk],
    [actorsDir, "little-actors", runtimeSdk],
    [serverDir, "terse-sdk", terseSdk],
  ]) await linkPackage(directory, name, target);
}

async function linkPackage(directory, name, target) {
  const destination = path.join(directory, "node_modules", name);
  const existing = await lstat(destination).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (existing) {
    if (!existing.isSymbolicLink()) throw new Error(`${destination} is an installed directory. Remove that dependency directory before linking the local checkout.`);
    if (path.resolve(path.dirname(destination), await readlink(destination)) === target) return;
    await unlink(destination);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(target, destination, "dir");
}

async function localEnvironment() {
  let environment = {};
  for (const file of ["server/.env", "durable-object-starter/.dev.vars", "terse-actors/.env"]) {
    try { environment = { ...environment, ...parseEnv(await readFile(path.join(root, file), "utf8")) }; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { ...environment, ...process.env };
}

function start(command, args, cwd, env = process.env) {
  if (stopping) throw new Error("Startup cancelled");
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "inherit", "inherit"] });
  const closed = new Promise(resolve => {
    child.once("error", error => resolve({ error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const service = { child, closed, exited: false };
  children.add(service);
  void closed.then(() => { service.exited = true; children.delete(service); });
  return service;
}

async function run(command, args, cwd, env) {
  const { closed } = start(command, args, cwd, env);
  const result = await closed;
  if (result.code !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.signal ?? result.code}`);
}

async function waitForContract(url, apiKey, runtime) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !stopping && !runtime.exited) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(1000) }).catch(() => undefined);
    if (response) { await response.body?.cancel(); if (response.ok) return; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("The local actor runtime did not become ready. Check its output above.");
}

async function stopChildren() {
  const running = [...children];
  for (const { child } of running) { child.stdin?.end(); child.kill("SIGTERM"); }
  const force = setTimeout(() => { for (const { child } of running) child.kill("SIGKILL"); }, 10000);
  force.unref();
  try { await Promise.all(running.map(service => service.closed)); }
  finally { clearTimeout(force); }
}
