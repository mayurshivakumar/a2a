import { OpenAIAgentExecutor } from './a2a/executor.js';
import { createA2AServer } from './a2a/server.js';
import { createMathCard, createRouterCard, createWritingCard } from './agents/cards.js';
import { createRouterAgent } from './agents/router.js';
import { createMathAgent, createWritingAgent } from './agents/specialists.js';
import { noopLogger } from './logger.js';

export function createAgentCluster(
  config,
  { runAgent, logger = noopLogger, clientFactoryFactory, withSession, getSessionUrl } = {},
) {
  const mathLogger = logger.child({ component: 'math' });
  const writingLogger = logger.child({ component: 'writing' });
  const routerLogger = logger.child({ component: 'router' });

  const mathAgent = createMathAgent(config.model);
  const writingAgent = createWritingAgent(config.model);
  const router = createRouterAgent({
    model: config.model,
    mathAgentUrl: config.urls.math,
    writingAgentUrl: config.urls.writing,
    timeoutMs: config.requestTimeoutMs,
    clientFactoryFactory,
    logger: routerLogger,
  });

  const math = createA2AServer({
    host: config.host,
    port: config.ports.math,
    agentCard: createMathCard(config.urls.math),
    executor: new OpenAIAgentExecutor({
      agent: mathAgent,
      runAgent,
      logger: mathLogger,
      withSession,
      getSessionUrl,
    }),
    logger: mathLogger,
  });
  const writing = createA2AServer({
    host: config.host,
    port: config.ports.writing,
    agentCard: createWritingCard(config.urls.writing),
    executor: new OpenAIAgentExecutor({
      agent: writingAgent,
      runAgent,
      logger: writingLogger,
      withSession,
      getSessionUrl,
    }),
    logger: writingLogger,
  });
  const routerServer = createA2AServer({
    host: config.host,
    port: config.ports.router,
    agentCard: createRouterCard(config.urls.router),
    executor: new OpenAIAgentExecutor({
      agent: router.agent,
      runAgent,
      logger: routerLogger,
      withSession,
      getSessionUrl,
    }),
    logger: routerLogger,
  });

  return {
    math,
    writing,
    router: routerServer,
    agents: {
      math: mathAgent,
      writing: writingAgent,
      router: router.agent,
    },
    routerTools: router.tools,
  };
}
