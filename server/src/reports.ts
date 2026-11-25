/**
 * Bug reports ("Fehler melden"): a player marks a dart that was detected wrong (or not at all, or
 * without being thrown) and says what it really was. The board sends the camera images of that
 * detection - lossless, so it can be replayed - and everything is stored for the analysis.
 *
 * Reading reports is for admins only (ADMIN_USERS, otherwise the first account). Images and
 * downloads use short-lived links that are signed for one report (an <img> cannot send the login).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DartEvent } from '@shared/match';
import type { BugReportDetail, BugReportStatus } from '@shared/protocol';
import { isAdmin } from './admin';
import { currentBoardSummary, requestBoardReport } from './boards';
import { config } from './config';
import { pool, query } from './db';
import { HttpError, authenticate, parse, userId } from './http';
import { matchForReport, segmentSchema } from './matches';
import { UUID, getReport, listReports, reportBundle, reportFile, reportFiles, reportFolder } from './reportStore';

// ------------------------------------------------------------------ signed links

const LINK_TTL_MS = 60 * 60 * 1000;
const linkKey = createHmac('sha256', config.jwtSecret).update('autodarter bug report links').digest();

function signLink(scope: string, exp: number): Buffer {
  return createHmac('sha256', linkKey).update(`${scope}:${exp}`).digest();
}

/** Token for the image / download links of one report (scope = report id) or of a list ("all:open"). */
function linkToken(scope: string): string {
  const exp = Date.now() + LINK_TTL_MS;
  return `${exp}.${signLink(scope, exp).toString('base64url')}`;
}

function checkLink(scope: string, token: unknown): void {
  const [exp, sig] = typeof token === 'string' ? token.split('.') : [];
  const expected = signLink(scope, Number(exp));
  const given = Buffer.from(sig ?? '', 'base64url');
  if (!exp || !(Number(exp) > Date.now()) || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new HttpError(403, 'Link abgelaufen – den Bericht in der App neu öffnen');
  }
}

async function requireAdmin(req: FastifyRequest): Promise<void> {
  if (!(await isAdmin(userId(req)))) throw new HttpError(403, 'Nur für Admins');
}

const statusOf = (v: unknown): BugReportStatus | 'all' => (v === 'open' || v === 'done' ? v : 'all');

// ------------------------------------------------------------------ routes

const createSchema = z.object({
  matchId: z.string().regex(UUID, 'Ungültiges Spiel'),
  /** the reported dart (index of its event); none = a dart that was not detected at all */
  eventIndex: z.number().int().min(0).nullable().optional(),
  kind: z.enum(['wrong', 'phantom', 'missed', 'other']),
  /** what it really was; null = no dart at all */
  actual: segmentSchema.nullable().optional(),
  note: z.string().trim().max(1000).optional(),
});

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  app.post('/api/reports', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req) => {
    const user = userId(req);
    const body = parse(createSchema, req.body);
    const { row, state, boardOf } = await matchForReport(body.matchId, user);

    // the reported dart and the turn it belongs to (missed dart: the current turn)
    let ev: DartEvent | null = null;
    let turn = state.turn;
    if (body.eventIndex !== undefined && body.eventIndex !== null) {
      const e = row.events[body.eventIndex];
      if (!e || e.t !== 'dart') throw new HttpError(404, 'Wurf nicht gefunden');
      ev = e;
      turn = state.legs.flatMap((l) => l.turns).find((t) => t.darts.some((d) => d.eventIndex === body.eventIndex)) ?? state.turn;
    }
    const boardId = boardOf(turn.player);
    if (!boardId) throw new HttpError(409, 'Dieses Spiel läuft ohne Board – es gibt keine Kamerabilder.');
    const darts = turn.darts.map((d) => {
      const e = row.events[d.eventIndex] as DartEvent;
      return { eventIndex: d.eventIndex, label: d.label, seg: e.seg, src: e.src, x: e.x, y: e.y, bid: e.bid, out: e.out, det: e.det, at: e.at };
    });
    const detected = ev ? (ev.det?.seg ?? (ev.src === 'board' ? ev.seg : null)) : null;

    // camera images: of the reported dart; for a missed dart those of the whole turn and of the last
    // changes the board did not take for a dart (that is where a missed dart ends up)
    const bids = ev ? (ev.bid ? [ev.bid] : []) : darts.flatMap((d) => (d.bid ? [d.bid] : []));
    const discarded = !ev || body.kind === 'missed' || body.kind === 'other' ? 3 : 0;
    const board = await currentBoardSummary(boardId, 'member');
    const delivered = await requestBoardReport(boardId, bids, discarded);

    const details = {
      reporter: { id: user, username: req.user.username },
      match: {
        id: row.id,
        settings: row.settings,
        status: row.status,
        players: row.players.map((p) => ({ name: p.name, userId: p.userId ?? null, boardId: p.boardId ?? null })),
        leg: state.legs.length,
        round: state.round,
      },
      dart: ev ? { eventIndex: body.eventIndex, seg: ev.seg, src: ev.src, x: ev.x, y: ev.y, bid: ev.bid, out: ev.out, det: ev.det, at: ev.at } : null,
      turn: { player: turn.player, playerName: state.players[turn.player]?.name ?? null, darts },
      board: board
        ? { id: board.id, name: board.name, online: board.online, status: board.status, calibration: board.calibration, settings: board.settings }
        : { id: boardId },
      /** from the board: per detection the frames (before / peak / after per camera) and the detector data */
      boardReport: delivered.info,
      requested: { darts: bids, discarded },
      userAgent: req.headers['user-agent'] ?? null,
    };

    const client = await pool.connect();
    let id: string;
    try {
      await client.query('BEGIN');
      const res = await client.query<{ id: string }>(
        `INSERT INTO bug_reports(user_id, board_id, match_id, kind, detected, actual, note, details, board_error)
         VALUES ($1, (SELECT id FROM boards WHERE id = $2), $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9)
         RETURNING id`,
        [
          user,
          boardId,
          row.id,
          body.kind,
          detected ? JSON.stringify(detected) : null,
          body.actual ? JSON.stringify(body.actual) : null,
          body.note ?? '',
          JSON.stringify(details),
          delivered.error,
        ],
      );
      id = res.rows[0].id;
      for (const f of delivered.files) {
        await client.query('INSERT INTO bug_report_files(report_id, name, mime, data) VALUES ($1, $2, $3, $4)', [id, f.name, f.mime, f.data]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    req.log.info({ report: id, kind: body.kind, board: boardId, images: delivered.files.length, boardError: delivered.error }, 'bug report saved');
    return { id, images: delivered.files.length, boardError: delivered.error };
  });

  // ---------------------------------------------------------------- admins
  app.get<{ Querystring: { status?: string } }>('/api/reports', async (req) => {
    await requireAdmin(req);
    const status = statusOf(req.query.status);
    return { reports: await listReports(status), downloadToken: linkToken(`all:${status}`) };
  });

  app.get<{ Params: { id: string } }>('/api/reports/:id', async (req): Promise<BugReportDetail> => {
    await requireAdmin(req);
    const report = await getReport(req.params.id);
    if (!report) throw new HttpError(404, 'Bericht nicht gefunden');
    return { ...report, files: await reportFiles(report.id), fileToken: linkToken(report.id) };
  });

  app.patch<{ Params: { id: string } }>('/api/reports/:id', async (req) => {
    await requireAdmin(req);
    const body = parse(z.object({ status: z.enum(['open', 'done']) }), req.body);
    if (!UUID.test(req.params.id)) throw new HttpError(404, 'Bericht nicht gefunden');
    const rows = await query('UPDATE bug_reports SET status = $2 WHERE id = $1 RETURNING id', [req.params.id, body.status]);
    if (!rows.length) throw new HttpError(404, 'Bericht nicht gefunden');
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/reports/:id', async (req) => {
    await requireAdmin(req);
    if (!UUID.test(req.params.id)) throw new HttpError(404, 'Bericht nicht gefunden');
    await query('DELETE FROM bug_reports WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}

/** Images and downloads: no login header (img / download links), a signed short-lived token instead. */
export async function reportLinkRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string; name: string }; Querystring: { t?: string } }>('/api/reports/:id/files/:name', async (req, reply) => {
    checkLink(req.params.id, req.query.t);
    const file = await reportFile(req.params.id, req.params.name);
    if (!file) throw new HttpError(404, 'Nicht gefunden');
    return reply.header('content-type', file.mime).header('cache-control', 'private, max-age=3600').send(file.data);
  });

  app.get<{ Params: { id: string }; Querystring: { t?: string } }>('/api/reports/:id/download', async (req, reply) => {
    checkLink(req.params.id, req.query.t);
    const report = await getReport(req.params.id);
    if (!report) throw new HttpError(404, 'Bericht nicht gefunden');
    const data = await reportBundle([report.id]);
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="autodarter-bericht-${reportFolder(report)}.zip"`)
      .send(data);
  });

  app.get<{ Querystring: { t?: string; status?: string } }>('/api/reports/download', async (req, reply) => {
    const status = statusOf(req.query.status);
    checkLink(`all:${status}`, req.query.t);
    const reports = await listReports(status);
    const data = await reportBundle(reports.map((r) => r.id));
    const day = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="autodarter-berichte-${status}-${day}.zip"`)
      .send(data);
  });
}
