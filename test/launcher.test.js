import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installShutdownHandlers, startAgentCluster } from '../src/launcher.js';

function fakeCluster(events, failingServer) {
  const server = (name) => ({
    async start() {
      events.push(`start:${name}`);
      if (name === failingServer) throw new Error(`${name} failed`);
    },
    async stop() {
      events.push(`stop:${name}`);
    },
  });

  return {
    math: server('math'),
    writing: server('writing'),
    router: server('router'),
  };
}

describe('agent cluster lifecycle', () => {
  it('starts specialists before the router and stops in reverse order', async () => {
    const events = [];
    const stop = await startAgentCluster(fakeCluster(events));

    expect(events).toEqual(['start:math', 'start:writing', 'start:router']);
    await stop();
    expect(events).toEqual([
      'start:math',
      'start:writing',
      'start:router',
      'stop:router',
      'stop:writing',
      'stop:math',
    ]);
  });

  it('rolls back servers when startup fails', async () => {
    const events = [];

    await expect(startAgentCluster(fakeCluster(events, 'writing'))).rejects.toThrow(
      'writing failed',
    );
    expect(events).toEqual(['start:math', 'start:writing', 'stop:math']);
  });

  it('installs idempotent graceful-shutdown handlers', async () => {
    const processObject = new EventEmitter();
    processObject.exitCode = 0;
    const stop = vi.fn().mockResolvedValue(undefined);
    const logger = { info: vi.fn(), error: vi.fn() };
    const shutdown = installShutdownHandlers({ stop, logger, processObject });

    await shutdown('SIGINT');
    await shutdown('SIGTERM');

    expect(stop).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith('Received SIGINT; stopping A2A servers.');
  });
});
