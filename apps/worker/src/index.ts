import type { ContainerClient } from '@azure/storage-blob';
import type { ServiceBusClient } from '@azure/service-bus';
import {
  loadConfig,
  type SkillBinding,
  type WorkerOutput,
  type WorkerRequest,
} from '@foundry-skill-worker/contracts';
import { createServiceBusClient, getArtifactContainer } from './azure.js';
import {
  InvalidReportError,
  createReportPdf,
  verifyInstalledPdfSkill,
} from './skills/report-to-pdf.js';

const configPath = process.env.WORKER_CONFIG ?? 'config/skills.local.json';
let stopping = false;

async function main(): Promise<void> {
  const { config } = await loadConfig(configPath);
  await verifyInstalledPdfSkill();
  const client = createServiceBusClient(config);
  const container = await getArtifactContainer(config);
  const skills = config.skills.filter((skill) => skill.handler === 'report-to-pdf');

  if (skills.length === 0) {
    throw new Error('No report-to-pdf skill binding is configured.');
  }

  process.on('SIGINT', () => {
    stopping = true;
  });
  process.on('SIGTERM', () => {
    stopping = true;
  });

  try {
    await Promise.all(skills.map((skill) => runReportWorker(client, skill, container)));
  } finally {
    await client.close();
  }
}

async function runReportWorker(
  client: ServiceBusClient,
  skill: SkillBinding,
  container: ContainerClient,
): Promise<void> {
  const sender = client.createSender(skill.outputQueue);

  try {
    while (!stopping) {
      const receiver = await client.acceptNextSession(skill.inputQueue, {
        receiveMode: 'peekLock',
        maxAutoLockRenewalDurationInMs: 10 * 60_000,
        identifier: `report-to-pdf-${process.pid}`,
      });

      try {
        for (const message of await receiver.receiveMessages(1, { maxWaitTimeInMs: 5_000 })) {
          try {
            const request = assertRequest(message.body);
            const result = await createReportPdf(request, container);
            const output = makeOutput(request, result);
            await sender.sendMessages({
              body: output,
              contentType: 'application/json',
              messageId: output.requestId,
              sessionId: output.conversation.id,
              subject: skill.id,
              applicationProperties: {
                requestId: output.requestId,
                skillId: skill.id,
                schemaVersion: 1,
              },
            });
            await receiver.completeMessage(message);
          } catch (error) {
            if (error instanceof InvalidReportError) {
              await receiver.deadLetterMessage(message, {
                deadLetterReason: 'InvalidReportRequest',
                deadLetterErrorDescription: error.message,
              });
            } else {
              await receiver.abandonMessage(message);
              console.error('report-to-pdf processing failed', error);
            }
          }
        }
      } finally {
        await receiver.close();
      }
    }
  } finally {
    await sender.close();
  }
}

function assertRequest(value: unknown): WorkerRequest {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidReportError('Request body must be a JSON object.');
  }

  const request = value as Partial<WorkerRequest>;

  if (
    request.schemaVersion !== 1 ||
    !request.requestId ||
    !request.conversation?.id ||
    request.input === undefined
  ) {
    throw new InvalidReportError(
      'Request must include schemaVersion, requestId, conversation.id, and input.',
    );
  }

  return request as WorkerRequest;
}

function makeOutput(
  request: WorkerRequest,
  result: Omit<
    WorkerOutput,
    'schemaVersion' | 'requestId' | 'skill' | 'conversation' | 'createdAt'
  >,
): WorkerOutput {
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    skill: {
      id: 'report-to-pdf',
      version: '1.0.0',
    },
    conversation: request.conversation,
    createdAt: new Date().toISOString(),
    ...result,
  };
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
