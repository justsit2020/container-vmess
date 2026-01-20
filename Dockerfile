FROM node:20-bookworm-slim

WORKDIR /app
COPY package.json ./
COPY package-lock.json* yarn.lock* ./

RUN if [ -f yarn.lock ]; then corepack enable && yarn install --frozen-lockfile; \
    else npm ci || npm install; fi

COPY . .
CMD ["node", "index.js"]
