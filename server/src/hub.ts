import type { WebSocket } from 'ws';
import type { ServerToClient } from '@shared/protocol';

/** A connected web/app client. */
export interface ClientConn {
  socket: WebSocket;
  userId: string;
  matches: Set<string>;
  boards: Set<string>;
  streams: Set<string>;
}

const matchSubs = new Map<string, Set<ClientConn>>();
const boardSubs = new Map<string, Set<ClientConn>>();

const MAX_BUFFERED = 4 * 1024 * 1024;

export function send(client: ClientConn, msg: ServerToClient, droppable = false): void {
  if (client.socket.readyState !== client.socket.OPEN) return;
  if (droppable && client.socket.bufferedAmount > MAX_BUFFERED) return;
  client.socket.send(JSON.stringify(msg));
}

function add(map: Map<string, Set<ClientConn>>, key: string, c: ClientConn) {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(c);
}

function remove(map: Map<string, Set<ClientConn>>, key: string, c: ClientConn) {
  const set = map.get(key);
  if (!set) return;
  set.delete(c);
  if (set.size === 0) map.delete(key);
}

export function subscribeMatch(c: ClientConn, matchId: string) {
  c.matches.add(matchId);
  add(matchSubs, matchId, c);
}

export function unsubscribeMatch(c: ClientConn, matchId: string) {
  c.matches.delete(matchId);
  remove(matchSubs, matchId, c);
}

export function subscribeBoard(c: ClientConn, boardId: string) {
  c.boards.add(boardId);
  add(boardSubs, boardId, c);
}

export function unsubscribeBoard(c: ClientConn, boardId: string) {
  c.boards.delete(boardId);
  c.streams.delete(boardId);
  remove(boardSubs, boardId, c);
}

export function dropClient(c: ClientConn) {
  for (const m of [...c.matches]) unsubscribeMatch(c, m);
  for (const b of [...c.boards]) unsubscribeBoard(c, b);
}

export function publishMatch(matchId: string, msg: ServerToClient) {
  for (const c of matchSubs.get(matchId) ?? []) send(c, msg);
}

export function publishBoard(boardId: string, msg: ServerToClient, onlyStreams = false) {
  for (const c of boardSubs.get(boardId) ?? []) {
    if (onlyStreams && !c.streams.has(boardId)) continue;
    send(c, msg, onlyStreams);
  }
}

export function streamViewerCount(boardId: string): number {
  let n = 0;
  for (const c of boardSubs.get(boardId) ?? []) if (c.streams.has(boardId)) n++;
  return n;
}
