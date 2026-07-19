# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Backend-only Node.js 20+ example of three independent Hapi servers communicating over the A2A 0.3 JSON-RPC protocol: a Router Agent and two specialists (Math, Writing). The Router uses the OpenAI Agents SDK with two function tools (`ask_math_specialist`, `ask_writing_specialist`) that discover specialists via their published Agent Card and call them over real HTTP — specialists are never imported or invoked directly in-process.

```text
Client -> Router Agent (:4000)
             |-- A2A HTTP -> Math Specialist (:4001)
             `-- A2A HTTP -> Writing Specialist (:4002)
```

Every server exposes exactly three public routes: `GET /.well-known/agent-card.json`, `POST /a2a/jsonrpc`, `GET /health`.

## Commands

- `npm install` — install dependencies.
- `cp .env.example .env` — create local config; set a valid `OPENAI_API_KEY` before live (non-test) runs.
- `npm start` — launches Math (4001) and Writing (4002) specialists, then the Router (4000), in that order.
- `npm test` — run the full Vitest suite once. Does not require an API key (OpenAI runs are mocked).
- `npm run test:watch` — rerun affected tests on change.
- `npm run lint` — ESLint over all JS.
- Run a single test file: `npx vitest run test/router.test.js`
- Run tests matching a name: `npx vitest run -t "some test name"`

There is no build/transpile step — plain ESM `.js` runs directly.

## Architecture

- `src/config.js` — loads and Zod-validates environment config (`loadConfig`), derives agent URLs, ports, logging options (`logLevel`, `logPretty`), and a `langfuse` block (`enabled`, `publicKey`, `secretKey`, `baseUrl`). This is the single source of truth for ports/URLs/timeouts/logging/tracing; nothing else reads `process.env` directly.
- `src/logger.js` — `createLogger({ level, pretty, silent })` builds a Winston logger: structured JSON by default, colorized human-readable output when `pretty: true`. Exports a shared `noopLogger` (silent) used as the default for every `logger` DI param so library modules and tests stay quiet unless a real logger is injected.
- `src/tracing.js` — `initTracing(config, logger)` (async) boots Langfuse tracing for the process when `config.langfuse.enabled`; otherwise returns a no-op. When enabled, it starts an OTel `NodeSDK` with a `LangfuseSpanProcessor` and registers `LangfuseAgentsBridge` (implements the `@openai/agents-core` `TracingProcessor` interface) via `addTraceProcessor`, mapping each Agents SDK trace/span into a Langfuse observation (`generation`/`tool`/`agent`/`span`) while preserving parent/child structure. It also calls `resolveLangfuseProjectId` once at startup — via a `LangfuseClient` (`@langfuse/client`) `api.projects.get()` call, cached for the process lifetime — to build direct UI links without a per-request network call. Returns `{ enabled, withSession, getSessionUrl, shutdown }`: `withSession(sessionId, fn)` wraps a run in `propagateAttributes({ sessionId }, fn)` from `@langfuse/tracing` so every observation it creates is tagged with that Langfuse session; `getSessionUrl(sessionId)` returns `${baseUrl}/project/${projectId}/sessions/${sessionId}`, or `undefined` if the project id never resolved (bad keys, no network — logged as a `warn`, never thrown); `shutdown()` force-flushes and tears down the SDK and the `LangfuseClient`.
- `src/cluster.js` — `createAgentCluster(config, overrides)` wires everything together: builds the two specialist Agents, the Router Agent (with its remote tools), and one `createA2AServer(...)` per role. Accepts test overrides (`runAgent`, `logger`, `clientFactoryFactory`, `withSession`, `getSessionUrl`) for dependency injection.
- `src/launcher.js` — `startAgentCluster` starts servers in order (math, writing, router) with rollback on failure, and returns a `stop` function that shuts down in reverse order. `installShutdownHandlers` wires `SIGINT`/`SIGTERM` to that stop function and an optional `onShutdown` callback (used to flush tracing) run after `stop()` completes.
- `src/index.js` — the actual entrypoint (`npm start`): loads config, awaits `initTracing`, builds the cluster (injecting `tracing.withSession`/`tracing.getSessionUrl`), starts it, installs shutdown handlers (injecting `tracing.shutdown` as `onShutdown`).
- `src/a2a/server.js` — `createA2AServer` builds one Hapi server per agent role, backed by the SDK's `DefaultRequestHandler` + `InMemoryTaskStore` + `JsonRpcTransportHandler`. Streaming responses are explicitly rejected (not enabled in this example). An `onPreResponse` extension logs one structured line per request (`method`, `path`, `status`, `ms`) via the injected `logger`.
- `src/a2a/executor.js` — `OpenAIAgentExecutor` adapts an OpenAI Agents SDK `Agent` into an A2A executor: extracts user text, derives a tracing `sessionId` (from incoming message metadata, falling back to the request's own `contextId`), logs `'langfuse session'` at `info` with `{ sessionId, url }` when the injected `getSessionUrl` resolves a link, runs the agent inside the injected `withSession` wrapper (passing `sessionId` as both `groupId` and `context.sessionId`), publishes a single `Message` event, and calls `eventBus.finished()`. Responses are always direct/blocking `Message` objects, never streamed `Task` updates. `cancelTask()` is an intentional no-op — there are no background tasks. Logs at `debug` around each run and at `error` (with the structured `err`) on failure.
- `src/a2a/messages.js` — Zod-validated helpers for building and parsing A2A wire messages: `extractUserText` (incoming), `createAgentMessage`/`createUserMessage` (outgoing, `createUserMessage` accepts optional `metadata`), `extractSessionId` (reads `metadata.sessionId` off an incoming message), `extractA2AResultText` (parses a remote result that may be a `Message` or a `Task`, falling back through status message → history → artifacts to find text).
- `src/agents/cards.js` — builds the three Agent Cards (`createRouterCard`, `createMathCard`, `createWritingCard`) advertised at `/.well-known/agent-card.json`. All cards declare `streaming: false`, `pushNotifications: false`, JSON-RPC as the only transport.
- `src/agents/specialists.js` — defines the Math and Writing `Agent` instructions (plain OpenAI Agents SDK agents, no tools).
- `src/agents/router.js` — defines the Router `Agent`: instructions enforce that it must call at least one specialist tool (`toolChoice: 'required'`) and never do math/writing work itself; supports calling both specialists in parallel for mixed requests.
- `src/agents/remote-tools.js` — `createSpecialistTool` wraps a remote agent as an OpenAI Agents SDK `tool()`; its `execute` reads `sessionId` off the run's `RunContext.context` (set by `executor.js`) and forwards it into `callRemoteAgent`. `callRemoteAgent` resolves the specialist's Agent Card via `ClientFactory`/`DefaultAgentCardResolver`, sends a blocking `message/send` (with `sessionId` riding in the outgoing message's `metadata`, if present), and enforces per-call timeouts via `AbortSignal`. Remote failures surface as `RemoteAgentError` and are turned into a short natural-language message the Router model sees (via `errorFunction`), not a thrown tool error. Logs at `debug` around each remote call and at `warn` on failure.

### Key architectural invariants

- The Router never imports specialist Agents directly — all cross-agent communication goes through real A2A HTTP calls, even in the local demo. Tests preserve this: `test/architecture.test.js` and router/remote-tools tests exercise actual loopback HTTP where A2A discovery/JSON-RPC behavior matters, while OpenAI model calls are mocked.
- Config flows one way: env → `loadConfig` → `config` object → `createAgentCluster`. Don't reintroduce direct `process.env` reads elsewhere; `LOG_LEVEL`/`LOG_FORMAT`/`NODE_ENV` are the only inputs to logging behavior, and `LANGFUSE_*` are the only inputs to tracing behavior — both flow through `loadConfig` like everything else.
- Dependency injection points (`runAgent`, `logger`, `clientFactoryFactory`, `withSession`, `getSessionUrl`) exist specifically so tests can substitute fakes at the network/model/tracing boundary — use these rather than mocking modules when adding tests. Every `logger` param defaults to the shared `noopLogger` from `src/logger.js`, not `console`; `withSession`/`getSessionUrl` default to passthrough no-ops. Only `src/index.js` builds and injects the real Winston logger and calls `initTracing`.
- Tracing is opt-in and off by default (`config.langfuse.enabled` is false unless both `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set, or `LANGFUSE_TRACING=true` explicitly forces it). With tracing disabled, `initTracing` returns no-ops and behavior is identical to before it existed — don't add code paths that assume tracing is active.
- Each of the three agents' `run()` calls emits its own top-level Langfuse trace (this app does not attempt one distributed span tree across the A2A HTTP hop). What ties Router/Math/Writing traces together is a shared `sessionId`: seeded from the inbound request's `contextId` at the first hop, carried across A2A calls via A2A message `metadata.sessionId`, and applied via `withSession`/`propagateAttributes` so Langfuse groups all three traces into one session.

## Coding style

- Plain `.js` ESM (`import`/`export`), async/await, two-space indent, semicolons, single quotes.
- `camelCase` for functions/variables, `PascalCase` for classes, kebab-case filenames (e.g. `remote-tools.js`).
- Prefer small named exports and dependency injection at network/model boundaries.
- No CommonJS, no Express, no TypeScript, no frontend code.

## Logging conventions

- Use the injected logger rather than `console`. Reusable modules default logger parameters to `noopLogger`; only `src/index.js` creates and injects the configured Winston logger.
- Use a stable event message with structured metadata, for example `logger.info('request completed', { method, path, status, ms })`.
- Pass exceptions as `{ err: error }`; `src/logger.js` normalizes `Error` values for both JSON and pretty output.
- Do not log credentials, authorization values, or complete user/model payloads. Inject logger spies for log assertions and otherwise let tests use `noopLogger`.
- `LOG_LEVEL` controls verbosity. `LOG_FORMAT=json|pretty` selects formatting; if it is unset, only `NODE_ENV=development` enables pretty output.

## Testing

- Vitest, files under `test/` matching `*.test.js`, generally mirroring a `src/` file (e.g. `src/a2a/server.js` ↔ `test/server.test.js`).
- Mock OpenAI model runs; use real loopback HTTP for A2A discovery/JSON-RPC transport behavior.
- Cover success, validation errors, timeouts, and lifecycle cleanup for behavior changes.
- No numeric coverage threshold — every behavior change should include focused regression coverage instead.

## Security & configuration

- Never commit `.env` or API keys; keep `.env.example` limited to placeholders/safe defaults.
- This is an intentionally unauthenticated, local-demo scope with in-memory task storage — don't add auth unless a change explicitly requires and documents it.
- Optional Langfuse tracing is configured via `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` (default `https://us.cloud.langfuse.com`), and `LANGFUSE_TRACING` (`true`/`false`, overrides the key-presence default). The Langfuse **public** key and base URL are safe to commit in `.env.example`; `LANGFUSE_SECRET_KEY` must stay blank there and only be set in a local, gitignored `.env`.
- When tracing is enabled, `initTracing` makes one authenticated call to the Langfuse API at startup (`GET /api/public/projects`, to resolve the project id used in session URLs). This is the only outbound network call tracing adds beyond span export; if it fails (bad keys, no network), `initTracing` logs a `warn` and continues with `getSessionUrl` returning `undefined` rather than failing startup.
