# MutliplayerAI-Backend

Standalone backend extracted from `mutliplayer-agent`.

- `server/`: Node gateway/proxy, agent catalog, integrations, image storage, and Cloudflare/Terse adapters.
- `durable-object-starter/`: Cloudflare Worker and per-agent Durable Objects for presence, collaborative prompts, and streaming chat.
- `shared/`: integration types used by the gateway, copied from the client project.

## Local Terse development

With `little-durable-objects`, `ai-product-owner`, and this repo next to each other, run:

```sh
npm run dev:terse
```

This links and builds the local SDK/runtime, starts Terse on port 7100, regenerates the `Agent` client, and starts the gateway on port 8790. Your frontend keeps using `http://127.0.0.1:8790`. Ctrl+C stops both services; actor source edits reload automatically. Restart this command after changing the actor's public API to regenerate the gateway client.

The launcher sets `DURABLE_OBJECT_BINARY`, `TERSE_ACTOR_URL`, `TERSE_API_KEY`, and `ACTOR_BACKEND=terse` for its child processes. No global `npm link` or manual credential copying is needed. It reads `server/.env`, then `durable-object-starter/.dev.vars`, then `terse-actors/.env`; later files override earlier ones, and existing shell variables take precedence. Provider keys are kept in these existing ignored files. Set `OPEN_ROUTER_API_KEY` for live prompts and `COMPOSIO_API_KEY` when using tools.

Prerequisites are Node.js 22.13+, Bun, pnpm, Rust, and installed dependencies in the three checkouts. `TERSE_REPO` and `LITTLE_ACTORS_REPO` can override the sibling repository locations. `PORT` overrides the gateway port; `TERSE_RUNTIME_PORT` overrides 7100. Terse local state is separate from Wrangler state.

## Cloudflare local development

Requires Node.js 22.13 or newer (Node 24 recommended).

```sh
npm run install:all
cp server/.env.example server/.env
cp durable-object-starter/.dev.vars.example durable-object-starter/.dev.vars
```

Fill in the environment files with your credentials. If local environment files already exist, keep them instead of copying over them. The gateway and Worker must use the same `TERSE_INTERNAL_SECRET`. Composio needs its API key in both services when using integrations.

Run in separate terminals:

```sh
npm run dev:worker
npm run dev:gateway
```

The Worker listens on port 8791 and the gateway on port 8790. Clients connect to the gateway. Local environment files, gateway data (`server/.data`), Wrangler state, and dependencies are ignored by Git. Existing local files were preserved during extraction.

## Verification

```sh
npm run check
npm test
```

The client project's `npm run test:smoke` exercises the running backend end to end.

## Deployment

```sh
npm run deploy:worker
```

Worker deployment names, bindings, and migrations remain in `durable-object-starter/wrangler.jsonc`. The gateway runs separately and requires persistent storage for its SQLite database and images.
