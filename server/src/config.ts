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
};
