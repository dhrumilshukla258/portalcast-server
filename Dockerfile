FROM node:18-alpine AS builder

WORKDIR /app

# Install system dependencies
RUN apk add --no-cache python3 make g++ tzdata ffmpeg

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

RUN npm prune --omit=dev

# ─────────────────────────────────────────────────────────────────────────────

FROM node:18-alpine

# ffmpeg (with ffprobe) is required at runtime for HEVC live transcode and VOD transcode
RUN apk add --no-cache tzdata ffmpeg

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/public ./public
COPY package.json ./

# Node's sqlite3 driver runs queries on libuv's threadpool, shared with every
# other async I/O op on the process — the default size (4) is easily saturated
# by a handful of concurrent DB-heavy requests (e.g. Discover's facet/genre
# queries), which then stalls unrelated requests, including active stream
# playback, until the pool clears. Must be set as a real env var (not mutated
# in JS) since libuv reads it once at startup, before any application code runs.
ENV UV_THREADPOOL_SIZE=16

ENTRYPOINT []
CMD ["node", "dist/server.js"]
