import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { CALIBRATION_POINTS } from '@shared/board';
import type {
  BoardSettings,
  BoardStatus,
  BoardSummary,
  BoardToServer,
  CameraCalibration,
  DetectedDart,
  ServerToBoard,
} from '@shared/protocol';
import { query } from './db';
import { HttpError, authenticate, parse, userId } from './http';
import { publishBoard, streamViewerCount } from './hub';

interface BoardRow {
  id: string;
  owner_id: string | null;
  name: string;
  secret_hash: string;
  pairing_code: string | null;
  calibration: Record<string, CameraCalibration | null>;
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
  streaming: boolean;
  pending: Map<string, (msg: Extract<BoardToServer, { type: 'snapshot' }>) => void>;
}

const live = new Map<string, LiveBoard>();

/** Emits 'dart' (boardId, dart), 'takeout_started' (boardId), 'takeout_finished' (boardId). */
export const boardEvents = new EventEmitter();

/** Resolves the active match of a board (set by the match module to avoid an import cycle). */
let activeMatchLookup: (boardId: string) => string | null = () => null;
export function setActiveMatchLookup(fn: (boardId: string) => string | null) {
  activeMatchLookup = fn;
}

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function pairingCode(): string {
  const bytes = randomBytes(6);
  return Array.from(bytes, (b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join('');
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function summary(row: BoardRow): BoardSummary {
  const l = live.get(row.id);
  return {
    id: row.id,
    name: row.name,
    online: !!l,
    status: l?.status ?? null,
    calibration: l?.calibration ?? row.calibration ?? {},
    settings: l?.settings ?? row.settings ?? null,
    activeMatchId: activeMatchLookup(row.id),
    lastSeen: row.last_seen ? row.last_seen.toISOString() : null,
  };
}

async function getRow(id: string): Promise<BoardRow | null> {
  const [row] = await query<BoardRow>('SELECT * FROM boards WHERE id = $1', [id]);
  return row ?? null;
}

export async function getOwnedBoard(id: string, owner: string): Promise<BoardRow> {
  const row = await getRow(id);
  if (!row || row.owner_id !== owner) throw new HttpError(404, 'Board nicht gefunden');
  return row;
}

export async function canAccessBoard(id: string, owner: string): Promise<boolean> {
  const row = await getRow(id);
  return !!row && row.owner_id === owner;
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
  if (row) publishBoard(id, { type: 'board_status', board: summary(row) });
}

export async function currentBoardSummary(id: string): Promise<BoardSummary | null> {
  const row = await getRow(id);
  return row ? summary(row) : null;
}

/** Turn the camera stream of a board on/off depending on the number of viewers. */
export function refreshStream(id: string): void {
  const l = live.get(id);
  if (!l) return;
  const want = streamViewerCount(id) > 0;
  if (want !== l.streaming) {
    l.streaming = want;
    sendToBoard(id, { type: 'stream', enabled: want, fps: 4, maxWidth: 640 });
  }
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

  socket.on('message', async (raw) => {
    alive = true;
    let msg: BoardToServer;
    try {
      msg = JSON.parse(raw.toString());
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
    if (!row.owner_id && !row.pairing_code) {
      [row] = await query<BoardRow>('UPDATE boards SET pairing_code = $2 WHERE id = $1 RETURNING *', [row.id, pairingCode()]);
    }
    [row] = await query<BoardRow>(
      'UPDATE boards SET calibration = $2, settings = $3, last_seen = now() WHERE id = $1 RETURNING *',
      [row.id, JSON.stringify(msg.calibration ?? {}), JSON.stringify(msg.settings ?? null)],
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
    streaming: false,
    pending: new Map(),
  };
  live.set(row.id, board);
  log.info({ board: row.id, claimed: !!row.owner_id }, 'board connected');
  sendToBoard(row.id, { type: 'welcome', claimed: !!row.owner_id, pairingCode: row.owner_id ? null : row.pairing_code, name: row.name });
  refreshStream(row.id);
  publishBoard(row.id, { type: 'board_status', board: summary(row) });
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
      await query('UPDATE boards SET calibration = $2 WHERE id = $1', [board.id, JSON.stringify(board.calibration)]);
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
    case 'frame':
      publishBoard(
        board.id,
        { type: 'board_frame', boardId: board.id, camera: msg.camera, data: msg.data, width: msg.width, height: msg.height },
        true,
      );
      break;
    case 'snapshot':
      board.pending.get(msg.requestId)?.(msg);
      break;
    case 'pong':
      break;
  }
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

export async function boardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  app.get('/api/boards', async (req) => {
    const rows = await query<BoardRow>('SELECT * FROM boards WHERE owner_id = $1 ORDER BY created_at', [userId(req)]);
    return rows.map(summary);
  });

  app.get<{ Params: { id: string } }>('/api/boards/:id', async (req) => {
    return summary(await getOwnedBoard(req.params.id, userId(req)));
  });

  app.post('/api/boards/claim', async (req) => {
    const body = parse(
      z.object({
        code: z.string().trim().toUpperCase().min(4).max(12),
        name: z.string().trim().min(1).max(40).optional(),
      }),
      req.body,
    );
    const code = body.code.replace(/[^A-Z0-9]/g, '');
    const [row] = await query<BoardRow>(
      `UPDATE boards SET owner_id = $2, pairing_code = NULL, name = COALESCE($3, name)
       WHERE pairing_code = $1 AND owner_id IS NULL RETURNING *`,
      [code, userId(req), body.name ?? null],
    );
    if (!row) throw new HttpError(404, 'Kein Board mit diesem Code gefunden. Ist der Pi online?');
    const l = live.get(row.id);
    if (l) {
      l.ownerId = row.owner_id;
      l.name = row.name;
    }
    sendToBoard(row.id, { type: 'welcome', claimed: true, pairingCode: null, name: row.name });
    return summary(row);
  });

  app.patch<{ Params: { id: string } }>('/api/boards/:id', async (req) => {
    await getOwnedBoard(req.params.id, userId(req));
    const body = parse(z.object({ name: z.string().trim().min(1).max(40) }), req.body);
    const [row] = await query<BoardRow>('UPDATE boards SET name = $2 WHERE id = $1 RETURNING *', [req.params.id, body.name]);
    const l = live.get(row.id);
    if (l) l.name = row.name;
    await publishBoardStatus(row.id);
    return summary(row);
  });

  app.delete<{ Params: { id: string } }>('/api/boards/:id', async (req) => {
    await getOwnedBoard(req.params.id, userId(req));
    const code = pairingCode();
    await query('UPDATE boards SET owner_id = NULL, pairing_code = $2 WHERE id = $1', [req.params.id, code]);
    const l = live.get(req.params.id);
    if (l) l.ownerId = null;
    sendToBoard(req.params.id, { type: 'welcome', claimed: false, pairingCode: code, name: null });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/boards/:id/command', async (req) => {
    await getOwnedBoard(req.params.id, userId(req));
    const body = parse(z.object({ action: z.enum(['start', 'stop', 'reset', 'rescan']) }), req.body);
    if (!sendToBoard(req.params.id, { type: 'command', action: body.action })) throw new HttpError(409, 'Board ist offline');
    return { ok: true };
  });

  app.get<{ Params: { id: string; cam: string } }>('/api/boards/:id/cameras/:cam/snapshot', async (req) => {
    await getOwnedBoard(req.params.id, userId(req));
    const snap = await requestSnapshot(req.params.id, Number(req.params.cam));
    if (!snap.data) throw new HttpError(404, 'Kamera liefert kein Bild');
    return { data: snap.data, width: snap.width, height: snap.height };
  });

  app.put<{ Params: { id: string; cam: string } }>('/api/boards/:id/cameras/:cam/calibration', async (req) => {
    await getOwnedBoard(req.params.id, userId(req));
    const camera = Number(req.params.cam);
    const body = req.body === null ? null : parse(calibrationBody, req.body);
    if (!sendToBoard(req.params.id, { type: 'set_calibration', camera, calibration: body })) {
      throw new HttpError(409, 'Board ist offline');
    }
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>('/api/boards/:id/settings', async (req) => {
    await getOwnedBoard(req.params.id, userId(req));
    const body = parse(settingsBody, req.body);
    if (!sendToBoard(req.params.id, { type: 'set_settings', settings: body })) throw new HttpError(409, 'Board ist offline');
    return { ok: true };
  });
}

/** Remove unclaimed boards that have not been seen for 30 days. */
export async function cleanupBoards(): Promise<void> {
  await query(`DELETE FROM boards WHERE owner_id IS NULL AND (last_seen IS NULL OR last_seen < now() - interval '30 days')`);
}
