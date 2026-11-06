import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from './config';
import { query } from './db';
import { HttpError, authenticate, parse, userId } from './http';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  created_at: Date;
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
}

const toPublic = (u: UserRow): PublicUser => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  createdAt: u.created_at.toISOString(),
});

const credentials = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'Benutzername: mindestens 3 Zeichen')
    .max(32)
    .regex(/^[a-zA-Z0-9_.-]+$/, 'Benutzername: nur Buchstaben, Zahlen, _ . -'),
  password: z.string().min(6, 'Passwort: mindestens 6 Zeichen').max(200),
});

const registerBody = credentials.extend({
  displayName: z.string().trim().min(1).max(40).optional(),
});

export async function getUser(id: string): Promise<PublicUser | null> {
  const [u] = await query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  return u ? toPublic(u) : null;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const sign = (u: UserRow) => app.jwt.sign({ sub: u.id, username: u.username }, { expiresIn: '60d' });

  app.get('/api/auth/config', async () => ({ allowRegistration: config.allowRegistration }));

  app.post('/api/auth/register', async (req) => {
    if (!config.allowRegistration) throw new HttpError(403, 'Registrierung ist deaktiviert');
    const body = parse(registerBody, req.body);
    const username = body.username.toLowerCase();
    const exists = await query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (exists.length) throw new HttpError(409, 'Benutzername ist bereits vergeben');
    const hash = await bcrypt.hash(body.password, 10);
    const [u] = await query<UserRow>(
      'INSERT INTO users(username, display_name, password_hash) VALUES ($1, $2, $3) RETURNING *',
      [username, body.displayName ?? body.username, hash],
    );
    return { token: sign(u), user: toPublic(u) };
  });

  app.post('/api/auth/login', async (req) => {
    const body = parse(credentials, req.body);
    const [u] = await query<UserRow>('SELECT * FROM users WHERE username = $1', [body.username.toLowerCase()]);
    if (!u || !(await bcrypt.compare(body.password, u.password_hash))) {
      throw new HttpError(401, 'Benutzername oder Passwort falsch');
    }
    return { token: sign(u), user: toPublic(u) };
  });

  app.get('/api/auth/me', { onRequest: authenticate }, async (req) => {
    const u = await getUser(userId(req));
    if (!u) throw new HttpError(401, 'Benutzer existiert nicht mehr');
    return u;
  });

  app.patch('/api/auth/me', { onRequest: authenticate }, async (req) => {
    const body = parse(
      z.object({
        displayName: z.string().trim().min(1).max(40).optional(),
        password: z.string().min(6).max(200).optional(),
      }),
      req.body,
    );
    if (body.displayName) {
      await query('UPDATE users SET display_name = $2 WHERE id = $1', [userId(req), body.displayName]);
    }
    if (body.password) {
      await query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId(req), await bcrypt.hash(body.password, 10)]);
    }
    return getUser(userId(req));
  });
}
