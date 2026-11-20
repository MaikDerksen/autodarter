import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BoardSummary, DetectedDart, MatchState, MatchStatus, ServerToClient } from '@shared';
import { getApiBase, wsUrl } from './api';

type Listener = (msg: ServerToClient) => void;
export type LiveStatus = 'offline' | 'connecting' | 'online';

interface BoardSub {
  count: number;
  /** number of subscribers that want the raw camera images */
  raw: number;
  /** camera index -> number of subscribers that want its frontal view */
  front: Map<number, number>;
}

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
  private boards = new Map<string, BoardSub>();
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
      for (const id of this.boards.keys()) this.sendBoard(id);
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

  private sendBoard(id: string) {
    const b = this.boards.get(id);
    if (!b) return;
    const front = [...b.front.entries()].filter(([, n]) => n > 0).map(([cam]) => cam);
    this.send({ type: 'subscribe_board', boardId: id, stream: b.raw > 0, front });
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

  /**
   * Subscribe to a board's status. raw: also its camera images; front: the frontal (rectified)
   * view of this camera index.
   */
  subscribeBoard(id: string, opts: { raw?: boolean; front?: number | null } = {}) {
    const b = this.boards.get(id) ?? { count: 0, raw: 0, front: new Map() };
    b.count++;
    if (opts.raw) b.raw++;
    if (opts.front != null) b.front.set(opts.front, (b.front.get(opts.front) ?? 0) + 1);
    this.boards.set(id, b);
    this.sendBoard(id);
    return () => {
      const cur = this.boards.get(id);
      if (!cur) return;
      cur.count--;
      if (opts.raw) cur.raw--;
      if (opts.front != null) cur.front.set(opts.front, (cur.front.get(opts.front) ?? 1) - 1);
      if (cur.count <= 0) {
        this.boards.delete(id);
        this.send({ type: 'unsubscribe_board', boardId: id });
      } else {
        this.sendBoard(id);
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
  // always call the latest handler without re-subscribing
  useLayoutEffect(() => {
    ref.current = handler;
  });
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

/**
 * Live data of a board. stream: raw camera images (board page / calibration),
 * front: camera index whose frontal view is shown (match page).
 */
export function useBoardLive(boardId: string | null | undefined, opts: { stream?: boolean; front?: number | null } = {}) {
  const [board, setBoard] = useState<BoardSummary | null>(null);
  const [frames, setFrames] = useState<Record<number, Frame>>({});
  const [frontFrames, setFrontFrames] = useState<Record<number, Frame>>({});
  const [lastDart, setLastDart] = useState<DetectedDart | null>(null);
  const [lastEvent, setLastEvent] = useState<{ event: string; at: number } | null>(null);
  const stream = !!opts.stream;
  const front = opts.front ?? null;

  useLiveMessages((msg) => {
    if (!boardId) return;
    if (msg.type === 'board_status' && msg.board.id === boardId) setBoard(msg.board);
    else if (msg.type === 'board_frame' && msg.boardId === boardId) {
      const frame = { uri: `data:image/jpeg;base64,${msg.data}`, width: msg.width, height: msg.height, at: Date.now() };
      if (msg.view === 'front') setFrontFrames((f) => ({ ...f, [msg.camera]: frame }));
      else setFrames((f) => ({ ...f, [msg.camera]: frame }));
    } else if (msg.type === 'board_dart' && msg.boardId === boardId) setLastDart(msg.dart);
    else if (msg.type === 'board_dart_out' && msg.boardId === boardId) setLastDart((d) => (d && d.id === msg.id ? { ...d, out: 'fall' } : d));
    else if (msg.type === 'board_event' && msg.boardId === boardId) setLastEvent({ event: msg.event, at: Date.now() });
  });

  useEffect(() => {
    if (!boardId) return;
    return live.subscribeBoard(boardId, { raw: stream, front });
  }, [boardId, stream, front]);

  return { board, frames, frontFrames, lastDart, lastEvent };
}
