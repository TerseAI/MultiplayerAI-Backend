# Terse agent sample

`src/actors.ts` exports `Agent`, ported from the neighboring `durable-object-starter`. It preserves its OpenRouter generation, Composio tools, image attachments, chat history, named connections, heartbeats, shared composer leases/drafts, and application event payloads.

`sendPrompt()` is `@Reentrant`. New clients can connect and receive partial assistant history while generation continues. Use `getSnapshot()` for the same history, connected-users, composer-lock, and composer-draft events over RPC.

## Local dependencies

This checkout currently uses the unreleased SDK from `/private/tmp/terse-reentrant-sdk/packages/terse-sdk`, linked into `node_modules/terse-sdk`. The local runtime SDK comes from `../../little-durable-objects/sdk`. Reinstalling dependencies may replace the Terse SDK link; restore it with:

```sh
pnpm link /private/tmp/terse-reentrant-sdk/packages/terse-sdk
```

Build the runtime and SDK from `little-durable-objects` before starting the sample:

```sh
cargo build --locked
pnpm --dir sdk build
```

From this directory, copy `.env.example` to `.env`, set the provider credentials, and run the local Terse CLI:

```sh
DURABLE_OBJECT_BINARY="$PWD/../../little-durable-objects/target/debug/little-actors" \
  node /private/tmp/terse-reentrant-sdk/packages/terse-cli/dist/index.js actor serve
```

Connect via a socket grant for actor name `Agent`, with metadata `{ connectionId }` from `connectUser(name)`, or `{ connectionId: null }` for a read-only observer. A named user must acquire a composer lease before calling `sendPrompt(prompt, connectionId, leaseId, attachments, configuration)`. Heartbeats use the `heartbeatUser(connectionId)` RPC, matching the Durable Object.

The neighboring Express gateway still targets Cloudflare. This change ports the actor; it does not switch that gateway or deploy anything.

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
