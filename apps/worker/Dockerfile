FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile
COPY apps/worker apps/worker
COPY packages/contracts packages/contracts
RUN pnpm --filter @foundry-skill-worker/worker build

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    poppler-utils \
    python-is-python3 \
    python3 \
    python3-pip \
  && pip3 install --break-system-packages \
    pdf2image \
    pdfplumber \
    Pillow \
    pypdf \
    reportlab \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/scripts ./apps/worker/scripts
COPY --from=build /app/apps/worker/skills ./apps/worker/skills
COPY --from=build /app/packages/contracts ./packages/contracts
COPY config ./config
CMD ["node", "apps/worker/dist/index.js"]
