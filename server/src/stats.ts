import type { FastifyInstance } from 'fastify';
import { computeMatch, describeSettings, mergeStats, type MatchEvent, type MatchSettings, type PlayerInfo, type PlayerStats } from '@shared/match';
import { query } from './db';
import { authenticate, userId } from './http';

interface Row {
  id: string;
  settings: MatchSettings;
  players: PlayerInfo[];
  events: MatchEvent[];
  winner: number | null;
  finished_at: Date;
  player_index: number;
}

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  app.get('/api/stats/me', async (req) => {
    const rows = await query<Row>(
      `SELECT m.id, m.settings, m.players, m.events, m.winner, m.finished_at, mp.player_index
       FROM matches m JOIN match_players mp ON mp.match_id = m.id
       WHERE mp.user_id = $1 AND m.status = 'finished'
       ORDER BY m.finished_at DESC LIMIT 1000`,
      [userId(req)],
    );
    const x01: PlayerStats[] = [];
    const cricket: PlayerStats[] = [];
    const recent: {
      id: string;
      title: string;
      mode: 'x01' | 'cricket';
      won: boolean;
      opponents: string[];
      average: number;
      mpr: number;
      finishedAt: string;
    }[] = [];
    let wins = 0;
    for (const r of rows) {
      const state = computeMatch(r.settings, r.players, r.events);
      const s = state.stats[r.player_index];
      if (!s) continue;
      (r.settings.mode === 'x01' ? x01 : cricket).push(s);
      const won = r.winner === r.player_index;
      if (won) wins++;
      if (recent.length < 30) {
        recent.push({
          id: r.id,
          title: describeSettings(r.settings),
          mode: r.settings.mode,
          won,
          opponents: r.players.filter((_, i) => i !== r.player_index).map((p) => p.name),
          average: s.average,
          mpr: s.mpr,
          finishedAt: r.finished_at.toISOString(),
        });
      }
    }
    return {
      matches: rows.length,
      wins,
      x01: { matches: x01.length, ...mergeStats(x01) },
      cricket: { matches: cricket.length, ...mergeStats(cricket) },
      recent,
    };
  });
}
