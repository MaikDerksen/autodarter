import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { describeSettings, type MatchSettings } from '@shared/match';
import type { FriendUser, FriendsOverview } from '@shared/protocol';
import { query } from './db';
import { HttpError, authenticate, parse, userId } from './http';
import { isUserOnline, presenceEvents, sendToUser } from './hub';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
}

export async function areFriends(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const rows = await query(
    `SELECT 1 FROM friendships WHERE status = 'accepted'
       AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
    [a, b],
  );
  return rows.length > 0;
}

export async function friendIds(user: string): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS id
     FROM friendships WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)`,
    [user],
  );
  return rows.map((r) => r.id);
}

/** Running matches (started in the last hours) the given users play in. */
async function playingMap(ids: string[]): Promise<Map<string, { matchId: string; title: string }>> {
  const out = new Map<string, { matchId: string; title: string }>();
  if (!ids.length) return out;
  const rows = await query<{ user_id: string; id: string; settings: MatchSettings }>(
    `SELECT DISTINCT ON (mp.user_id) mp.user_id, m.id, m.settings
     FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE mp.user_id = ANY($1::uuid[]) AND m.status = 'running' AND m.created_at > now() - interval '6 hours'
     ORDER BY mp.user_id, m.created_at DESC`,
    [ids],
  );
  for (const r of rows) out.set(r.user_id, { matchId: r.id, title: describeSettings(r.settings) });
  return out;
}

function toFriend(u: UserRow, playing: Map<string, { matchId: string; title: string }>): FriendUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    online: isUserOnline(u.id),
    playing: playing.get(u.id) ?? null,
  };
}

/** Sort: online first, then by name. */
const byPresence = (a: FriendUser, b: FriendUser) =>
  Number(b.online) - Number(a.online) || a.displayName.localeCompare(b.displayName, 'de');

export async function friendsOverview(user: string): Promise<FriendsOverview> {
  const rows = await query<UserRow & { requester_id: string; status: string }>(
    `SELECT u.id, u.username, u.display_name, f.requester_id, f.status
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
     WHERE f.requester_id = $1 OR f.addressee_id = $1`,
    [user],
  );
  const accepted = rows.filter((r) => r.status === 'accepted');
  const playing = await playingMap(accepted.map((r) => r.id));
  return {
    friends: accepted.map((r) => toFriend(r, playing)).sort(byPresence),
    incoming: rows.filter((r) => r.status === 'pending' && r.requester_id !== user).map((r) => toFriend(r, new Map())),
    outgoing: rows.filter((r) => r.status === 'pending' && r.requester_id === user).map((r) => toFriend(r, new Map())),
  };
}

// Tell online friends when somebody comes online / goes offline.
presenceEvents.on('change', (user: string, online: boolean) => {
  friendIds(user)
    .then((ids) => ids.forEach((id) => sendToUser(id, { type: 'presence', userId: user, online })))
    .catch(() => undefined);
});

export async function friendRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  app.get('/api/friends', async (req) => friendsOverview(userId(req)));

  /** Find players by user name (prefix) to send a friend request. */
  app.get<{ Querystring: { q?: string } }>('/api/users/search', async (req) => {
    const q = (req.query.q ?? '').trim().toLowerCase();
    if (q.length < 2) return [];
    const rows = await query<UserRow>(
      `SELECT id, username, display_name FROM users
       WHERE id <> $1 AND (username LIKE $2 OR lower(display_name) LIKE $2)
       ORDER BY (username = $3) DESC, username LIMIT 10`,
      [userId(req), `${q.replace(/[%_\\]/g, '')}%`, q],
    );
    return rows.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name }));
  });

  app.post('/api/friends', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const me = userId(req);
    const body = parse(z.object({ username: z.string().trim().toLowerCase().min(1).max(32) }), req.body);
    const [target] = await query<UserRow>('SELECT id, username, display_name FROM users WHERE username = $1', [body.username]);
    if (!target) throw new HttpError(404, `Spieler „${body.username}“ gibt es nicht`);
    if (target.id === me) throw new HttpError(400, 'Du kannst dich nicht selbst als Freund hinzufügen');
    const [existing] = await query<{ requester_id: string; status: string }>(
      `SELECT requester_id, status FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
      [me, target.id],
    );
    let status: 'pending' | 'accepted' = 'pending';
    if (existing?.status === 'accepted') {
      status = 'accepted';
    } else if (existing && existing.requester_id === target.id) {
      // they already asked me -> this is an accept
      await query(`UPDATE friendships SET status = 'accepted' WHERE requester_id = $1 AND addressee_id = $2`, [target.id, me]);
      status = 'accepted';
    } else if (!existing) {
      await query('INSERT INTO friendships(requester_id, addressee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me, target.id]);
    }
    sendToUser(target.id, { type: 'friends_changed' });
    sendToUser(me, { type: 'friends_changed' });
    return { status, user: { id: target.id, username: target.username, displayName: target.display_name } };
  });

  app.post<{ Params: { id: string } }>('/api/friends/:id/accept', async (req) => {
    const me = userId(req);
    const rows = await query(
      `UPDATE friendships SET status = 'accepted' WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending' RETURNING 1`,
      [req.params.id, me],
    );
    if (!rows.length) throw new HttpError(404, 'Keine offene Anfrage gefunden');
    sendToUser(req.params.id, { type: 'friends_changed' });
    sendToUser(me, { type: 'friends_changed' });
    return { ok: true };
  });

  /** Decline / withdraw a request or end a friendship. */
  app.delete<{ Params: { id: string } }>('/api/friends/:id', async (req) => {
    const me = userId(req);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'Nicht gefunden');
    await query(
      `DELETE FROM friendships WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
      [me, req.params.id],
    );
    sendToUser(req.params.id, { type: 'friends_changed' });
    sendToUser(me, { type: 'friends_changed' });
    return { ok: true };
  });
}
