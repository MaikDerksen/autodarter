import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function jwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (s && s.length >= 16) return s;
  console.warn('[config] JWT_SECRET fehlt oder ist zu kurz – es wird ein zufälliges Secret verwendet (Logins gehen bei Neustart verloren).');
  return randomBytes(32).toString('hex');
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://autodarter:autodarter@localhost:5432/autodarter',
  jwtSecret: jwtSecret(),
  webDir: process.env.WEB_DIR ?? path.resolve(here, '../../app/dist'),
  allowRegistration: (process.env.ALLOW_REGISTRATION ?? 'true').toLowerCase() !== 'false',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Live camera stream sent by the boards while somebody watches (lower it on slow uploads). */
  streamFps: Number(process.env.STREAM_FPS ?? 4),
  streamMaxWidth: Number(process.env.STREAM_MAX_WIDTH ?? 640),
  /** A running match blocks its board; after this many idle minutes others may start a new match. */
  boardIdleMinutes: Number(process.env.BOARD_IDLE_MINUTES ?? 30),
  /** Running matches without any dart for this long are ended automatically. */
  staleMatchHours: Number(process.env.STALE_MATCH_HOURS ?? 12),
  /** Usernames that may update the server from the app (comma separated). Empty = the first registered account. */
  adminUsers: (process.env.ADMIN_USERS ?? '')
    .split(',')
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean),
  /** Set at image build time (CI), shown in the app. */
  version: process.env.AUTODARTER_VERSION ?? 'dev',
};
