import type { BoardState, BoardSummary } from '@shared';
import { colors } from './theme';

export const BOARD_STATE_LABEL: Record<BoardState, string> = {
  stopped: 'Gestoppt',
  starting: 'Startet …',
  throw: 'Werfen',
  takeout: 'Darts ziehen',
  takeout_in_progress: 'Takeout läuft',
  calibration_needed: 'Kalibrierung nötig',
  error: 'Fehler',
};

export function boardBadge(board: BoardSummary | null | undefined): { label: string; color: string } {
  if (!board) return { label: 'Unbekannt', color: colors.faint };
  if (!board.online) return { label: 'Offline', color: colors.faint };
  const s = board.status?.state ?? 'starting';
  const color =
    s === 'throw'
      ? colors.accent
      : s === 'takeout' || s === 'takeout_in_progress'
        ? colors.warning
        : s === 'error' || s === 'calibration_needed'
          ? colors.danger
          : colors.info;
  return { label: BOARD_STATE_LABEL[s] ?? s, color };
}
