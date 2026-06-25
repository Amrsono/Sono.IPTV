# ── Sono.IPTV Backend Dockerfile ──────────────────────────────────────────────
# Installs FFmpeg + Node.js. Deploy on Railway, Render, or Fly.io.

FROM node:20-slim

# Install FFmpeg
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Create runtime streams directory
RUN mkdir -p public/streams

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "server.js"]
