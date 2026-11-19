
FROM node:22-bookworm-slim

# Install Git and certificates
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

COPY . .

# Create authentication directory
RUN mkdir -p /app/auth_baileys

EXPOSE 3000

CMD ["node", "bot.js"]
