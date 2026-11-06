/**
 * Wire protocol between board client (Raspberry Pi), server and web/app clients.
 * The Python board client mirrors these shapes in board/autodarter_board/protocol.py.
 */
import type { Point, Segment } from './board';
import type { MatchSettings, MatchState, PlayerInfo } from './match';

export type BoardState =
  | 'stopped'
  | 'starting'
  | 'throw'
  | 'takeout'
  | 'takeout_in_progress'
  | 'calibration_needed'
  | 'error';

export interface CameraInfo {
  index: number;
  /** Stable id (e.g. USB port path). */
  id: string;
  name: string;
  device: string;
  width: number;
  height: number;
  fps: number;
  ok: boolean;
  calibrated: boolean;
}

/** Calibration points in normalised image coordinates (0..1), ordered like CALIBRATION_POINTS. */
export interface CameraCalibration {
  points: Point[];
}

export interface BoardSettings {
  resolution: [number, number];
  fps: number;
  /** Pixel intensity difference that counts as change. */
  diffThreshold: number;
  /** Minimal changed area (px, at processing resolution) for a dart. */
  minDartArea: number;
  /** Changed area above which we assume a hand / takeout. */
  takeoutArea: number;
  /** Number of calm frames before a change is evaluated. */
  settleFrames: number;
}

export interface BoardStatus {
  state: BoardState;
  detecting: boolean;
  /** Darts currently in the board (since the last takeout). */
  darts: number;
  fps: number;
  cameras: CameraInfo[];
  message?: string;
  version: string;
}

export interface DetectedDart {
  id: string;
  x: number;
  y: number;
  seg: Segment;
  confidence: number;
  /** Indices of the cameras that contributed. */
  cameras: number[];
  /** Per-camera tip positions in normalised image coordinates (for debugging overlays). */
  tips?: Record<number, Point>;
}

// ---------------------------------------------------------------- board -> server
export type BoardToServer =
  | {
      type: 'hello';
      boardId: string;
      secret: string;
      version: string;
      status: BoardStatus;
      calibration: Record<string, CameraCalibration | null>;
      settings: BoardSettings;
    }
  | { type: 'status'; status: BoardStatus }
  | { type: 'dart'; dart: DetectedDart }
  | { type: 'takeout_started' }
  | { type: 'takeout_finished' }
  | { type: 'frame'; camera: number; data: string; width: number; height: number }
  | { type: 'snapshot'; requestId: string; camera: number; data: string | null; width: number; height: number }
  | { type: 'calibration'; calibration: Record<string, CameraCalibration | null> }
  | { type: 'settings'; settings: BoardSettings }
  | { type: 'pong' };

// ---------------------------------------------------------------- server -> board
export type ServerToBoard =
  | { type: 'welcome'; claimed: boolean; pairingCode: string | null; name: string | null }
  | { type: 'stream'; enabled: boolean; fps: number; maxWidth: number }
  | { type: 'snapshot_request'; requestId: string; camera: number }
  | { type: 'set_calibration'; camera: number; calibration: CameraCalibration | null }
  | { type: 'command'; action: 'start' | 'stop' | 'reset' | 'rescan' }
  | { type: 'set_settings'; settings: Partial<BoardSettings> }
  | { type: 'ping' }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------- client <-> server
export type ClientToServer =
  | { type: 'subscribe_match'; matchId: string }
  | { type: 'unsubscribe_match'; matchId: string }
  | { type: 'subscribe_board'; boardId: string; stream?: boolean }
  | { type: 'unsubscribe_board'; boardId: string }
  | { type: 'ping' };

export type MatchStatus = 'running' | 'finished' | 'aborted';

export interface MatchSummary {
  id: string;
  settings: MatchSettings;
  players: PlayerInfo[];
  boardId: string | null;
  status: MatchStatus;
  winner: number | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface BoardSummary {
  id: string;
  name: string;
  online: boolean;
  status: BoardStatus | null;
  calibration: Record<string, CameraCalibration | null>;
  settings: BoardSettings | null;
  activeMatchId: string | null;
  lastSeen: string | null;
}

export type ServerToClient =
  | { type: 'match_state'; matchId: string; status: MatchStatus; boardId: string | null; state: MatchState }
  | { type: 'board_status'; board: BoardSummary }
  | { type: 'board_frame'; boardId: string; camera: number; data: string; width: number; height: number }
  | { type: 'board_dart'; boardId: string; dart: DetectedDart }
  | { type: 'board_event'; boardId: string; event: 'takeout_started' | 'takeout_finished' }
  | { type: 'pong' }
  | { type: 'error'; message: string };
