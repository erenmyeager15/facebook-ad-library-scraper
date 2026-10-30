FROM apify/actor-node-playwright-chrome:24-1.64.1-slim@sha256:a4707291c1fb16ac2db5def501060e2c525a619d87c1170a20de9160f55ad134

# Refuse a stale runtime before installing or running application code.
RUN node -e "const [a,b,c]=process.versions.node.split('.').map(Number); if(a!==24 || b<22 || (b===22 && c<1)) throw new Error('Patched Node 24.22.1 or later in the 24.x line required'); console.log('Verified Node',process.version)"

WORKDIR /usr/src/app

COPY package*.json ./

RUN timeout --signal=TERM --kill-after=5s 90s npm ci --include=dev --omit=optional --no-audit --no-fund

COPY . ./

RUN timeout --signal=TERM --kill-after=5s 30s npm run build \
 && timeout --signal=TERM --kill-after=5s 45s npm prune --omit=dev --omit=optional --no-package-lock --no-audit --no-fund \
 && timeout --signal=TERM --kill-after=5s 25s node scripts/verify-container.mjs

# Inherit the verified /pw-browsers path from this image. Bound the Node heap to
# leave room for Chromium inside the existing 1024 MB allocation.
ENV NODE_OPTIONS="--max-old-space-size=256 --max-semi-space-size=16 --max-http-header-size=80000"

CMD ["node", "dist/main.js"]
