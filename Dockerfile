FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "server.mjs"]
