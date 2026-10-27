# The hub on its own: docker build -t aviator-hub hub/ && docker run -p 8080:8080 -v hub-data:/data aviator-hub
FROM node:24-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./
ENV HUB_DATA_DIR=/data HUB_TRUST_PROXY=1 PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["node", "server.mjs"]
