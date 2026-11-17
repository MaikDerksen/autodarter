import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import type { BoardRole, ServerToClient, StreamView } from '@shared/protocol';

export interface StreamWish {
  raw: boolean;
  /** Camera indices wanted as frontal view. */
  front: number[];
}

/** A connected web/app client. */
export interface ClientConn {
  socket: WebSocket;
  userId: string;
  matches: Set<string>;
  boards: Set<string>;
  /** Board role of the user per subscribed board. */
  boardRoles: Map<string, BoardRole>;
  streams: Map<string, StreamWish>;
}

const matchSubs = new Map<string, Set<ClientConn>>();
const boardSubs = new Map<string, Set<ClientConn>>();
const byUser = new Map<string, Set<ClientConn>>();

/** Emits 'change' (userId, online) when a user gets their first / loses their last connection. */
export const presenceEvents = new EventEmitter();

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

export function addClient(c: ClientConn) {
  const first = !byUser.has(c.userId);
  add(byUser, c.userId, c);
  if (first) presenceEvents.emit('change', c.userId, true);
}

export function dropClient(c: ClientConn) {
  for (const m of [...c.matches]) unsubscribeMatch(c, m);
  for (const b of [...c.boards]) unsubscribeBoard(c, b);
  remove(byUser, c.userId, c);
  if (!byUser.has(c.userId)) presenceEvents.emit('change', c.userId, false);
}

export function isUserOnline(userId: string): boolean {
  return byUser.has(userId);
}

export function sendToUser(userId: string, msg: ServerToClient) {
  for (const c of byUser.get(userId) ?? []) send(c, msg);
}

export function subscribeMatch(c: ClientConn, matchId: string) {
  c.matches.add(matchId);
  add(matchSubs, matchId, c);
}

export function unsubscribeMatch(c: ClientConn, matchId: string) {
  c.matches.delete(matchId);
  remove(matchSubs, matchId, c);
}

export function subscribeBoard(c: ClientConn, boardId: string, role: BoardRole, wish: StreamWish) {
  c.boards.add(boardId);
  c.boardRoles.set(boardId, role);
  if (wish.raw || wish.front.length) c.streams.set(boardId, wish);
  else c.streams.delete(boardId);
  add(boardSubs, boardId, c);
}

export function unsubscribeBoard(c: ClientConn, boardId: string) {
  c.boards.delete(boardId);
  c.boardRoles.delete(boardId);
  c.streams.delete(boardId);
  remove(boardSubs, boardId, c);
}

/** Drop the board subscriptions of a user (e.g. after leaving / being removed from a board). */
export function revokeBoard(userId: string, boardId: string) {
  for (const c of byUser.get(userId) ?? []) unsubscribeBoard(c, boardId);
}

export function publishMatch(matchId: string, msg: ServerToClient) {
  for (const c of matchSubs.get(matchId) ?? []) send(c, msg);
}

/** Send to all subscribers of a board; msg may depend on the subscriber (e.g. its role). */
export function publishBoard(boardId: string, msg: ServerToClient | ((c: ClientConn) => ServerToClient)) {
  for (const c of boardSubs.get(boardId) ?? []) send(c, typeof msg === 'function' ? msg(c) : msg);
}

/** Camera frames only go to clients that watch this view of this camera (droppable on slow links). */
export function publishFrame(boardId: string, view: StreamView, camera: number, msg: ServerToClient) {
  for (const c of boardSubs.get(boardId) ?? []) {
    const w = c.streams.get(boardId);
    if (!w) continue;
    if (view === 'raw' ? !w.raw : !w.front.includes(camera)) continue;
    send(c, msg, true);
  }
}

/** Union of what all viewers of a board want to see. */
export function streamDemand(boardId: string): StreamWish {
  let raw = false;
  const front = new Set<number>();
  for (const c of boardSubs.get(boardId) ?? []) {
    const w = c.streams.get(boardId);
    if (!w) continue;
    raw ||= w.raw;
    w.front.forEach((i) => front.add(i));
  }
  return { raw, front: [...front].sort((a, b) => a - b) };
}
