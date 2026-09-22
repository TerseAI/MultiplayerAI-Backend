# Terse agent sample

`src/actors.ts` exports `Agent`, ported from the neighboring `durable-object-starter`. It preserves its OpenRouter generation, Composio tools, image attachments, chat history, named connections, heartbeats, shared composer leases/drafts, and application event payloads.

`sendPrompt()` is `@Reentrant`. New clients can connect and receive partial assistant history while generation continues. Use `getSnapshot()` for the same history, connected-users, composer-lock, and composer-draft events over RPC.

## Local development

From the parent repo directory, run:

```sh
npm run dev:terse
```

The launcher links the SDK from the neighboring `ai-product-owner` checkout and the runtime from `little-durable-objects`, builds them, sets the binary and connection environment variables, regenerates the gateway client, and starts both services. No global linking or `/private/tmp` worktree is needed.

Put provider credentials in `terse-actors/.env`, or reuse the existing `durable-object-starter/.dev.vars`. The launcher reads both. The app continues to use the gateway at `http://127.0.0.1:8790`.

Connect via a socket grant for actor name `Agent`, with metadata `{ connectionId }` from `connectUser(name)`, or `{ connectionId: null }` for a read-only observer. A named user must acquire a composer lease before calling `sendPrompt(prompt, connectionId, leaseId, attachments, configuration)`. Heartbeats use the `heartbeatUser(connectionId)` RPC, matching the Durable Object.

The Express gateway uses the Terse adapter when started through `npm run dev:terse`. The existing Cloudflare commands remain available.

## Verification

```sh
pnpm build
pnpm test
DURABLE_OBJECT_BINARY="$PWD/../../little-durable-objects/target/debug/little-actors" \
  DURABLE_OBJECT_TELEMETRY=0 pnpm test:capabilities
```

The capability tests run the actual actor through Rust and WebSockets, against both TypeScript source and a compiled artifact. Only the model-generation boundary is replaced inside a temporary test copy. A controlled stream holds generation open while another client joins, reads partial history, heartbeats, and disconnects; completed history is then checked after a runtime restart with the original production model module restored. These tests do not call paid providers.

## Intentional differences

- Terse persisted fields replace Cloudflare storage; state currently saves when successful invocations complete.
- Terse `onConnect`/`onDisconnect` and `broadcast` replace Cloudflare socket APIs. Application event names and payloads are preserved; Terse also supplies its protocol-level state messages.
- Alarms are omitted. Expired composer locks are cleared on the next access, without background expiration events.
- Model clients and in-progress generation remain ephemeral, as in the original actor.
