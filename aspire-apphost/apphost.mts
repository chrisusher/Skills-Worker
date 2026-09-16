// Aspire TypeScript AppHost
// For more information, see: https://aspire.dev

import { createBuilder } from "./.aspire/modules/aspire.mjs";

const builder = await createBuilder();

// Azure Storage
const storage = await builder.addAzureStorage("storage").runAsEmulator();

await storage.addBlobs("blobs");

await storage.addBlobContainer("data", {
  blobContainerName: "data",
});

// Service Bus
const serviceBus = await builder.addAzureServiceBus("service-bus");

await serviceBus.addServiceBusQueue("pdf-input", {
  queueName: "pdf-input",
});
await serviceBus.addServiceBusQueue("pdf-output", {
  queueName: "pdf-output",
});

await builder.addJavaScriptApp("worker", "apps/worker", {
  runScriptName: "dist/index.js",
});

await builder.build().run();
