import type { FastifyInstance } from 'fastify';
import { config } from './config';
import { query } from './db';
import { HttpError, authenticate, userId } from './http';

/**
 * Server update from the app: the auto-update container (profile "autoupdate") polls
 * /api/health?updater=1 every few seconds. A pending request is handed to it with "update": true.
 */
let updateRequested = 0;
let lastUpdaterPoll = 0;

export async function isAdmin(id: string): Promise<boolean> {
  if (config.adminUsers.length) {
    const [u] = await query<{ username: string }>('SELECT username FROM users WHERE id = $1', [id]);
    return !!u && config.adminUsers.includes(u.username.toLowerCase());
  }
  const [first] = await query<{ id: string }>('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
  return first?.id === id;
}

function updaterActive(): boolean {
  return Date.now() - lastUpdaterPoll < 2 * 60 * 1000;
}

/** Called by the health route when the updater asks; returns true once per request. */
export function updaterPoll(): boolean {
  lastUpdaterPoll = Date.now();
  if (!updateRequested) return false;
  updateRequested = 0;
  return true;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  app.get('/api/admin/update', async (req) => {
    if (!(await isAdmin(userId(req)))) throw new HttpError(403, 'Nur für Admins');
    return { version: config.version, updaterActive: updaterActive(), requested: !!updateRequested };
  });

  app.post('/api/admin/update', async (req) => {
    if (!(await isAdmin(userId(req)))) throw new HttpError(403, 'Nur für Admins');
    if (!updaterActive()) {
      throw new HttpError(
        409,
        'Der Auto-Update-Dienst läuft auf dem Server nicht. In der .env des Servers COMPOSE_PROFILES=autoupdate setzen und „docker compose up -d“ ausführen.',
      );
    }
    updateRequested = Date.now();
    req.log.warn({ user: userId(req) }, 'server update requested');
    return { ok: true };
  });
}
