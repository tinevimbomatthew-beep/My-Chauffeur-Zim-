
FROM node:22-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/auth_baileys

CMD ["npm", "start"]
