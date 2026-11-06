import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { ClientToServer } from '@shared/protocol';
import { canAccessBoard, currentBoardSummary, refreshStream } from './boards';
import { type ClientConn, dropClient, send, subscribeBoard, subscribeMatch, unsubscribeBoard, unsubscribeMatch } from './hub';
import { canAccessMatch, matchSnapshot } from './matches';

/** WebSocket handler for logged-in web/app clients. Token is passed as ?token=… */
export function handleClientSocket(app: FastifyInstance, socket: WebSocket, token: string | undefined): void {
  let user: { sub: string };
  try {
    user = app.jwt.verify<{ sub: string; username: string }>(token ?? '');
  } catch {
    socket.close(4401, 'unauthorized');
    return;
  }
  const client: ClientConn = { socket, userId: user.sub, matches: new Set(), boards: new Set(), streams: new Set() };

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
          if (!(await canAccessMatch(msg.matchId, client.userId))) {
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
          if (!(await canAccessBoard(msg.boardId, client.userId))) {
            send(client, { type: 'error', message: 'Board nicht gefunden' });
            break;
          }
          subscribeBoard(client, msg.boardId);
          if (msg.stream) client.streams.add(msg.boardId);
          else client.streams.delete(msg.boardId);
          refreshStream(msg.boardId);
          const board = await currentBoardSummary(msg.boardId);
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
