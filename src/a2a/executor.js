import { run } from '@openai/agents';
import { z } from 'zod';
import { noopLogger } from '../logger.js';
import { createAgentMessage, extractSessionId, extractUserText } from './messages.js';

const finalOutputSchema = z.string().trim().min(1);
const passthroughSession = (_sessionId, fn) => fn();
const noSessionUrl = () => undefined;

export class OpenAIAgentExecutor {
  constructor({
    agent,
    runAgent = run,
    logger = noopLogger,
    withSession = passthroughSession,
    getSessionUrl = noSessionUrl,
  }) {
    this.agent = agent;
    this.runAgent = runAgent;
    this.logger = logger;
    this.withSession = withSession;
    this.getSessionUrl = getSessionUrl;
  }

  async execute(requestContext, eventBus) {
    let responseText;
    const { contextId, taskId } = requestContext;
    // Carries a tracing session across the A2A hop: propagated from an
    // upstream caller via message metadata, or seeded from this request's
    // own contextId when this is the first hop (e.g. the Router).
    const sessionId = extractSessionId(requestContext.userMessage) ?? contextId;
    const sessionUrl = this.getSessionUrl(sessionId);
    if (sessionUrl) {
      this.logger.info('langfuse session', { sessionId, url: sessionUrl });
    }

    this.logger.debug('executing agent request', { agent: this.agent.name, contextId, taskId });

    try {
      const input = extractUserText(requestContext.userMessage);
      const result = await this.withSession(sessionId, () =>
        this.runAgent(this.agent, input, {
          workflowName: `${this.agent.name} A2A request`,
          groupId: sessionId,
          context: { sessionId },
        }),
      );
      responseText = finalOutputSchema.parse(result.finalOutput);
      this.logger.debug('agent request completed', { agent: this.agent.name, contextId });
    } catch (error) {
      this.logger.error('agent execution failed', { agent: this.agent.name, contextId, err: error });
      responseText =
        error instanceof z.ZodError
          ? 'This agent accepts non-empty text messages and returns text responses only.'
          : 'The agent could not complete the request. Please try again.';
    }

    eventBus.publish(
      createAgentMessage({
        text: responseText,
        contextId: requestContext.contextId,
        taskId: requestContext.taskId,
      }),
    );
    eventBus.finished();
  }

  // Direct, blocking Message responses do not create cancellable background tasks.
  async cancelTask() {}
}
