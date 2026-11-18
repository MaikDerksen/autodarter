import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { VOICE_MAX_BYTES, VOICE_MAX_PACKS, isVoiceKey, type MatchVoice, type VoiceMode, type VoicePack } from '@shared/voice';
import { query } from './db';
import { friendIds } from './friends';
import { HttpError, authenticate, parse, userId } from './http';

interface PackRow {
  id: string;
  owner_id: string;
  owner_name: string;
  name: string;
  shared: boolean;
  updated_at: Date;
  keys: string[] | null;
}

const PACK_SELECT = `
  SELECT p.id, p.owner_id, u.display_name AS owner_name, p.name, p.shared, p.updated_at,
         (SELECT array_agg(c.key ORDER BY c.key) FROM voice_clips c WHERE c.pack_id = p.id) AS keys
  FROM voice_packs p JOIN users u ON u.id = p.owner_id`;

const UUID = /^[0-9a-f-]{36}$/i;

function toPack(r: PackRow, me: string): VoicePack {
  return {
    id: r.id,
    name: r.name,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    shared: r.shared,
    mine: r.owner_id === me,
    keys: r.keys ?? [],
    version: r.updated_at.getTime(),
  };
}

async function getPack(id: string): Promise<PackRow | null> {
  if (!UUID.test(id)) return null;
  const [r] = await query<PackRow>(`${PACK_SELECT} WHERE p.id = $1`, [id]);
  return r ?? null;
}

/** Own packs and packs friends share. */
async function canUse(pack: PackRow, user: string): Promise<boolean> {
  if (pack.owner_id === user) return true;
  return pack.shared && (await friendIds(user)).includes(pack.owner_id);
}

async function ownPack(id: string, user: string): Promise<PackRow> {
  const pack = await getPack(id);
  if (!pack || pack.owner_id !== user) throw new HttpError(404, 'Stimmen-Paket nicht gefunden');
  return pack;
}

/** May the user pick this pack (own pack or shared by a friend)? */
export async function canUsePack(packId: string, user: string): Promise<boolean> {
  const pack = await getPack(packId);
  return !!pack && (await canUse(pack, user));
}

/** A pack as used in a match (null if it was deleted). */
export async function matchVoice(packId: string | null): Promise<MatchVoice | null> {
  if (!packId) return null;
  const pack = await getPack(packId);
  if (!pack) return null;
  return { packId: pack.id, name: pack.name, keys: pack.keys ?? [], version: pack.updated_at.getTime() };
}

/** The pack a user has chosen in the profile (if they may still use it). */
export async function activePackOf(user: string): Promise<string | null> {
  const [u] = await query<{ voice_pack_id: string | null }>('SELECT voice_pack_id FROM users WHERE id = $1', [user]);
  if (!u?.voice_pack_id) return null;
  const pack = await getPack(u.voice_pack_id);
  return pack && (await canUse(pack, user)) ? pack.id : null;
}

/**
 * Voice per player of a match: explicit choice when the match was created, otherwise – in "own"
 * mode – the pack the player chose in their profile, otherwise the pack of the host.
 */
export async function resolveVoices(
  players: { userId?: string | null; voicePackId?: string | null }[],
  mode: VoiceMode,
  host: MatchVoice | null,
): Promise<(MatchVoice | null)[]> {
  const packs = new Map<string, Promise<MatchVoice | null>>();
  const voiceOf = (id: string) => {
    if (!packs.has(id)) packs.set(id, matchVoice(id).catch(() => null));
    return packs.get(id)!;
  };
  return Promise.all(
    players.map(async (p) => {
      if (p.voicePackId === null) return null;
      if (p.voicePackId) return voiceOf(p.voicePackId);
      if (mode === 'own' && p.userId) {
        const own = await activePackOf(p.userId).catch(() => null);
        if (own) return voiceOf(own);
      }
      return host;
    }),
  );
}

const touch = (id: string) => query('UPDATE voice_packs SET updated_at = now() WHERE id = $1', [id]);

export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  app.get('/api/voice-packs', async (req) => {
    const me = userId(req);
    const friends = await friendIds(me);
    const rows = await query<PackRow>(
      `${PACK_SELECT} WHERE p.owner_id = $1 OR (p.shared AND p.owner_id = ANY($2::uuid[]))
       ORDER BY (p.owner_id = $1) DESC, p.name`,
      [me, friends],
    );
    return { packs: rows.map((r) => toPack(r, me)), activeId: await activePackOf(me) };
  });

  app.post('/api/voice-packs', async (req) => {
    const me = userId(req);
    const body = parse(z.object({ name: z.string().trim().min(1).max(40) }), req.body);
    const [{ count }] = await query<{ count: string }>('SELECT count(*) FROM voice_packs WHERE owner_id = $1', [me]);
    if (Number(count) >= VOICE_MAX_PACKS) throw new HttpError(409, `Maximal ${VOICE_MAX_PACKS} Stimmen-Pakete pro Konto`);
    const [row] = await query<{ id: string }>('INSERT INTO voice_packs(owner_id, name) VALUES ($1, $2) RETURNING id', [me, body.name]);
    return toPack((await getPack(row.id))!, me);
  });

  app.patch<{ Params: { id: string } }>('/api/voice-packs/:id', async (req) => {
    const me = userId(req);
    await ownPack(req.params.id, me);
    const body = parse(z.object({ name: z.string().trim().min(1).max(40).optional(), shared: z.boolean().optional() }), req.body);
    if (body.name !== undefined) await query('UPDATE voice_packs SET name = $2 WHERE id = $1', [req.params.id, body.name]);
    if (body.shared !== undefined) await query('UPDATE voice_packs SET shared = $2 WHERE id = $1', [req.params.id, body.shared]);
    return toPack((await getPack(req.params.id))!, me);
  });

  app.delete<{ Params: { id: string } }>('/api/voice-packs/:id', async (req) => {
    await ownPack(req.params.id, userId(req));
    await query('DELETE FROM voice_packs WHERE id = $1', [req.params.id]);
    return { ok: true };
  });

  app.put<{ Params: { id: string; key: string } }>('/api/voice-packs/:id/clips/:key', async (req) => {
    const me = userId(req);
    await ownPack(req.params.id, me);
    if (!isVoiceKey(req.params.key)) throw new HttpError(400, 'Unbekannte Ansage');
    const body = parse(
      z.object({ data: z.string().min(10), mime: z.string().regex(/^audio\/[a-z0-9.+-]+(;.*)?$/i, 'Kein Audioformat') }),
      req.body,
    );
    const data = Buffer.from(body.data.replace(/^data:[^,]*,/, ''), 'base64');
    if (data.length < 100) throw new HttpError(400, 'Aufnahme ist leer');
    if (data.length > VOICE_MAX_BYTES) throw new HttpError(413, 'Aufnahme ist zu lang');
    await query(
      `INSERT INTO voice_clips(pack_id, key, mime, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (pack_id, key) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = now()`,
      [req.params.id, req.params.key, body.mime.split(';')[0].toLowerCase(), data],
    );
    await touch(req.params.id);
    return toPack((await getPack(req.params.id))!, me);
  });

  app.delete<{ Params: { id: string; key: string } }>('/api/voice-packs/:id/clips/:key', async (req) => {
    const me = userId(req);
    await ownPack(req.params.id, me);
    await query('DELETE FROM voice_clips WHERE pack_id = $1 AND key = $2', [req.params.id, req.params.key]);
    await touch(req.params.id);
    return toPack((await getPack(req.params.id))!, me);
  });

  /** Choose the pack for the matches I create (null = standard voice). */
  app.put('/api/me/voice-pack', async (req) => {
    const me = userId(req);
    const body = parse(z.object({ packId: z.string().uuid().nullable() }), req.body);
    if (body.packId) {
      const pack = await getPack(body.packId);
      if (!pack || !(await canUse(pack, me))) throw new HttpError(404, 'Stimmen-Paket nicht gefunden');
    }
    await query('UPDATE users SET voice_pack_id = $2 WHERE id = $1', [me, body.packId]);
    return { activeId: body.packId };
  });
}

/** Audio files are fetched by <audio>/players without a login header – the pack id (UUID) is the secret. */
export async function voicePublicRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string; key: string } }>('/api/voice/:id/:key', async (req, reply) => {
    if (!UUID.test(req.params.id) || !isVoiceKey(req.params.key)) throw new HttpError(404, 'Nicht gefunden');
    const [clip] = await query<{ mime: string; data: Buffer }>('SELECT mime, data FROM voice_clips WHERE pack_id = $1 AND key = $2', [
      req.params.id,
      req.params.key,
    ]);
    if (!clip) throw new HttpError(404, 'Nicht gefunden');
    return reply
      .header('content-type', clip.mime)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(clip.data);
  });
}
