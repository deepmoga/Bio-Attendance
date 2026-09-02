FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8080
VOLUME ["/app/data"]
CMD ["node", "src/server.js"]
