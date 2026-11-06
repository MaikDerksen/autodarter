import { existsSync } from 'node:fs';
import path from 'node:path';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { authRoutes } from './auth';
import { boardRoutes, cleanupBoards, handleBoardSocket } from './boards';
import { handleClientSocket } from './clientSocket';
import { config } from './config';
import { migrate, pool } from './db';
import { HttpError } from './http';
import { matchRoutes, restoreActiveMatches } from './matches';
import { statsRoutes } from './stats';

const app = Fastify({ logger: { level: config.logLevel }, bodyLimit: 2 * 1024 * 1024, trustProxy: true });

await app.register(cors, { origin: true });
await app.register(jwt, { secret: config.jwtSecret });
await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });

// Accept empty JSON bodies (e.g. POST /undo without payload).
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const text = String(body ?? '').trim();
  if (!text) return done(null, undefined);
  try {
    done(null, JSON.parse(text));
  } catch {
    done(new HttpError(400, 'Ungültiges JSON'), undefined);
  }
});

app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
  if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
  req.log.error({ err }, 'request failed');
  return reply.code(500).send({ error: 'Interner Serverfehler' });
});

app.get('/api/health', async () => {
  await pool.query('SELECT 1');
  return { ok: true };
});

await app.register(authRoutes);
await app.register(boardRoutes);
await app.register(matchRoutes);
await app.register(statsRoutes);

app.get('/ws/board', { websocket: true }, (socket) => handleBoardSocket(socket, app.log));
app.get<{ Querystring: { token?: string } }>('/ws', { websocket: true }, (socket, req) =>
  handleClientSocket(app, socket, req.query.token),
);

// ---- web app (Expo web export) with SPA fallback
const indexHtml = path.join(config.webDir, 'index.html');
const hasWeb = existsSync(indexHtml);
if (hasWeb) {
  await app.register(fastifyStatic, { root: config.webDir, wildcard: true, index: ['index.html'] });
  app.log.info(`Web-App wird aus ${config.webDir} ausgeliefert`);
} else {
  app.log.warn(`Keine Web-App unter ${config.webDir} gefunden – nur API aktiv`);
}
app.setNotFoundHandler((req, reply) => {
  const isApi = req.url.startsWith('/api/') || req.url.startsWith('/ws');
  const isAsset = /\.[a-z0-9]{2,5}(\?|$)/i.test(req.url);
  if (hasWeb && req.method === 'GET' && !isApi && !isAsset) {
    // client-side routes of the single page app
    return reply.header('cache-control', 'no-cache').type('text/html').sendFile('index.html');
  }
  return reply.code(404).send({ error: 'Nicht gefunden' });
});

await migrate();
await restoreActiveMatches();
await cleanupBoards().catch(() => undefined);
setInterval(() => cleanupBoards().catch(() => undefined), 24 * 3600 * 1000).unref();

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });
