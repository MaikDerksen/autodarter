# Autodarter server image: API + WebSockets + the web build of the Expo app.
# Build context is the repository root (see docker-compose.yml).

# ---------- web app (Expo / React Native Web)
FROM node:24-bookworm-slim AS web
ENV CI=1 EXPO_NO_TELEMETRY=1
WORKDIR /src
COPY app/package.json app/package-lock.json app/
RUN cd app && npm ci --no-audit --no-fund
COPY shared/src shared/src
COPY app app
RUN cd app && npx expo export --platform web --output-dir dist

# ---------- server bundle
FROM node:24-alpine AS server-build
WORKDIR /src
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --no-audit --no-fund
COPY shared/src shared/src
COPY server server
RUN cd server && node build.mjs

# ---------- runtime
FROM node:24-alpine
ENV NODE_ENV=production PORT=3000 WEB_DIR=/app/web
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=server-build /src/server/dist ./dist
COPY --from=web /src/app/dist ./web
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/index.js"]
