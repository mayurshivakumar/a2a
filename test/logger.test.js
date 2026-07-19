import Transport from 'winston-transport';
import { describe, expect, it } from 'vitest';
import { createLogger, noopLogger } from '../src/logger.js';

class MemoryTransport extends Transport {
  constructor(opts) {
    super(opts);
    this.entries = [];
  }

  log(info, callback) {
    this.entries.push(info);
    callback();
  }
}

function createCapturingLogger(options = {}) {
  const memory = new MemoryTransport();
  const logger = createLogger({ ...options, transports: [memory] });
  return { logger, entries: memory.entries };
}

describe('createLogger', () => {
  it('exposes info/debug/warn/error and emits structured JSON by default', () => {
    const { logger, entries } = createCapturingLogger({ level: 'debug' });

    logger.info('agent listening', { role: 'math', port: 4001 });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'info',
      message: 'agent listening',
      role: 'math',
      port: 4001,
    });
    expect(entries[0].timestamp).toEqual(expect.any(String));
  });

  it('respects the configured level', () => {
    const { logger, entries } = createCapturingLogger({ level: 'info' });

    logger.debug('should not appear');
    logger.info('should appear');

    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe('should appear');
  });

  it('normalizes Error-valued fields into name/message/stack in the serialized output', () => {
    const { logger, entries } = createCapturingLogger({ level: 'debug' });
    const err = new Error('boom');

    logger.error('agent execution failed', { agent: 'Test Agent', err });

    // Assert against the actual serialized JSON line (what really reaches the
    // transport/stdout), not just structural matching on the in-memory `info`
    // object — `message`/`stack` are non-enumerable on a plain Error, so a
    // naive JSON.stringify would silently drop them if normalization failed.
    const logged = JSON.parse(entries[0][Symbol.for('message')]);
    expect(logged.err).toEqual({
      name: 'Error',
      message: 'boom',
      stack: expect.any(String),
    });
  });

  it('normalizes error-like objects with extra own enumerable fields', () => {
    // Mirrors real SDK error shapes (e.g. an OpenAI APIError) that carry
    // extra own enumerable properties (status, code, ...) alongside the
    // inherited, non-enumerable name/message/stack from Error.prototype.
    const { logger, entries } = createCapturingLogger({ level: 'debug' });
    class FakeApiError extends Error {
      constructor() {
        super('Incorrect API key provided');
        this.name = 'AuthenticationError';
        this.status = 401;
        this.code = 'invalid_api_key';
      }
    }

    logger.error('agent execution failed', { agent: 'Test Agent', err: new FakeApiError() });

    const logged = JSON.parse(entries[0][Symbol.for('message')]);
    expect(logged.err).toEqual({
      name: 'AuthenticationError',
      message: 'Incorrect API key provided',
      stack: expect.any(String),
    });
    expect(logged.err.status).toBeUndefined();
    expect(logged.err.code).toBeUndefined();
  });

  it('produces pretty, colorized single-line output when pretty is true', () => {
    const { logger, entries } = createCapturingLogger({ level: 'info', pretty: true });

    logger.info('agent listening', { role: 'router' });

    expect(entries).toHaveLength(1);
    const output = entries[0][Symbol.for('message')];
    expect(output).toContain('agent listening');
    expect(output).toContain('"role":"router"');
    expect(output.startsWith('\u001b[32m')).toBe(true);
    expect(output.endsWith('\u001b[39m')).toBe(true);
  });

  it('silent loggers never throw and emit nothing', () => {
    expect(() => noopLogger.info('anything', { some: 'meta' })).not.toThrow();
    expect(() => noopLogger.error('failure', { err: new Error('quiet') })).not.toThrow();
  });

  it('supports child() for per-component metadata', () => {
    const { logger, entries } = createCapturingLogger({ level: 'debug' });
    const child = logger.child({ component: 'math' });

    child.debug('executing agent request', { contextId: 'context-1' });

    expect(entries[0]).toMatchObject({
      component: 'math',
      contextId: 'context-1',
      message: 'executing agent request',
    });
  });
});
