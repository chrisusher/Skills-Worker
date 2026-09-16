import { DefaultAzureCredential } from '@azure/identity';
import { ServiceBusClient } from '@azure/service-bus';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import type { WorkerConfig } from '@foundry-skill-worker/contracts';

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
      `Set ${config.serviceBus.fullyQualifiedNamespaceEnv} for Service Bus managed identity authentication.`,
    );
  }

  return new ServiceBusClient(namespace, new DefaultAzureCredential());
}

export async function getArtifactContainer(config: WorkerConfig): Promise<ContainerClient> {
  if (!config.artifactStorage) {
    throw new Error('artifactStorage is required for report-to-pdf.');
  }

  const settings = config.artifactStorage;
  const connectionString = settings.connectionStringEnv
    ? process.env[settings.connectionStringEnv]
    : undefined;
  const service = connectionString
    ? BlobServiceClient.fromConnectionString(connectionString)
    : new BlobServiceClient(
        requiredEnvironment(settings.accountUrlEnv),
        new DefaultAzureCredential(),
      );
  const container = service.getContainerClient(settings.container);
  await container.createIfNotExists();

  return container;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Set ${name} for Blob Storage managed identity authentication.`);
  }

  return value;
}
