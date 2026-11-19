
FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/auth_baileys

EXPOSE 3000

CMD ["node", "bot.js"]
