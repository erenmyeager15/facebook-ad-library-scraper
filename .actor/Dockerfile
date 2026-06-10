FROM apify/actor-node-playwright-chrome:20

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install --include=dev

COPY . .

RUN npm run build

RUN npm prune --production

CMD npm run start
