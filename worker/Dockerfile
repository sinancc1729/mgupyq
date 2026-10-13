# Background import worker. Build from the REPOSITORY ROOT:
#   docker build -f worker/Dockerfile -t mgu-pyq-worker .
#   docker run --env-file worker/.env mgu-pyq-worker
FROM node:20-bookworm-slim

# Optional OCR support (only used when OCR_ENABLED=true). Remove to slim the image.
ARG WITH_OCR=false
RUN if [ "$WITH_OCR" = "true" ]; then apt-get update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr && rm -rf /var/lib/apt/lists/*; fi

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.node.json ./
COPY shared ./shared
COPY config ./config
COPY worker ./worker
COPY scripts ./scripts

USER node
CMD ["npx", "tsx", "worker/src/index.ts"]
