/**
 * Wire protocol between board client (Raspberry Pi), server and web/app clients.
 * The Python board client mirrors these shapes in board/autodarter_board/protocol.py.
 */
import type { Point, Segment } from './board';
import type { DartOut, MatchSettings, MatchState, PlayerInfo } from './match';
import type { MatchVoice, VoiceMode } from './voice';

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
  /**
   * mirrored: calibration points swapped (the camera is ignored until it is recalibrated);
   * inconsistent: its darts often disagree with the other cameras (calibration probably off).
   */
  issue?: CameraIssue | null;
}

export type CameraIssue = 'mirrored' | 'inconsistent';

/** Calibration points in normalised image coordinates (0..1), ordered like CALIBRATION_POINTS. */
export interface CameraCalibration {
  points: Point[];
  /** Stable id of the camera (USB port) the calibration belongs to. */
  camId?: string;
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
  /** 1 = a dart that hits the board and drops right away is reported as a bounce-out (MISS). */
  bounceOut?: number;
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
  /**
   * What the board client may do on request: reboot needs ALLOW_REBOOT + host D-Bus on the Pi,
   * update needs the auto-update container (profile "autoupdate") next to the board client.
   */
  capabilities?: { restart: boolean; reboot: boolean; update?: boolean; autoCalibrate?: boolean };
}

export type BoardCommand = 'start' | 'stop' | 'reset' | 'rescan' | 'restart' | 'reboot' | 'update';

/**
 * Camera stream views: "raw" = what the camera sees, "front" = the calibrated camera image
 * warped to a frontal view of the board (same mm coordinates as the virtual board, ±BOARD_VIEW).
 */
export type StreamView = 'raw' | 'front';
/** Half width of the frontal view in mm (matches the viewBox of the virtual dartboard). */
export const BOARD_VIEW = 232;

export interface DetectedDart {
  id: string;
  /** board position in mm (missing for a bounce-out) */
  x?: number;
  y?: number;
  seg: Segment;
  confidence: number;
  /** Indices of the cameras that contributed. */
  cameras: number[];
  /** Per-camera tip positions in normalised image coordinates (for debugging overlays). */
  tips?: Record<number, Point>;
  out?: DartOut;
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
  /** a dart of the current turn fell out of the board (id of its dart message) */
  | { type: 'dart_out'; id: string }
  | { type: 'takeout_started' }
  | { type: 'takeout_finished' }
  | { type: 'frame'; camera: number; data: string; width: number; height: number; view?: StreamView }
  | { type: 'snapshot'; requestId: string; camera: number; data: string | null; width: number; height: number }
  | { type: 'auto_calibration'; requestId: string; camera: number; result: AutoCalibration }
  | { type: 'calibration'; calibration: Record<string, CameraCalibration | null> }
  | { type: 'settings'; settings: BoardSettings }
  /** bug report: one image (base64) per message, then report_done with the detector data */
  | { type: 'report_file'; requestId: string; name: string; mime: string; data: string }
  | { type: 'report_done'; requestId: string; info: Record<string, unknown> | null; error?: string }
  | { type: 'pong' };

/** Result of the automatic calibration of one camera (proposal - saved only when the user confirms). */
export interface AutoCalibration {
  ok: boolean;
  /** 5 normalised points like a manual calibration (also a best guess when ok is false) */
  points: Point[] | null;
  /** fit quality 0..1 */
  score: number;
  mode: 'refine' | 'full';
  /** the board was found but not where the 20 is - the user has to tap on it */
  needsHint: boolean;
  message: string;
}

// ---------------------------------------------------------------- server -> board
export type ServerToBoard =
  | {
      type: 'welcome';
      claimed: boolean;
      pairingCode: string | null;
      name: string | null;
      /** Last known calibration per camera id – the board restores it if it lost its own. */
      calibrationBackup?: Record<string, CameraCalibration>;
    }
  /** raw: send camera images; front: cameras (indices) to send as frontal view. */
  | { type: 'stream'; enabled: boolean; fps: number; maxWidth: number; raw: boolean; front: number[] }
  | { type: 'snapshot_request'; requestId: string; camera: number }
  /** find the board in the camera image; prior = rough/old points, hint20 = tap on the 20 */
  | { type: 'auto_calibrate'; requestId: string; camera: number; prior?: Point[] | null; hint20?: Point | null }
  | { type: 'set_calibration'; camera: number; calibration: CameraCalibration | null }
  | { type: 'command'; action: BoardCommand }
  | { type: 'set_settings'; settings: Partial<BoardSettings> }
  /** bug report: camera images of these detections (board dart ids) and of the last `discarded` changes that were no dart */
  | { type: 'report_request'; requestId: string; darts: string[]; discarded: number }
  | { type: 'ping' }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------- client <-> server
export type ClientToServer =
  | { type: 'subscribe_match'; matchId: string }
  | { type: 'unsubscribe_match'; matchId: string }
  /** stream: raw camera images, front: camera indices wanted as frontal view. */
  | { type: 'subscribe_board'; boardId: string; stream?: boolean; front?: number[] }
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
  /** Voice pack of the player who created the match (null = standard voice). */
  voice?: MatchVoice | null;
  voiceMode?: VoiceMode;
  /** Voice per player (index = player), resolved by the server. Missing = use `voice`. */
  voices?: (MatchVoice | null)[];
}

/** A running match of a friend (shown as a suggestion, you can watch or join). */
export interface FriendMatch {
  match: MatchSummary;
  ownerName: string;
  boardName: string | null;
  /** players can still join (first round of the first leg) */
  joinable: boolean;
  /** why joining is not possible any more */
  joinBlocked: string | null;
  round: number;
  lastActivity: string;
}

/** The running match that currently occupies a board. */
export interface BoardActiveMatch {
  id: string;
  ownerId: string;
  ownerName: string;
  title: string;
  players: string[];
  /** Last thrown dart (or start of the match), ISO date. */
  lastActivity: string;
}

/** guest = player of a remote match who may watch that board while the match runs. */
export type BoardRole = 'owner' | 'member' | 'guest';

export interface BoardMember {
  userId: string;
  username: string;
  displayName: string;
  role: BoardRole;
  online: boolean;
}

export interface BoardSummary {
  id: string;
  name: string;
  online: boolean;
  status: BoardStatus | null;
  calibration: Record<string, CameraCalibration | null>;
  settings: BoardSettings | null;
  activeMatchId: string | null;
  activeMatch: BoardActiveMatch | null;
  lastSeen: string | null;
  /** Role of the requesting user (boards can be shared: n users <-> m boards). */
  role: BoardRole;
  /** Code with which further players add the board to their account (rotates after every use). */
  pairingCode: string | null;
  memberCount: number;
}

/** A user as seen by a friend. */
export interface FriendUser {
  id: string;
  username: string;
  displayName: string;
  online: boolean;
  /** Running match the friend is playing in (if any). */
  playing: { matchId: string; title: string } | null;
}

export interface FriendsOverview {
  friends: FriendUser[];
  /** Friend requests to me. */
  incoming: FriendUser[];
  /** My open friend requests. */
  outgoing: FriendUser[];
}

// ---------------------------------------------------------------- bug reports

/** wrong: wrong segment, phantom: a dart nobody threw, missed: a thrown dart was not detected, other: anything else */
export type BugReportKind = 'wrong' | 'phantom' | 'missed' | 'other';
export type BugReportStatus = 'open' | 'done';

export interface BugReportSummary {
  id: string;
  createdAt: string;
  kind: BugReportKind;
  status: BugReportStatus;
  /** what the board detected (null: nothing / entered by hand) */
  detected: Segment | null;
  /** what it really was (null: no dart at all) */
  actual: Segment | null;
  note: string;
  reporter: string | null;
  boardName: string | null;
  matchId: string | null;
  images: number;
  /** the board did not deliver (all) images */
  boardError: string | null;
}

export interface BugReportFile {
  name: string;
  mime: string;
  size: number;
}

export interface BugReportDetail extends BugReportSummary {
  /** match, turn, board and detector data */
  details: Record<string, unknown>;
  files: BugReportFile[];
  /** short-lived token for the image and download links (?t=…) */
  fileToken: string;
}

export type ServerToClient =
  | { type: 'match_state'; matchId: string; status: MatchStatus; boardId: string | null; state: MatchState }
  | { type: 'board_status'; board: BoardSummary }
  | { type: 'board_frame'; boardId: string; camera: number; data: string; width: number; height: number; view: StreamView }
  | { type: 'board_dart'; boardId: string; dart: DetectedDart }
  | { type: 'board_dart_out'; boardId: string; id: string }
  | { type: 'board_event'; boardId: string; event: 'takeout_started' | 'takeout_finished' }
  /** A friend came online / went offline. */
  | { type: 'presence'; userId: string; online: boolean }
  /** Friend requests or friendships changed – reload the friends list. */
  | { type: 'friends_changed' }
  /** Somebody added me as a player to a new match. */
  | { type: 'match_invite'; match: MatchSummary; from: { id: string; displayName: string } }
  /** somebody joined one of my matches */
  | { type: 'match_joined'; matchId: string; title: string; user: { id: string; displayName: string } }
  /** a friend started, joined or ended a match – reload the suggestions */
  | { type: 'friend_matches' }
  | { type: 'pong' }
  | { type: 'error'; message: string };
