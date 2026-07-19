# Three-Agent A2A Backend

A backend-only Node.js example with three independent Hapi servers communicating through the A2A 0.3 JSON-RPC protocol:

```text
Client -> Router Agent (:4000)
             |-- A2A HTTP -> Math Specialist (:4001)
             `-- A2A HTTP -> Writing Specialist (:4002)
```

The router exposes two OpenAI Agents SDK function tools, `ask_math_specialist` and `ask_writing_specialist`. Each tool discovers its specialist through the published Agent Card and sends the work over HTTP. The specialists are not imported into or called directly by the router.

## Requirements

- Node.js 20+
- npm
- An OpenAI API key with access to `gpt-5.4-mini`, or another model supplied through `OPENAI_MODEL`

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and replace the placeholder key:

```dotenv
OPENAI_API_KEY=sk-your-key
OPENAI_MODEL=gpt-5.4-mini
```

Then start the complete cluster:

```bash
npm start
```

The launcher starts the Math Specialist and Writing Specialist before the Router Agent. `Ctrl+C` stops all three in reverse order.

## Servers and endpoints

| Agent | Port | Base URL |
| --- | ---: | --- |
| Router Agent | 4000 | `http://localhost:4000` |
| Math Specialist Agent | 4001 | `http://localhost:4001` |
| Writing Specialist Agent | 4002 | `http://localhost:4002` |

Every server exposes only these public routes:

```text
GET  /.well-known/agent-card.json
POST /a2a/jsonrpc
GET  /health
```

Examples:

```bash
curl http://localhost:4000/health
curl http://localhost:4001/.well-known/agent-card.json
```

## Send A2A messages

Ask the router a math question:

```bash
curl -s http://localhost:4000/a2a/jsonrpc \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": "math-example",
    "method": "message/send",
    "params": {
      "configuration": {
        "blocking": true,
        "acceptedOutputModes": ["text/plain"]
      },
      "message": {
        "kind": "message",
        "role": "user",
        "messageId": "math-message-1",
        "parts": [
          { "kind": "text", "text": "What is 18 percent of 245?" }
        ]
      }
    }
  }'
```

Ask for writing work by changing the text to:

```text
Rewrite this sentence to sound friendly and concise: Your request was rejected.
```

Exercise both specialists with:

```text
Calculate a 15% tip on $86 and present the result as a polished sentence for a receipt.
```

The JSON-RPC result contains an A2A `Message` with one or more text parts.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | required | OpenAI API credential |
| `OPENAI_MODEL` | `gpt-5.4-mini` | Model used by all three agents |
| `A2A_HOST` | `localhost` | Hapi bind host |
| `ROUTER_PORT` | `4000` | Router port |
| `MATH_PORT` | `4001` | Math Specialist port |
| `WRITING_PORT` | `4002` | Writing Specialist port |
| `MATH_AGENT_URL` | `http://localhost:4001` | Math Agent Card discovery base URL |
| `WRITING_AGENT_URL` | `http://localhost:4002` | Writing Agent Card discovery base URL |
| `A2A_REQUEST_TIMEOUT_MS` | `30000` | Remote discovery and message timeout |
| `LOG_LEVEL` | `info` | Winston log level (`error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly`) |
| `LOG_FORMAT` | `json` | `json` for structured single-line logs or `pretty` for colorized human-readable output; when unset, development mode uses `pretty` |
| `NODE_ENV` | unset | Selects `pretty` logging when set to `development` and `LOG_FORMAT` is unset |
| `LANGFUSE_PUBLIC_KEY` | unset | Langfuse project public key |
| `LANGFUSE_SECRET_KEY` | unset | Langfuse project secret key — never commit a real value |
| `LANGFUSE_BASE_URL` | `https://us.cloud.langfuse.com` | Langfuse ingestion endpoint |
| `LANGFUSE_TRACING` | unset | `true`/`false` to force tracing on/off; when unset, tracing is enabled only if both Langfuse keys are set |

If a specialist is hosted elsewhere, set its URL to the base URL that publishes `/.well-known/agent-card.json`. The advertised card selects `/a2a/jsonrpc` as its JSON-RPC interface.

## Logging

Winston writes structured JSON lines to stdout by default. For readable local output with agent execution and delegation details, run:

```bash
LOG_LEVEL=debug LOG_FORMAT=pretty npm start
```

Each entry has a stable message and structured fields. Per-request logs include `component`, `method`, `path`, `status`, and elapsed `ms`; startup and shutdown logs identify the server `role`; executor and remote-specialist calls add agent and request context where available. Errors are serialized under `err` with their name, message, and stack.

At the default `info` level, the process reports listening servers and one completion entry for every HTTP request. Set `LOG_LEVEL=debug` to include server lifecycle, agent execution, and remote delegation events. Remote-call failures use `warn`, while executor and startup/shutdown failures use `error`.

## Observability / Langfuse tracing

Langfuse tracing is optional and off by default. To enable it:

1. Set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` in `.env` (get these from your Langfuse project settings).
2. Set `LANGFUSE_TRACING=true` (or simply remove it — tracing turns on automatically once both keys are present, unless `LANGFUSE_TRACING=false` explicitly overrides that).
3. `npm start`.

Each agent's OpenAI Agents SDK run (Router, Math, Writing) is exported to Langfuse as its own trace — the Router's trace includes its LLM generation and the `ask_math_specialist`/`ask_writing_specialist` tool-call spans; each specialist's trace includes its own LLM generation. These are not merged into one distributed trace tree, since the Router calls specialists over real A2A HTTP rather than in-process. Instead, all three traces from one client request share a Langfuse **session id** (propagated from the Router's inbound `contextId`, through the outgoing A2A message's `metadata.sessionId`, into each specialist's run) so Langfuse's session view groups them together.

When tracing is enabled, each agent logs a direct link to that session as soon as it starts a run:

```text
info: langfuse session {"sessionId":"d8a40f30-...","url":"https://us.cloud.langfuse.com/project/<projectId>/sessions/d8a40f30-..."}
```

This appears at the default `info` log level — no `LOG_LEVEL=debug` needed. The link is built locally from a project id resolved once at startup (one extra Langfuse API call, `GET /api/public/projects`), so logging it costs nothing per request. If that startup lookup fails (bad keys, no network), tracing still runs — the log line is just omitted since there's no project id to link to.

Ctrl+C flushes any pending spans before the process exits. With no Langfuse keys configured, `src/tracing.js` is inert and `npm start`/`npm test` behave exactly as if it didn't exist.

## Validation

The automated suite uses mocked OpenAI runs, so it does not require an API key:

```bash
npm test
npm run lint
```

Tests cover configuration and Zod validation, direct A2A messages, JSON-RPC errors, Agent Cards, health endpoints, actual loopback HTTP discovery and delegation, math/writing/mixed routing, timeouts, startup rollback, and graceful shutdown.

## Implementation notes

- All application and test code is ECMAScript-module JavaScript.
- Hapi is the only application HTTP framework; the application does not declare or import Express.
- Every server owns a separate `DefaultRequestHandler`, `InMemoryTaskStore`, and executor object with `execute()` and `cancelTask()`.
- Responses are direct, blocking A2A `Message` objects. Streaming and push notifications are explicitly disabled in the Agent Cards.
- `cancelTask()` is intentionally a no-op because there are no background tasks in this example.
- This local demonstration is unauthenticated and stores task data in memory.
- `src/logger.js` owns logger formatting and error serialization; reusable modules receive a logger through dependency injection and default to a silent logger.
- `src/tracing.js` owns optional Langfuse tracing; disabled by default and inert unless `LANGFUSE_*` config enables it, per its `initTracing` DI seam (`withSession`) accepted by `createAgentCluster` and `OpenAIAgentExecutor`.
