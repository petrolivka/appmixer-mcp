FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The HTTP server binds to 127.0.0.1 by default; in a container it must
# listen on all interfaces (publish the port and terminate TLS in front).
ENV MCP_HTTP_HOST=0.0.0.0
ENV MCP_HTTP_PORT=3000
EXPOSE 3000

USER node
HEALTHCHECK --interval=30s --timeout=3s \
    CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/http-main.js"]
