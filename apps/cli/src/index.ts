#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import {
  loadConfig,
  type JsonValue,
  type WorkerConfig,
  type WorkerRequest,
} from '@foundry-skill-worker/contracts';
import { createServiceBusClient, receiveOutput, sendRequest } from './service-bus.js';

const program = new Command()
  .name('foundry-worker')
  .description('Send requests to a Service Bus worker and receive correlated outputs.')
  .option('-c, --config <path>', 'worker queue configuration', 'config/skills.local.json')
  .showHelpAfterError();
program
  .command('skills')
  .description('List configured queue bindings.')
  .action(async () => {
    print((await config()).skills);
  });
program
  .command('invoke')
  .description('Send a request and wait for its correlated output.')
  .requiredOption('-s, --skill <id>')
  .requiredOption('-i, --input <text-or-json>')
  .option('--conversation <id>')
  .option('--request-id <id>')
  .option('--params <json>')
  .option('--continuation <json>')
  .option('-w, --wait <seconds>', 'maximum wait', '60')
  .action(async (options) =>
    withClient(async (cfg, client) => {
      const request = makeRequest(parseJsonOrString(options.input), options);
      const skill = getSkill(cfg, options.skill);
      await sendRequest(client, skill, request);
      print(
        await receiveOutput(
          client,
          skill,
          request.conversation.id,
          request.requestId,
          secondsToMs(options.wait),
        ),
      );
    }),
  );
program
  .command('send')
  .description('Send a request without waiting.')
  .requiredOption('-s, --skill <id>')
  .requiredOption('-i, --input <text-or-json>')
  .option('--conversation <id>')
  .option('--request-id <id>')
  .option('--params <json>')
  .option('--continuation <json>')
  .action(async (options) =>
    withClient(async (cfg, client) => {
      const request = makeRequest(parseJsonOrString(options.input), options);
      const skill = getSkill(cfg, options.skill);
      await sendRequest(client, skill, request);
      print({
        sent: true,
        skill: skill.id,
        inputQueue: skill.inputQueue,
        requestId: request.requestId,
        conversationId: request.conversation.id,
      });
    }),
  );
program
  .command('listen')
  .description('Wait for an output in a conversation session.')
  .requiredOption('-s, --skill <id>')
  .requiredOption('--conversation <id>')
  .option('--request-id <id>')
  .option('-w, --wait <seconds>', 'maximum wait', '60')
  .action(async (options) =>
    withClient(async (cfg, client) =>
      print(
        await receiveOutput(
          client,
          getSkill(cfg, options.skill),
          options.conversation,
          options.requestId,
          secondsToMs(options.wait),
        ),
      ),
    ),
  );
program
  .command('request')
  .description('Send a complete JSON request file and wait for output.')
  .requiredOption('-s, --skill <id>')
  .requiredOption('-f, --file <path>')
  .option('-w, --wait <seconds>', 'maximum wait', '60')
  .action(async (options) =>
    withClient(async (cfg, client) => {
      const request = JSON.parse(await readFile(options.file, 'utf8')) as WorkerRequest;
      const skill = getSkill(cfg, options.skill);
      await sendRequest(client, skill, request);
      print(
        await receiveOutput(
          client,
          skill,
          request.conversation.id,
          request.requestId,
          secondsToMs(options.wait),
        ),
      );
    }),
  );
program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function config(): Promise<WorkerConfig> {
  return (await loadConfig(program.opts<{ config: string }>().config)).config;
}

async function withClient(
  action: (
    config: WorkerConfig,
    client: ReturnType<typeof createServiceBusClient>,
  ) => Promise<void>,
) {
  const cfg = await config();
  const client = createServiceBusClient(cfg);

  try {
    await action(cfg, client);
  } finally {
    await client.close();
  }
}

function getSkill(config: WorkerConfig, id: string) {
  const skill = config.skills.find((candidate) => candidate.id === id);

  if (!skill) {
    throw new Error(
      `Unknown skill '${id}'. Run 'foundry-worker skills' to list configured skills.`,
    );
  }

  return skill;
}
function makeRequest(
  input: JsonValue,
  options: {
    requestId?: string;
    conversation?: string;
    params?: string;
    continuation?: string;
  },
): WorkerRequest {
  return {
    schemaVersion: 1,
    requestId: options.requestId ?? randomUUID(),
    conversation: {
      id: options.conversation ?? randomUUID(),
      ...(options.continuation
        ? { continuation: JSON.parse(options.continuation) as JsonValue }
        : {}),
    },
    input,
    ...(options.params ? { parameters: jsonObject(options.params) } : {}),
  };
}

function parseJsonOrString(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

function jsonObject(value: string): Record<string, JsonValue> {
  const parsed: unknown = JSON.parse(value);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('--params must contain a JSON object.');
  }

  return parsed as Record<string, JsonValue>;
}

function secondsToMs(value: string): number {
  const seconds = Number(value);

  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
    throw new Error('--wait must be between 1 and 600 seconds.');
  }

  return seconds * 1_000;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
