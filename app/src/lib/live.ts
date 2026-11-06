import { useEffect, useRef, useState } from 'react';
import type { BoardSummary, DetectedDart, MatchState, MatchStatus, ServerToClient } from '@shared';
import { getApiBase, wsUrl } from './api';

type Listener = (msg: ServerToClient) => void;
export type LiveStatus = 'offline' | 'connecting' | 'online';

/**
 * One shared WebSocket to the server with ref-counted subscriptions that are
 * re-sent after every reconnect.
 */
class LiveConnection {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private base = '';
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(s: LiveStatus) => void>();
  private matches = new Map<string, number>();
  private boards = new Map<string, { count: number; streams: number }>();
  status: LiveStatus = 'offline';

  configure(token: string | null) {
    const base = getApiBase();
    if (token === this.token && base === this.base && this.ws) return;
    this.token = token;
    this.base = base;
    this.close();
    if (token) this.open();
  }

  private setStatus(s: LiveStatus) {
    this.status = s;
    this.statusListeners.forEach((l) => l(s));
  }

  private close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.setStatus('offline');
  }

  private open() {
    if (!this.token) return;
    this.setStatus('connecting');
    const ws = new WebSocket(wsUrl(`/ws?token=${encodeURIComponent(this.token)}`));
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('online');
      for (const id of this.matches.keys()) this.send({ type: 'subscribe_match', matchId: id });
      for (const [id, b] of this.boards) this.send({ type: 'subscribe_board', boardId: id, stream: b.streams > 0 });
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as ServerToClient;
        this.listeners.forEach((l) => l(msg));
      } catch {
        // ignore malformed
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.setStatus('offline');
      const delay = Math.min(1000 * 2 ** this.retry++, 10000);
      this.timer = setTimeout(() => this.open(), delay);
    };
    ws.onerror = () => ws.close();
  }

  private send(msg: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  addListener(l: Listener) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  addStatusListener(l: (s: LiveStatus) => void) {
    this.statusListeners.add(l);
    return () => void this.statusListeners.delete(l);
  }

  subscribeMatch(id: string) {
    const n = (this.matches.get(id) ?? 0) + 1;
    this.matches.set(id, n);
    if (n === 1) this.send({ type: 'subscribe_match', matchId: id });
    return () => {
      const left = (this.matches.get(id) ?? 1) - 1;
      if (left <= 0) {
        this.matches.delete(id);
        this.send({ type: 'unsubscribe_match', matchId: id });
      } else this.matches.set(id, left);
    };
  }

  subscribeBoard(id: string, stream: boolean) {
    const b = this.boards.get(id) ?? { count: 0, streams: 0 };
    const hadStream = b.streams > 0;
    b.count++;
    if (stream) b.streams++;
    this.boards.set(id, b);
    if (b.count === 1 || (stream && !hadStream)) this.send({ type: 'subscribe_board', boardId: id, stream: b.streams > 0 });
    return () => {
      const cur = this.boards.get(id);
      if (!cur) return;
      cur.count--;
      if (stream) cur.streams--;
      if (cur.count <= 0) {
        this.boards.delete(id);
        this.send({ type: 'unsubscribe_board', boardId: id });
      } else if (stream && cur.streams === 0) {
        this.send({ type: 'subscribe_board', boardId: id, stream: false });
      }
    };
  }
}

export const live = new LiveConnection();

export function useLiveStatus(): LiveStatus {
  const [s, setS] = useState<LiveStatus>(live.status);
  useEffect(() => live.addStatusListener(setS), []);
  return s;
}

export function useLiveMessages(handler: Listener) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => live.addListener((m) => ref.current(m)), []);
}

export interface LiveMatch {
  state: MatchState;
  status: MatchStatus;
  boardId: string | null;
}

export function useMatchLive(matchId: string | undefined, onUpdate: (m: LiveMatch) => void) {
  useLiveMessages((msg) => {
    if (msg.type === 'match_state' && msg.matchId === matchId) {
      onUpdate({ state: msg.state, status: msg.status, boardId: msg.boardId });
    }
  });
  useEffect(() => (matchId ? live.subscribeMatch(matchId) : undefined), [matchId]);
}

export interface Frame {
  uri: string;
  width: number;
  height: number;
  at: number;
}

export function useBoardLive(boardId: string | null | undefined, opts: { stream?: boolean } = {}) {
  const [board, setBoard] = useState<BoardSummary | null>(null);
  const [frames, setFrames] = useState<Record<number, Frame>>({});
  const [lastDart, setLastDart] = useState<DetectedDart | null>(null);
  const [lastEvent, setLastEvent] = useState<{ event: string; at: number } | null>(null);
  const stream = !!opts.stream;

  useLiveMessages((msg) => {
    if (!boardId) return;
    if (msg.type === 'board_status' && msg.board.id === boardId) setBoard(msg.board);
    else if (msg.type === 'board_frame' && msg.boardId === boardId) {
      setFrames((f) => ({
        ...f,
        [msg.camera]: { uri: `data:image/jpeg;base64,${msg.data}`, width: msg.width, height: msg.height, at: Date.now() },
      }));
    } else if (msg.type === 'board_dart' && msg.boardId === boardId) setLastDart(msg.dart);
    else if (msg.type === 'board_event' && msg.boardId === boardId) setLastEvent({ event: msg.event, at: Date.now() });
  });

  useEffect(() => {
    if (!boardId) return;
    return live.subscribeBoard(boardId, stream);
  }, [boardId, stream]);

  return { board, frames, lastDart, lastEvent };
}
