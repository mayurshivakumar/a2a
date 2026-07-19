import { describe, expect, it } from 'vitest';
import {
  createAgentMessage,
  createUserMessage,
  extractA2AResultText,
  extractSessionId,
  extractUserText,
} from '../src/a2a/messages.js';

describe('A2A text message helpers', () => {
  it('validates and joins incoming text parts', () => {
    expect(
      extractUserText({
        kind: 'message',
        role: 'user',
        messageId: 'message-1',
        parts: [
          { kind: 'text', text: 'first' },
          { kind: 'text', text: 'second' },
        ],
      }),
    ).toBe('first\nsecond');
  });

  it('rejects non-text and empty input', () => {
    expect(() =>
      extractUserText({
        kind: 'message',
        role: 'user',
        parts: [{ kind: 'file', file: { uri: 'https://example.test/file' } }],
      }),
    ).toThrow();
    expect(() => createUserMessage({ text: '   ' })).toThrow();
  });

  it('includes metadata on outgoing user messages only when provided', () => {
    expect(
      createUserMessage({
        text: 'hello',
        idFactory: () => 'user-message-1',
        metadata: { sessionId: 'session-1' },
      }),
    ).toEqual({
      kind: 'message',
      role: 'user',
      messageId: 'user-message-1',
      metadata: { sessionId: 'session-1' },
      parts: [{ kind: 'text', text: 'hello' }],
    });

    expect(createUserMessage({ text: 'hello', idFactory: () => 'user-message-2' })).not.toHaveProperty(
      'metadata',
    );
  });

  it('extracts a session id from message metadata', () => {
    expect(extractSessionId({ metadata: { sessionId: 'session-1' } })).toBe('session-1');
    expect(extractSessionId({ metadata: { sessionId: '  ' } })).toBeUndefined();
    expect(extractSessionId({ metadata: { sessionId: 42 } })).toBeUndefined();
    expect(extractSessionId({ metadata: {} })).toBeUndefined();
    expect(extractSessionId({})).toBeUndefined();
    expect(extractSessionId(undefined)).toBeUndefined();
  });

  it('creates a correlated agent Message', () => {
    expect(
      createAgentMessage({
        text: 'answer',
        contextId: 'context-1',
        taskId: 'task-1',
        idFactory: () => 'agent-message-1',
      }),
    ).toEqual({
      kind: 'message',
      role: 'agent',
      messageId: 'agent-message-1',
      contextId: 'context-1',
      taskId: 'task-1',
      parts: [{ kind: 'text', text: 'answer' }],
    });
  });

  it('extracts direct Message text', () => {
    expect(
      extractA2AResultText({
        kind: 'message',
        role: 'agent',
        messageId: 'message-2',
        parts: [{ kind: 'text', text: 'remote answer' }],
      }),
    ).toBe('remote answer');
  });

  it('extracts text from a terminal Task status, history, or artifact', () => {
    expect(
      extractA2AResultText({
        kind: 'task',
        id: 'task-2',
        contextId: 'context-2',
        status: {
          state: 'completed',
          message: {
            kind: 'message',
            role: 'agent',
            parts: [{ kind: 'text', text: 'status answer' }],
          },
        },
      }),
    ).toBe('status answer');

    expect(
      extractA2AResultText({
        kind: 'task',
        status: { state: 'completed' },
        history: [
          {
            kind: 'message',
            role: 'agent',
            parts: [{ kind: 'text', text: 'history answer' }],
          },
        ],
      }),
    ).toBe('history answer');

    expect(
      extractA2AResultText({
        kind: 'task',
        status: { state: 'completed' },
        artifacts: [{ parts: [{ kind: 'text', text: 'artifact answer' }] }],
      }),
    ).toBe('artifact answer');
  });
});
