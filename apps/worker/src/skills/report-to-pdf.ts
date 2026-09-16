import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { ContainerClient } from '@azure/storage-blob';
import type { JsonValue, WorkerOutput, WorkerRequest } from '@foundry-skill-worker/contracts';

interface ReportInput {
  title: string;
  subtitle?: string;
  sections: Array<{
    heading: string;
    body: string | string[];
  }>;
  watermark?: string;
}
export class InvalidReportError extends Error {}

const installedSkillPath = fileURLToPath(new URL('../../skills/pdf/SKILL.md', import.meta.url));

/** Fails fast if the skills.sh PDF package was not included in the worker image. */
export async function verifyInstalledPdfSkill(): Promise<void> {
  await access(installedSkillPath);
  const instructions = await readFile(installedSkillPath, 'utf8');

  if (!instructions.includes('name: pdf') || !instructions.includes('reportlab')) {
    throw new Error(
      `Installed PDF skill at '${installedSkillPath}' is not the expected skills.sh package.`,
    );
  }
}

export async function createReportPdf(
  request: WorkerRequest,
  container: ContainerClient,
): Promise<
  Omit<WorkerOutput, 'schemaVersion' | 'requestId' | 'skill' | 'conversation' | 'createdAt'>
> {
  await verifyInstalledPdfSkill();
  const report = parseReportInput(request.input);
  const directory = join(tmpdir(), 'foundry-skill-worker', randomUUID());
  await mkdir(directory, { recursive: true });
  const inputPath = join(directory, 'report.json');
  const outputPath = join(directory, 'report.pdf');

  try {
    await writeFile(inputPath, JSON.stringify(report), 'utf8');
    const renderer = fileURLToPath(new URL('../../../scripts/render_report.py', import.meta.url));
    const metadata = await invokeRenderer(renderer, inputPath, outputPath);
    const pdf = await readFile(outputPath);
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    const blobName = `report-to-pdf/${request.requestId}.pdf`;
    const blob = container.getBlockBlobClient(blobName);
    await blob.uploadData(pdf, {
      blobHTTPHeaders: {
        blobContentType: 'application/pdf',
        blobContentDisposition: `inline; filename=report-${request.requestId}.pdf`,
      },
      metadata: {
        requestid: request.requestId,
        conversationid: request.conversation.id,
        sha256,
      },
    });
    return {
      content: {
        artifact: {
          type: 'application/pdf',
          uri: blob.url,
          blobName,
          pages: metadata.pages,
          bytes: pdf.byteLength,
          sha256,
        },
        skill: {
          id: 'pdf',
          operation: 'report-to-pdf',
          instructionsPath: 'apps/worker/skills/pdf/SKILL.md',
          renderer: 'reportlab',
        },
      },
      provider: {
        kind: 'local',
        name: 'report-to-pdf',
      },
    };
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
}

function parseReportInput(value: JsonValue): ReportInput {
  if (!isRecord(value) || typeof value.title !== 'string' || value.title.trim() === '') {
    throw new InvalidReportError('input.title must be a non-empty string.');
  }

  if (!Array.isArray(value.sections) || value.sections.length === 0) {
    throw new InvalidReportError('input.sections must contain at least one section.');
  }

  if (value.subtitle !== undefined && typeof value.subtitle !== 'string') {
    throw new InvalidReportError('input.subtitle must be a string.');
  }

  if (value.watermark !== undefined && typeof value.watermark !== 'string') {
    throw new InvalidReportError('input.watermark must be a string.');
  }

  const sections = value.sections.map((section, index) => {
    if (
      !isRecord(section) ||
      typeof section.heading !== 'string' ||
      section.heading.trim() === ''
    ) {
      throw new InvalidReportError(`input.sections[${index}].heading must be a non-empty string.`);
    }

    if (
      typeof section.body !== 'string' &&
      !(Array.isArray(section.body) && section.body.every((item) => typeof item === 'string'))
    ) {
      throw new InvalidReportError(
        `input.sections[${index}].body must be a string or string array.`,
      );
    }

    return {
      heading: section.heading,
      body: section.body as string | string[],
    };
  });

  return {
    title: value.title,
    subtitle: value.subtitle as string | undefined,
    watermark: value.watermark as string | undefined,
    sections,
  };
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function invokeRenderer(
  renderer: string,
  inputPath: string,
  outputPath: string,
): Promise<{ pages: number }> {
  const python = process.env.PYTHON_EXECUTABLE ?? 'python';

  return new Promise((resolve, reject) => {
    const child = spawn(python, [renderer, '--input', inputPath, '--output', outputPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (error) =>
      reject(new Error(`Could not start PDF renderer '${python}': ${error.message}`)),
    );
    child.once('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`PDF rendering failed: ${stderr || `exit code ${code}`}`));
      }

      try {
        const data = JSON.parse(stdout) as { pages?: unknown };

        if (typeof data.pages !== 'number') {
          throw new Error('Renderer returned invalid metadata.');
        }

        resolve({ pages: data.pages });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
