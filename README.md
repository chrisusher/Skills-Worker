# Foundry skill worker

This is a pnpm workspace with two separate applications and one shared contracts package.

- `apps/worker` is the deployable, session-aware Service Bus worker. It subscribes to configured input queues and executes baked-in skills.
- `apps/cli` is a Commander-based client. It only places requests on a skill input queue and listens for correlated output messages.
- `packages/contracts` defines the shared queue-message and configuration types.

The first baked-in capability is the actual [`pdf` skill from skills.sh](https://www.skills.sh/anthropics/skills/pdf), installed at [apps/worker/skills/pdf/SKILL.md](apps/worker/skills/pdf/SKILL.md). The `report-to-pdf` queue handler uses its ReportLab workflow, verifies the installed `SKILL.md` at startup and before each render, uploads the result to Blob Storage, and returns an artifact receipt containing the blob URI, page count, byte size, and SHA-256 hash.

The installed source is the same published command target:

```powershell
npx skills add https://github.com/anthropics/skills --skill pdf
```

## Install and verify

```powershell
pnpm install
pnpm check
pnpm build
pnpm cli -- --help
pnpm cli -- skills
```

Both applications read [config/skills.local.json](config/skills.local.json), which maps each skill to its session-enabled input and output queues.

## Run the worker locally

Authenticate with Azure CLI or set development connection strings:

```powershell
az login
$env:SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE = "your-namespace.servicebus.windows.net"
$env:ARTIFACT_STORAGE_ACCOUNT_URL = "https://yourstorageaccount.blob.core.windows.net"
$env:PYTHON_EXECUTABLE = "python"
pnpm worker
```

The worker identity needs **Azure Service Bus Data Receiver** on each input queue, **Azure Service Bus Data Sender** on each output queue, and **Storage Blob Data Contributor** on the artifact account. `SERVICE_BUS_CONNECTION_STRING` and `ARTIFACT_STORAGE_CONNECTION_STRING` are supported for local development and take precedence when present.

Build the worker container from the repository root:

```powershell
docker build -f apps/worker/Dockerfile -t foundry-skill-worker .
```

## Use the CLI

The CLI identity needs **Azure Service Bus Data Sender** on inputs and **Azure Service Bus Data Receiver** on outputs.

Send a report and wait for its response:

```powershell
pnpm cli -- invoke --skill report-to-pdf --conversation demo-report --input '{"title":"Incident report","subtitle":"INC-42","watermark":"INTERNAL","sections":[{"heading":"Summary","body":"Authentication errors affected a subset of users."},{"heading":"Actions","body":["Rolled back the change","Added monitoring"]}]}' --wait 120
```

Send now and receive later:

```powershell
pnpm cli -- send --skill report-to-pdf --conversation report-42 --input '{"title":"Status report","sections":[{"heading":"Summary","body":"All services are healthy."}]}'
pnpm cli -- listen --skill report-to-pdf --conversation report-42 --wait 120
```

Submit a complete request document:

```powershell
pnpm cli -- request --skill report-to-pdf --file .\examples\echo-request.json --wait 120
```

The CLI sends `conversation.id` as the Service Bus `SessionId`; the worker preserves it on the output message. Do not run simultaneous requests for the same conversation ID unless callers coordinate output consumption.

## Add another baked-in skill

Add a queue binding and handler in the shared configuration:

```json
{
  "id": "report-to-pdf",
  "handler": "report-to-pdf",
  "inputQueue": "report-to-pdf-in",
  "outputQueue": "report-to-pdf-out"
}
```

Then add the handler to `apps/worker`; the CLI needs no code changes as it is queue-contract driven.
