FROM apify/actor-node-playwright-chrome:20

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --include=dev

COPY . ./

RUN npm run build && npm prune --omit=dev --no-package-lock

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

CMD ["node", "dist/main.js"]
