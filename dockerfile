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

# Automatically start the Node server using bun
CMD ["bun", "run", "start"]
