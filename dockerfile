# Stage 1: Build
FROM oven/bun:1 AS builder
WORKDIR /app

# Copy dependency files
COPY package.json bun.lock tsconfig.json astro.config.mjs tailwind.config.js ./

# Install all dependencies (including devDependencies needed for Astro build)
RUN bun install --frozen-lockfile

# Copy source code
COPY src ./src
COPY scripts ./scripts

# Build the Astro project
RUN bun run build

# Stage 2: Production runtime
FROM oven/bun:1-slim AS production
WORKDIR /app

# Set production environment variables
ENV HOST=0.0.0.0
ENV PORT=4321
ENV NODE_ENV=production

# Copy only the necessary build artifacts and scripts from the builder stage
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src

# Expose the application port
EXPOSE 4321

# Persist the database directory
VOLUME /app/db

# Readiness probe. The slim image ships Bun but no curl/wget, so use Bun itself.
# Hits /api/health on the configured PORT (0.0.0.0 -> 127.0.0.1, :: -> [::1], other IPv6 literals are bracketed).
# Keep this command identical in docker-compose.yaml and README.md (tests/health.test.ts enforces parity).
# Healthy = HTTP 200: library readable and database available. Scans do not make it unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const h=process.env.HOST;const a=!h||h==='0.0.0.0'?'127.0.0.1':h==='::'?'[::1]':h.includes(':')&&h[0]!=='['?'['+h+']':h;fetch('http://'+a+':'+(process.env.PORT||4321)+'/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]

# Automatically start the Node server using bun
CMD ["bun", "run", "start"]
