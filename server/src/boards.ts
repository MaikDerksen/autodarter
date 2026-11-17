import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { CALIBRATION_POINTS } from '@shared/board';
import type {
  BoardActiveMatch,
  BoardMember,
  BoardRole,
  BoardSettings,
  BoardStatus,
  BoardSummary,
  BoardToServer,
  CameraCalibration,
  DetectedDart,
  ServerToBoard,
} from '@shared/protocol';
import { config } from './config';
import { query } from './db';
import { areFriends } from './friends';
import { HttpError, authenticate, parse, userId } from './http';
import { isUserOnline, publishBoard, publishFrame, revokeBoard, streamDemand } from './hub';

interface BoardRow {
  id: string;
  /** The board's owner (admin). All users with access – owner included – are in board_members. */
  owner_id: string | null;
  name: string;
  secret_hash: string;
  pairing_code: string | null;
  calibration: Record<string, CameraCalibration | null>;
  /** last known calibration per camera id (never shrinks when the Pi forgets one) */
  calibration_backup: Record<string, CameraCalibration>;
  settings: BoardSettings | null;
  last_seen: Date | null;
}

interface LiveBoard {
  id: string;
  socket: WebSocket;
  ownerId: string | null;
  name: string;
  status: BoardStatus | null;
  calibration: Record<string, CameraCalibration | null>;
  settings: BoardSettings | null;
  /** Last stream request sent to the board (JSON), to avoid resending. */
  streamKey: string;
  pending: Map<string, (msg: Extract<BoardToServer, { type: 'snapshot' }>) => void>;
}

const live = new Map<string, LiveBoard>();

/** Emits 'dart' (boardId, dart), 'takeout_started' (boardId), 'takeout_finished' (boardId). */
export const boardEvents = new EventEmitter();

/** Resolves the running match of a board (set by the match module to avoid an import cycle). */
let activeMatchLookup: (boardId: string) => BoardActiveMatch | null = () => null;
export function setActiveMatchLookup(fn: (boardId: string) => BoardActiveMatch | null) {
  activeMatchLookup = fn;
}

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function pairingCode(): string {
  const bytes = randomBytes(6);
  return Array.from(bytes, (b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join('');
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function baseSummary(row: BoardRow): Promise<Omit<BoardSummary, 'role'>> {
  const l = live.get(row.id);
  const [count] = await query<{ n: number }>('SELECT count(*)::int AS n FROM board_members WHERE board_id = $1', [row.id]);
  const active = activeMatchLookup(row.id);
  return {
    id: row.id,
    name: row.name,
    online: !!l,
    status: l?.status ?? null,
    calibration: l?.calibration ?? row.calibration ?? {},
    settings: l?.settings ?? row.settings ?? null,
    activeMatchId: active?.id ?? null,
    activeMatch: active,
    lastSeen: row.last_seen ? row.last_seen.toISOString() : null,
    pairingCode: row.pairing_code,
    memberCount: count?.n ?? 0,
  };
}

/** Guests (players of a remote match) only see the status, not the pairing code. */
function withRole(base: Omit<BoardSummary, 'role'>, role: BoardRole): BoardSummary {
  return { ...base, role, pairingCode: role === 'guest' ? null : base.pairingCode };
}

async function summary(row: BoardRow, role: BoardRole): Promise<BoardSummary> {
  return withRole(await baseSummary(row), role);
}

async function getRow(id: string): Promise<BoardRow | null> {
  const [row] = await query<BoardRow>('SELECT * FROM boards WHERE id = $1', [id]);
  return row ?? null;
}

/** Role of a user on a board, null = no access. */
export async function canAccessBoard(id: string, user: string): Promise<BoardRole | null> {
  const [r] = await query<{ role: BoardRole }>('SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2', [id, user]);
  return r?.role ?? null;
}

async function requireMember(id: string, user: string): Promise<{ row: BoardRow; role: BoardRole }> {
  const role = await canAccessBoard(id, user);
  const row = role ? await getRow(id) : null;
  if (!row || !role) throw new HttpError(404, 'Board nicht gefunden');
  return { row, role };
}

async function requireOwner(id: string, user: string): Promise<BoardRow> {
  const { row, role } = await requireMember(id, user);
  if (role !== 'owner') throw new HttpError(403, 'Das darf nur der Besitzer des Boards');
  return row;
}

export function sendToBoard(id: string, msg: ServerToBoard): boolean {
  const l = live.get(id);
  if (!l || l.socket.readyState !== l.socket.OPEN) return false;
  l.socket.send(JSON.stringify(msg));
  return true;
}

export function isBoardOnline(id: string): boolean {
  return live.has(id);
}

export async function publishBoardStatus(id: string): Promise<void> {
  const row = await getRow(id);
  if (!row) return;
  const base = await baseSummary(row);
  publishBoard(id, (c) => ({ type: 'board_status', board: withRole(base, c.boardRoles.get(id) ?? 'member') }));
}

export async function currentBoardSummary(id: string, role: BoardRole): Promise<BoardSummary | null> {
  const row = await getRow(id);
  return row ? summary(row, role) : null;
}

/** Tell the board which camera images are currently watched (raw and/or frontal view). */
export function refreshStream(id: string): void {
  const l = live.get(id);
  if (!l) return;
  const d = streamDemand(id);
  const key = JSON.stringify(d);
  if (key === l.streamKey) return;
  l.streamKey = key;
  sendToBoard(id, {
    type: 'stream',
    enabled: d.raw || d.front.length > 0,
    fps: config.streamFps,
    maxWidth: config.streamMaxWidth,
    raw: d.raw,
    front: d.front,
  });
}

function welcome(row: BoardRow) {
  sendToBoard(row.id, {
    type: 'welcome',
    claimed: !!row.owner_id,
    pairingCode: row.pairing_code,
    name: row.owner_id ? row.name : null,
    calibrationBackup: row.calibration_backup ?? {},
  });
}

/** Calibrations the board reports (with camera id) – kept as backup on the server. */
function backupEntries(cal: Record<string, CameraCalibration | null> | undefined): Record<string, CameraCalibration> {
  const out: Record<string, CameraCalibration> = {};
  for (const c of Object.values(cal ?? {})) {
    if (c?.camId && Array.isArray(c.points) && c.points.length === 5) out[c.camId] = { points: c.points, camId: c.camId };
  }
  return out;
}

function requestSnapshot(id: string, camera: number): Promise<Extract<BoardToServer, { type: 'snapshot' }>> {
  const l = live.get(id);
  if (!l) return Promise.reject(new HttpError(409, 'Board ist offline'));
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      l.pending.delete(requestId);
      reject(new HttpError(504, 'Board hat nicht rechtzeitig geantwortet'));
    }, 8000);
    l.pending.set(requestId, (msg) => {
      clearTimeout(timer);
      l.pending.delete(requestId);
      resolve(msg);
    });
    sendToBoard(id, { type: 'snapshot_request', requestId, camera });
  });
}

/** WebSocket handler for board clients (Raspberry Pi). */
export function handleBoardSocket(socket: WebSocket, log: FastifyInstance['log']): void {
  let board: LiveBoard | null = null;
  let alive = true;

  const ping = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, 20000);
  socket.on('pong', () => (alive = true));

  const helloTimeout = setTimeout(() => {
    if (!board) socket.close(4001, 'hello expected');
  }, 10000);

  // Messages of one board are processed strictly in order: right after a reconnect the board
  // sends its hello followed by buffered darts, which must not overtake the (async) hello.
  let chain: Promise<void> = Promise.resolve();
  const handle = async (raw: unknown) => {
    let msg: BoardToServer;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    try {
      if (msg.type === 'hello') {
        board = await onHello(socket, msg, log);
        clearTimeout(helloTimeout);
        return;
      }
      if (!board) return;
      await onBoardMessage(board, msg);
    } catch (err) {
      log.error({ err }, 'board message failed');
    }
  };
  socket.on('message', (raw) => {
    alive = true;
    chain = chain.then(() => handle(raw));
  });

  socket.on('close', async () => {
    clearInterval(ping);
    clearTimeout(helloTimeout);
    if (board && live.get(board.id) === board) {
      live.delete(board.id);
      log.info({ board: board.id }, 'board disconnected');
      await query('UPDATE boards SET last_seen = now() WHERE id = $1', [board.id]).catch(() => undefined);
      await publishBoardStatus(board.id).catch(() => undefined);
    }
  });
}

async function onHello(
  socket: WebSocket,
  msg: Extract<BoardToServer, { type: 'hello' }>,
  log: FastifyInstance['log'],
): Promise<LiveBoard | null> {
  const idOk = typeof msg.boardId === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(msg.boardId);
  if (!idOk || typeof msg.secret !== 'string' || msg.secret.length < 16) {
    socket.send(JSON.stringify({ type: 'error', message: 'invalid hello' } satisfies ServerToBoard));
    socket.close(4002, 'invalid hello');
    return null;
  }
  let row = await getRow(msg.boardId);
  if (!row) {
    const [created] = await query<BoardRow>(
      `INSERT INTO boards(id, secret_hash, pairing_code, calibration, settings, last_seen)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING *`,
      [msg.boardId, sha256(msg.secret), pairingCode(), JSON.stringify(msg.calibration ?? {}), JSON.stringify(msg.settings ?? null)],
    );
    row = created;
    log.info({ board: row.id }, 'new board registered');
  } else {
    const a = Buffer.from(row.secret_hash);
    const b = Buffer.from(sha256(msg.secret));
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      socket.send(JSON.stringify({ type: 'error', message: 'Board-ID bereits mit anderem Secret registriert' } satisfies ServerToBoard));
      socket.close(4003, 'secret mismatch');
      return null;
    }
    [row] = await query<BoardRow>(
      `UPDATE boards SET calibration = $2, settings = $3, last_seen = now(), pairing_code = COALESCE(pairing_code, $4),
              calibration_backup = calibration_backup || $5::jsonb
       WHERE id = $1 RETURNING *`,
      [row.id, JSON.stringify(msg.calibration ?? {}), JSON.stringify(msg.settings ?? null), pairingCode(), JSON.stringify(backupEntries(msg.calibration))],
    );
  }

  const previous = live.get(row.id);
  if (previous) previous.socket.close(4004, 'replaced by new connection');

  const board: LiveBoard = {
    id: row.id,
    socket,
    ownerId: row.owner_id,
    name: row.name,
    status: msg.status ?? null,
    calibration: msg.calibration ?? {},
    settings: msg.settings ?? null,
    streamKey: '',
    pending: new Map(),
  };
  live.set(row.id, board);
  log.info({ board: row.id, claimed: !!row.owner_id }, 'board connected');
  welcome(row);
  refreshStream(row.id);
  await publishBoardStatus(row.id);
  return board;
}

async function onBoardMessage(board: LiveBoard, msg: BoardToServer): Promise<void> {
  switch (msg.type) {
    case 'status':
      board.status = msg.status;
      await publishBoardStatus(board.id);
      break;
    case 'calibration':
      board.calibration = msg.calibration ?? {};
      await query('UPDATE boards SET calibration = $2, calibration_backup = calibration_backup || $3::jsonb WHERE id = $1', [
        board.id,
        JSON.stringify(board.calibration),
        JSON.stringify(backupEntries(board.calibration)),
      ]);
      await publishBoardStatus(board.id);
      break;
    case 'settings':
      board.settings = msg.settings;
      await query('UPDATE boards SET settings = $2 WHERE id = $1', [board.id, JSON.stringify(board.settings)]);
      await publishBoardStatus(board.id);
      break;
    case 'dart':
      if (!board.ownerId) return;
      publishBoard(board.id, { type: 'board_dart', boardId: board.id, dart: msg.dart });
      boardEvents.emit('dart', board.id, msg.dart as DetectedDart);
      break;
    case 'takeout_started':
    case 'takeout_finished':
      if (!board.ownerId) return;
      publishBoard(board.id, { type: 'board_event', boardId: board.id, event: msg.type });
      boardEvents.emit(msg.type, board.id);
      break;
    case 'frame': {
      const view = msg.view === 'front' ? 'front' : 'raw';
      publishFrame(board.id, view, msg.camera, {
        type: 'board_frame',
        boardId: board.id,
        camera: msg.camera,
        data: msg.data,
        width: msg.width,
        height: msg.height,
        view,
      });
      break;
    }
    case 'snapshot':
      board.pending.get(msg.requestId)?.(msg);
      break;
    case 'pong':
      break;
  }
}

/** Keep the in-memory board and the Pi in sync after ownership / pairing changes. */
async function afterMembershipChange(id: string): Promise<void> {
  const row = await getRow(id);
  if (!row) return;
  const l = live.get(id);
  if (l) {
    l.ownerId = row.owner_id;
    l.name = row.name;
  }
  welcome(row);
  await publishBoardStatus(id);
}

const calibrationBody = z.object({
  points: z
    .array(z.object({ x: z.number().min(-0.5).max(1.5), y: z.number().min(-0.5).max(1.5) }))
    .length(CALIBRATION_POINTS.length),
});

const settingsBody = z
  .object({
    resolution: z.tuple([z.number().int().min(320).max(1920), z.number().int().min(240).max(1080)]),
    fps: z.number().int().min(5).max(60),
    diffThreshold: z.number().int().min(5).max(120),
    minDartArea: z.number().int().min(10).max(5000),
    takeoutArea: z.number().int().min(500).max(200000),
    settleFrames: z.number().int().min(1).max(30),
  })
  .partial();

/** Commands every member may send; the rest only the owner. */
const MEMBER_COMMANDS = new Set(['start', 'stop', 'reset', 'rescan', 'restart']);

export async function boardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  app.get('/api/boards', async (req) => {
    const rows = await query<BoardRow & { role: BoardRole }>(
      `SELECT b.*, m.role FROM boards b JOIN board_members m ON m.board_id = b.id
       WHERE m.user_id = $1 ORDER BY m.created_at`,
      [userId(req)],
    );
    return Promise.all(rows.map((r) => summary(r, r.role)));
  });

  app.get<{ Params: { id: string } }>('/api/boards/:id', async (req) => {
    const { row, role } = await requireMember(req.params.id, userId(req));
    return summary(row, role);
  });

  /**
   * Add a board to the own account with its pairing code. The first user becomes the owner,
   * everybody after that a member. The code changes after every use.
   */
  app.post('/api/boards/claim', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = userId(req);
    const body = parse(
      z.object({
        code: z.string().trim().toUpperCase().min(4).max(12),
        name: z.string().trim().min(1).max(40).optional(),
      }),
      req.body,
    );
    const code = body.code.replace(/[^A-Z0-9]/g, '');
    const [found] = await query<BoardRow>('SELECT * FROM boards WHERE pairing_code = $1', [code]);
    if (!found) throw new HttpError(404, 'Kein Board mit diesem Code gefunden. Ist der Pi online?');
    const existing = await canAccessBoard(found.id, user);
    if (existing) return summary(found, existing);

    const [row] = await query<BoardRow>(
      `UPDATE boards SET pairing_code = $3,
         name = CASE WHEN owner_id IS NULL THEN COALESCE($4, name) ELSE name END,
         owner_id = COALESCE(owner_id, $2)
       WHERE id = $1 AND pairing_code = $5 RETURNING *`,
      [found.id, user, pairingCode(), body.name ?? null, code],
    );
    if (!row) throw new HttpError(409, 'Der Code wurde gerade verwendet – bitte den neuen Code eingeben');
    const role: BoardRole = row.owner_id === user ? 'owner' : 'member';
    await query('INSERT INTO board_members(board_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [row.id, user, role]);
    req.log.info({ board: row.id, user, role }, 'board added to account');
    await afterMembershipChange(row.id);
    return summary(row, role);
  });

  app.patch<{ Params: { id: string } }>('/api/boards/:id', async (req) => {
    await requireOwner(req.params.id, userId(req));
    const body = parse(z.object({ name: z.string().trim().min(1).max(40) }), req.body);
    const [row] = await query<BoardRow>('UPDATE boards SET name = $2 WHERE id = $1 RETURNING *', [req.params.id, body.name]);
    await afterMembershipChange(row.id);
    return summary(row, 'owner');
  });

  /** Remove the board from the own account. If the owner leaves, the longest member takes over. */
  app.delete<{ Params: { id: string } }>('/api/boards/:id', async (req) => {
    const user = userId(req);
    const { role } = await requireMember(req.params.id, user);
    await query('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', [req.params.id, user]);
    if (role === 'owner') {
      const [next] = await query<{ user_id: string }>(
        'SELECT user_id FROM board_members WHERE board_id = $1 ORDER BY created_at LIMIT 1',
        [req.params.id],
      );
      if (next) {
        await query(`UPDATE board_members SET role = 'owner' WHERE board_id = $1 AND user_id = $2`, [req.params.id, next.user_id]);
        await query('UPDATE boards SET owner_id = $2 WHERE id = $1', [req.params.id, next.user_id]);
      } else {
        await query('UPDATE boards SET owner_id = NULL, pairing_code = $2 WHERE id = $1', [req.params.id, pairingCode()]);
      }
    }
    revokeBoard(user, req.params.id);
    refreshStream(req.params.id);
    await afterMembershipChange(req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/boards/:id/members', async (req) => {
    await requireMember(req.params.id, userId(req));
    const rows = await query<{ user_id: string; username: string; display_name: string; role: BoardRole }>(
      `SELECT m.user_id, u.username, u.display_name, m.role FROM board_members m JOIN users u ON u.id = m.user_id
       WHERE m.board_id = $1 ORDER BY (m.role = 'owner') DESC, m.created_at`,
      [req.params.id],
    );
    return rows.map(
      (r): BoardMember => ({
        userId: r.user_id,
        username: r.username,
        displayName: r.display_name,
        role: r.role,
        online: isUserOnline(r.user_id),
      }),
    );
  });

  /** Share the board with a friend. */
  app.post<{ Params: { id: string } }>('/api/boards/:id/members', async (req) => {
    const user = userId(req);
    await requireOwner(req.params.id, user);
    const body = parse(z.object({ userId: z.string().uuid() }), req.body);
    if (!(await areFriends(user, body.userId))) throw new HttpError(403, 'Boards kannst du nur mit Freunden teilen');
    await query(`INSERT INTO board_members(board_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [
      req.params.id,
      body.userId,
    ]);
    await publishBoardStatus(req.params.id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string; userId: string } }>('/api/boards/:id/members/:userId', async (req) => {
    const user = userId(req);
    await requireOwner(req.params.id, user);
    if (req.params.userId === user) throw new HttpError(400, 'Zum Verlassen „Board entfernen“ verwenden');
    await query('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', [req.params.id, req.params.userId]);
    revokeBoard(req.params.userId, req.params.id);
    refreshStream(req.params.id);
    await publishBoardStatus(req.params.id);
    return { ok: true };
  });

  /** New pairing code (e.g. if the old one was passed on too widely). */
  app.post<{ Params: { id: string } }>('/api/boards/:id/pairing-code', async (req) => {
    await requireOwner(req.params.id, userId(req));
    const [row] = await query<BoardRow>('UPDATE boards SET pairing_code = $2 WHERE id = $1 RETURNING *', [req.params.id, pairingCode()]);
    await afterMembershipChange(row.id);
    return { pairingCode: row.pairing_code };
  });

  app.post<{ Params: { id: string } }>('/api/boards/:id/command', async (req) => {
    const user = userId(req);
    const { role } = await requireMember(req.params.id, user);
    const body = parse(z.object({ action: z.enum(['start', 'stop', 'reset', 'rescan', 'restart', 'reboot', 'update']) }), req.body);
    if (!MEMBER_COMMANDS.has(body.action) && role !== 'owner') throw new HttpError(403, 'Das darf nur der Besitzer des Boards');
    const l = live.get(req.params.id);
    if (!l) throw new HttpError(409, 'Board ist offline');
    if (body.action === 'reboot' && !l.status?.capabilities?.reboot) {
      throw new HttpError(409, 'Pi-Neustart ist auf diesem Board nicht freigegeben (ALLOW_REBOOT=true in board/.env setzen).');
    }
    if (body.action === 'update' && !l.status?.capabilities?.update) {
      throw new HttpError(409, 'Auto-Update ist auf dem Pi nicht aktiv (COMPOSE_PROFILES=autoupdate in board/.env setzen).');
    }
    if (!sendToBoard(req.params.id, { type: 'command', action: body.action })) throw new HttpError(409, 'Board ist offline');
    req.log.info({ board: req.params.id, action: body.action, user }, 'board command');
    return { ok: true };
  });

  app.get<{ Params: { id: string; cam: string } }>('/api/boards/:id/cameras/:cam/snapshot', async (req) => {
    await requireMember(req.params.id, userId(req));
    const snap = await requestSnapshot(req.params.id, Number(req.params.cam));
    if (!snap.data) throw new HttpError(404, 'Kamera liefert kein Bild');
    return { data: snap.data, width: snap.width, height: snap.height };
  });

  app.put<{ Params: { id: string; cam: string } }>('/api/boards/:id/cameras/:cam/calibration', async (req) => {
    await requireMember(req.params.id, userId(req));
    const camera = Number(req.params.cam);
    const body = req.body === null ? null : parse(calibrationBody, req.body);
    if (body === null) {
      // deliberately reset: the backup of that camera goes too
      const camId = live.get(req.params.id)?.status?.cameras.find((c) => c.index === camera)?.id;
      if (camId) await query('UPDATE boards SET calibration_backup = calibration_backup - $2 WHERE id = $1', [req.params.id, camId]);
    }
    if (!sendToBoard(req.params.id, { type: 'set_calibration', camera, calibration: body })) {
      throw new HttpError(409, 'Board ist offline');
    }
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>('/api/boards/:id/settings', async (req) => {
    await requireOwner(req.params.id, userId(req));
    const body = parse(settingsBody, req.body);
    if (!sendToBoard(req.params.id, { type: 'set_settings', settings: body })) throw new HttpError(409, 'Board ist offline');
    return { ok: true };
  });
}

/** Remove unclaimed boards that have not been seen for 30 days. */
export async function cleanupBoards(): Promise<void> {
  await query(`DELETE FROM boards WHERE owner_id IS NULL AND (last_seen IS NULL OR last_seen < now() - interval '30 days')`);
}
