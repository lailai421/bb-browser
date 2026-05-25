FROM node:22-bookworm-slim

# Chrome dependencies (full Chrome needs these for --headless=new)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip fonts-noto-cjk fonts-noto-color-emoji \
    libnss3 libxss1 libasound2 libatk-bridge2.0-0 libgtk-3-0 libdrm2 \
    libgbm1 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
    libpango-1.0-0 libcairo2 libcups2 libdbus-1-3 libexpat1 \
    libxext6 libxfixes3 libxkbcommon0 libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built daemon and install runtime deps
COPY dist/ ./dist/
COPY web/ ./web/
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts 2>/dev/null || true

# bb-browser daemon will auto-download Chrome for Testing on first start.
# No need to pre-install Chrome — it downloads to ~/.bb-browser/browser/

ENV NODE_ENV=production
ENV BB_BROWSER_HOME=/data

EXPOSE 19824

ENTRYPOINT ["node", "dist/daemon.js"]
