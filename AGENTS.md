# Repository Guidelines

## Project Structure & Module Organization

This is a backend-only Node.js 20+ project using ECMAScript modules. Runtime code lives in `src/`: shared A2A transport and executor helpers are under `src/a2a/`, agent cards, specialists, router, and remote tools are under `src/agents/`, Winston setup is isolated in `src/logger.js`, optional Langfuse tracing is isolated in `src/tracing.js`, and cluster startup is handled by `src/cluster.js`, `src/launcher.js`, and `src/index.js`. Tests live in `test/` and mirror runtime concerns, for example `src/a2a/server.js` is covered by `test/server.test.js` and `src/logger.js` by `test/logger.test.js`. There are no frontend assets, generated sources, TypeScript files, or build output directories.

`src/tracing.js` exports `initTracing(config, logger)` (async), called once from `src/index.js`. When `config.langfuse.enabled` is false (the default), it returns no-ops and nothing else in the app behaves differently. When enabled, it starts an OpenTelemetry `NodeSDK` with a `LangfuseSpanProcessor` and registers a `LangfuseAgentsBridge` trace processor that maps each `@openai/agents` trace/span into a Langfuse observation. The Router, Math, and Writing agents each produce their own top-level trace (no single distributed span tree across the A2A HTTP hop); what groups them together in Langfuse is a shared `sessionId` — seeded from the inbound request's A2A `contextId`, carried across A2A calls via the outgoing message's `metadata.sessionId` (see `extractSessionId`/`createUserMessage` in `src/a2a/messages.js`), and applied per run via `withSession(sessionId, fn)` (backed by `propagateAttributes` from `@langfuse/tracing`). `createAgentCluster` and `OpenAIAgentExecutor` both accept `withSession` as a dependency-injection override, defaulting to a passthrough no-op.

`initTracing` also resolves the Langfuse project id once at startup (`resolveLangfuseProjectId`, using a `LangfuseClient` from `@langfuse/client`) so it can hand back a synchronous `getSessionUrl(sessionId)` — building `${baseUrl}/project/{projectId}/sessions/{sessionId}` links without a network call per request. `OpenAIAgentExecutor` logs this at `info` as `'langfuse session'` with `{ sessionId, url }` whenever `getSessionUrl` resolves one, so a session's trace is one click away from the log line that started it. If project-id resolution fails (bad keys, no network), it's logged as a `warn` and `getSessionUrl` returns `undefined` from then on — startup itself never fails because of it.

## Build, Test, and Development Commands

- `npm install` installs the locked dependency set.
- `cp .env.example .env` creates local configuration; add a valid `OPENAI_API_KEY` before live runs.
- `npm start` launches the Math and Writing specialists, then the Router on ports 4001, 4002, and 4000.
- `LOG_LEVEL=debug LOG_FORMAT=pretty npm start` launches locally with verbose, human-readable logs.
- `npm test` runs the complete Vitest suite once without requiring an API key.
- `npm run test:watch` reruns affected tests during development.
- `npm run lint` checks all JavaScript with ESLint.

There is no compile or transpilation step.

## Coding Style & Naming Conventions

Use plain `.js` ESM with `import`/`export`, async/await, two-space indentation, semicolons, and single quotes. Prefer small named exports and dependency injection at network/model boundaries. Use `camelCase` for functions and variables, `PascalCase` for classes, and kebab-case filenames such as `remote-tools.js`. Use the injected Winston-compatible logger instead of `console`; write a stable message plus structured metadata, and pass failures as `{ err: error }` so `src/logger.js` can serialize them. Logger parameters in reusable modules should default to `noopLogger`, while `src/index.js` owns creation of the real logger. Do not introduce CommonJS, Express, TypeScript, or frontend code. Run `npm run lint` before submitting changes.

## Testing Guidelines

Vitest test files use the `*.test.js` pattern under `test/`. Keep tests deterministic: mock OpenAI model runs, but use real loopback HTTP where A2A discovery or JSON-RPC transport behavior matters. Inject logger spies when asserting logging behavior and otherwise rely on `noopLogger` so tests stay quiet. Add tests for success, validation errors, timeouts, lifecycle cleanup, and any new log metadata or level behavior. No numeric coverage threshold is configured; every behavior change should include focused regression coverage.

## Commit & Pull Request Guidelines

The repository has no established Git history. Use concise imperative commit subjects, optionally with Conventional Commit prefixes, such as `feat: add router timeout handling` or `test: cover invalid agent cards`. Pull requests should explain behavior changes, note configuration impacts, link relevant issues, and report `npm test` and `npm run lint` results. Screenshots are unnecessary for this backend-only project; include request/response examples when an endpoint contract changes.

## Security & Configuration

Never commit `.env` or API keys. Keep `.env.example` limited to placeholders and safe defaults. Logging is configured only through validated `LOG_LEVEL`, `LOG_FORMAT`, and `NODE_ENV` values in `src/config.js`; do not read environment variables in logging call sites. Do not log API keys, authorization values, or full user/model payloads. Preserve the unauthenticated, local-demo scope unless a change explicitly adds and documents an authentication model.

Optional Langfuse tracing is configured only through validated `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` (default `https://us.cloud.langfuse.com`), and `LANGFUSE_TRACING` values in `src/config.js`, mirroring the logging config pattern. It is off by default: enabled only when both key vars are set, unless `LANGFUSE_TRACING` explicitly forces it `true`/`false`. The Langfuse public key and base URL are safe to keep in `.env.example`; the secret key must stay blank there and only be set in a local, gitignored `.env`. When enabled, `initTracing` makes one authenticated `GET /api/public/projects` call at startup to resolve the project id used for session URLs; failures are logged as a `warn` and never block startup.
