import { DefaultAzureCredential } from '@azure/identity';
import { ServiceBusClient, type ServiceBusMessage } from '@azure/service-bus';
import type {
  SkillBinding,
  WorkerConfig,
  WorkerOutput,
  WorkerRequest,
} from '@foundry-skill-worker/contracts';

export function createServiceBusClient(config: WorkerConfig): ServiceBusClient {
  const connectionString = config.serviceBus.connectionStringEnv
    ? process.env[config.serviceBus.connectionStringEnv]
    : undefined;

  if (connectionString) {
    return new ServiceBusClient(connectionString);
  }

  const namespace = process.env[config.serviceBus.fullyQualifiedNamespaceEnv];

  if (!namespace) {
    throw new Error(
      `Set ${config.serviceBus.fullyQualifiedNamespaceEnv} for Azure identity authentication.`,
    );
  }

  return new ServiceBusClient(namespace, new DefaultAzureCredential());
}

export async function sendRequest(
  client: ServiceBusClient,
  skill: SkillBinding,
  request: WorkerRequest,
): Promise<void> {
  const sender = client.createSender(skill.inputQueue);

  try {
    await sender.sendMessages({
      body: request,
      contentType: 'application/json',
      messageId: request.requestId,
      sessionId: request.conversation.id,
      subject: skill.id,
      applicationProperties: {
        requestId: request.requestId,
        skillId: skill.id,
        schemaVersion: 1,
      },
    });
  } finally {
    await sender.close();
  }
}

export async function receiveOutput(
  client: ServiceBusClient,
  skill: SkillBinding,
  conversationId: string,
  requestId: string | undefined,
  timeoutMs: number,
): Promise<WorkerOutput> {
  const deadline = Date.now() + timeoutMs;
  let receiver: Awaited<ReturnType<ServiceBusClient['acceptSession']>> | undefined;

  while (!receiver && Date.now() < deadline) {
    try {
      receiver = await client.acceptSession(skill.outputQueue, conversationId, {
        receiveMode: 'peekLock',
        maxAutoLockRenewalDurationInMs: 10 * 60_000,
      });
    } catch {
      await sleep(500);
    }
  }

  if (!receiver) {
    throw timeoutError(skill, conversationId, requestId);
  }

  try {
    while (Date.now() < deadline) {
      const [message] = await receiver.receiveMessages(1, {
        maxWaitTimeInMs: Math.min(5_000, Math.max(1_000, deadline - Date.now())),
      });

      if (!message) {
        continue;
      }

      const output = parseOutput(message);

      if (!requestId || output.requestId === requestId) {
        await receiver.completeMessage(message);
        return output;
      }
      await receiver.abandonMessage(message);
      throw new Error(
        `Received output '${output.requestId}' before requested '${requestId}'. Consume the earlier response first or use a distinct conversation ID.`,
      );
    }

    throw timeoutError(skill, conversationId, requestId);
  } finally {
    await receiver.close();
  }
}

function parseOutput(message: ServiceBusMessage): WorkerOutput {
  if (typeof message.body !== 'object' || message.body === null || Array.isArray(message.body)) {
    throw new Error('Output queue message is not a JSON worker output object.');
  }

  const output = message.body as WorkerOutput;

  if (!output.requestId || !output.conversation?.id) {
    throw new Error('Output queue message is missing requestId or conversation.id.');
  }

  return output;
}

function timeoutError(skill: SkillBinding, conversationId: string, requestId?: string): Error {
  return new Error(
    `Timed out waiting on '${skill.outputQueue}' for conversation '${conversationId}'${requestId ? ` and request '${requestId}'` : ''}.`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
