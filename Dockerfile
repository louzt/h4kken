# Build stage
FROM oven/bun:1.3.0 AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY src/ ./src/
COPY server.ts ./
COPY public/ ./public/

RUN bun run build

# Production stage
FROM oven/bun:1.3.0-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY --from=build /app/dist ./dist

EXPOSE 3000

CMD ["bun", "dist/server.js"]
