# MutliplayerAI-Backend

Standalone backend extracted from `mutliplayer-agent`.

- `server/`: Node gateway/proxy, agent catalog, integrations, image storage, and Cloudflare adapter.
- `durable-object-starter/`: Cloudflare Worker and per-agent Durable Objects for presence, collaborative prompts, and streaming chat.
- `shared/`: integration types used by the gateway, copied from the client project.

## Local development

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
