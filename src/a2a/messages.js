import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const nonEmptyTextSchema = z.string().trim().min(1);
const textPartSchema = z
  .object({
    kind: z.literal('text'),
    text: nonEmptyTextSchema,
  })
  .passthrough();

const incomingTextMessageSchema = z
  .object({
    kind: z.literal('message'),
    role: z.literal('user'),
    parts: z.array(textPartSchema).min(1),
  })
  .passthrough();

const responseMessageSchema = z
  .object({
    kind: z.literal('message'),
    parts: z.array(z.unknown()).min(1),
  })
  .passthrough();

const taskSchema = z
  .object({
    kind: z.literal('task'),
    status: z
      .object({
        state: z.string(),
        message: z.unknown().optional(),
      })
      .passthrough(),
    history: z.array(z.unknown()).optional(),
    artifacts: z
      .array(
        z
          .object({
            parts: z.array(z.unknown()),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export function extractUserText(message) {
  const parsed = incomingTextMessageSchema.parse(message);
  return parsed.parts.map((part) => part.text).join('\n');
}

function extractTextParts(parts) {
  return parts
    .map((part) => textPartSchema.safeParse(part))
    .filter((result) => result.success)
    .map((result) => result.data.text)
    .join('\n')
    .trim();
}

function extractMessageText(value) {
  const parsed = responseMessageSchema.safeParse(value);
  return parsed.success ? extractTextParts(parsed.data.parts) : '';
}

export function extractA2AResultText(result) {
  const directMessage = responseMessageSchema.safeParse(result);
  if (directMessage.success) {
    const text = extractTextParts(directMessage.data.parts);
    if (text) return text;
    throw new Error('The remote agent returned a message without text.');
  }

  const task = taskSchema.safeParse(result);
  if (!task.success) {
    throw new Error('The remote agent returned an invalid A2A result.');
  }

  const statusText = extractMessageText(task.data.status.message);
  if (statusText) return statusText;

  for (const message of [...(task.data.history ?? [])].reverse()) {
    const historyText = extractMessageText(message);
    if (historyText) return historyText;
  }

  for (const artifact of [...(task.data.artifacts ?? [])].reverse()) {
    const artifactText = extractTextParts(artifact.parts);
    if (artifactText) return artifactText;
  }

  throw new Error(
    `The remote agent returned task state "${task.data.status.state}" without text.`,
  );
}

export function createAgentMessage({
  text,
  contextId,
  taskId,
  idFactory = randomUUID,
}) {
  return {
    kind: 'message',
    role: 'agent',
    messageId: idFactory(),
    contextId,
    taskId,
    parts: [{ kind: 'text', text: nonEmptyTextSchema.parse(text) }],
  };
}

export function createUserMessage({ text, idFactory = randomUUID, metadata }) {
  return {
    kind: 'message',
    role: 'user',
    messageId: idFactory(),
    ...(metadata ? { metadata } : {}),
    parts: [{ kind: 'text', text: nonEmptyTextSchema.parse(text) }],
  };
}

export function extractSessionId(message) {
  const sessionId = message?.metadata?.sessionId;
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId : undefined;
}
