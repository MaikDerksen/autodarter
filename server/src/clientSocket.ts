import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { ClientToServer } from '@shared/protocol';
import { canAccessBoard, currentBoardSummary, refreshStream } from './boards';
import {
  type ClientConn,
  addClient,
  dropClient,
  send,
  subscribeBoard,
  subscribeMatch,
  unsubscribeBoard,
  unsubscribeMatch,
} from './hub';
import { canViewMatch, guestCanWatchBoard, matchSnapshot } from './matches';

/** WebSocket handler for logged-in web/app clients. Token is passed as ?token=… */
export function handleClientSocket(app: FastifyInstance, socket: WebSocket, token: string | undefined): void {
  let user: { sub: string };
  try {
    user = app.jwt.verify<{ sub: string; username: string }>(token ?? '');
  } catch {
    socket.close(4401, 'unauthorized');
    return;
  }
  const client: ClientConn = {
    socket,
    userId: user.sub,
    matches: new Set(),
    boards: new Set(),
    boardRoles: new Map(),
    streams: new Map(),
  };
  addClient(client);

  let alive = true;
  const ping = setInterval(() => {
    if (!alive) return socket.terminate();
    alive = false;
    socket.ping();
  }, 25000);
  socket.on('pong', () => (alive = true));

  socket.on('message', async (raw) => {
    alive = true;
    let msg: ClientToServer;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      switch (msg.type) {
        case 'ping':
          send(client, { type: 'pong' });
          break;
        case 'subscribe_match': {
          if (!(await canViewMatch(msg.matchId, client.userId))) {
            send(client, { type: 'error', message: 'Spiel nicht gefunden' });
            break;
          }
          subscribeMatch(client, msg.matchId);
          const snap = await matchSnapshot(msg.matchId);
          if (snap) send(client, snap);
          break;
        }
        case 'unsubscribe_match':
          unsubscribeMatch(client, msg.matchId);
          break;
        case 'subscribe_board': {
          // players of a remote match may watch the other boards of that match
          const role = (await canAccessBoard(msg.boardId, client.userId)) ?? (guestCanWatchBoard(msg.boardId, client.userId) ? 'guest' : null);
          if (!role) {
            send(client, { type: 'error', message: 'Board nicht gefunden' });
            break;
          }
          const front = Array.isArray(msg.front) ? msg.front.filter((i) => Number.isInteger(i) && i >= 0 && i < 16).slice(0, 4) : [];
          subscribeBoard(client, msg.boardId, role, { raw: !!msg.stream, front });
          refreshStream(msg.boardId);
          const board = await currentBoardSummary(msg.boardId, role);
          if (board) send(client, { type: 'board_status', board });
          break;
        }
        case 'unsubscribe_board':
          unsubscribeBoard(client, msg.boardId);
          refreshStream(msg.boardId);
          break;
      }
    } catch (err) {
      app.log.error({ err }, 'client message failed');
    }
  });

  socket.on('close', () => {
    clearInterval(ping);
    const boards = [...client.boards];
    dropClient(client);
    for (const b of boards) refreshStream(b);
  });
}
