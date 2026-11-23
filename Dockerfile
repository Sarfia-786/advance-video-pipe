FROM node:22-alpine AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package*.json ./
COPY . .
# Check that the workspace packages are present in the build context.
RUN for d in packages/Vibe-Workflow/packages/workflow-builder packages/Open-Poe-AI/packages/agents packages/Open-AI-Design-Agent/packages/design-agent; do \
      [ -f "$d/package.json" ] || { echo "ERROR: $d is missing. Run the Docker build from the repository root with all workspace packages in the build context." >&2; exit 1; }; \
    done
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund

# Build sub-packages
FROM deps AS builder
RUN npm run build:packages
RUN npm run build

# Production runner
FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/db/migrations ./db/migrations
COPY --from=builder /app/lib/platform/accounts ./lib/platform/accounts
COPY --from=builder /app/scripts/migrate-platform-auth.mjs ./scripts/migrate-platform-auth.mjs

EXPOSE 3000
CMD ["npm", "start"]
