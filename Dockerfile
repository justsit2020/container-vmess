FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    NPM_CONFIG_CACHE=/tmp/.npm \
    npm_config_cache=/tmp/.npm

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["npm","run","start"]
