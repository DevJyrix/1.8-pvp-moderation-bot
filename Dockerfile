FROM ghcr.io/lavalink-devs/lavalink:4 AS lavalink

FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    default-jre-headless \
    && rm -rf /var/lib/apt/lists/*

COPY --from=lavalink /opt/Lavalink/Lavalink.jar /app/lavalink/Lavalink.jar
COPY lavalink/application.yml /app/lavalink/application.yml

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=optional
COPY . .

CMD ["node", "start.js"]
