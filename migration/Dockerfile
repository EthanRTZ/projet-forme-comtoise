FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY migrate.js ./
CMD ["node", "migrate.js"]
