import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface Conversation {
  id: string;
  continuation?: JsonValue;
}
export interface WorkerRequest {
  schemaVersion: 1;
  requestId: string;
  conversation: Conversation;
  input: JsonValue;
  parameters?: Record<string, JsonValue>;
}
export interface WorkerOutput {
  schemaVersion: 1;
  requestId: string;
  skill: {
    id: string;
    version: string;
  };
  conversation: Conversation;
  content: JsonValue;
  provider: {
    kind: 'local' | 'model' | 'agent';
    name?: string;
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
  };
  createdAt: string;
}
export interface SkillBinding {
  id: string;
  handler?: 'report-to-pdf';
  inputQueue: string;
  outputQueue: string;
}
export interface WorkerConfig {
  serviceBus: {
    fullyQualifiedNamespaceEnv: string;
    connectionStringEnv?: string;
  };
  artifactStorage?: {
    container: string;
    accountUrlEnv: string;
    connectionStringEnv?: string;
  };
  skills: SkillBinding[];
}
export interface LoadedConfig {
  config: WorkerConfig;
  directory: string;
}

export async function loadConfig(file: string): Promise<LoadedConfig> {
  const absoluteFile = resolve(file);
  const parsed: unknown = JSON.parse(await readFile(absoluteFile, 'utf8'));

  if (!isWorkerConfig(parsed)) {
    throw new Error('Invalid skill config. Expected serviceBus settings and skills[].');
  }

  const ids = new Set<string>();

  for (const binding of parsed.skills) {
    if (ids.has(binding.id)) {
      throw new Error(`Duplicate skill id: ${binding.id}`);
    }

    ids.add(binding.id);
  }

  return {
    config: parsed,
    directory: dirname(absoluteFile),
  };
}

function isWorkerConfig(value: unknown): value is WorkerConfig {
  if (!isRecord(value) || !isRecord(value.serviceBus) || !Array.isArray(value.skills)) {
    return false;
  }

  if (typeof value.serviceBus.fullyQualifiedNamespaceEnv !== 'string') {
    return false;
  }

  if (
    value.serviceBus.connectionStringEnv !== undefined &&
    typeof value.serviceBus.connectionStringEnv !== 'string'
  ) {
    return false;
  }

  if (
    value.artifactStorage !== undefined &&
    (!isRecord(value.artifactStorage) ||
      typeof value.artifactStorage.container !== 'string' ||
      typeof value.artifactStorage.accountUrlEnv !== 'string' ||
      (value.artifactStorage.connectionStringEnv !== undefined &&
        typeof value.artifactStorage.connectionStringEnv !== 'string'))
  ) {
    return false;
  }

  return value.skills.every(
    (skill) =>
      isRecord(skill) &&
      typeof skill.id === 'string' &&
      typeof skill.inputQueue === 'string' &&
      typeof skill.outputQueue === 'string' &&
      (skill.handler === undefined || skill.handler === 'report-to-pdf'),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
