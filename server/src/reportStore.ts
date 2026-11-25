/**
 * Bug reports in the database: list, details, images and ZIP bundles. No routes and no board
 * connection here, so the export command (exportReports.ts) can use it without starting the server.
 */
import type { Segment } from '@shared/board';
import type { BugReportFile, BugReportKind, BugReportStatus, BugReportSummary } from '@shared/protocol';
import { query } from './db';
import { zip, type ZipEntry } from './zip';

interface SummaryRow {
  id: string;
  created_at: Date;
  kind: BugReportKind;
  status: BugReportStatus;
  detected: Segment | null;
  actual: Segment | null;
  note: string;
  board_error: string | null;
  match_id: string | null;
  reporter: string | null;
  board_name: string | null;
  images: number;
}

const SUMMARY_SQL = `
  SELECT r.id, r.created_at, r.kind, r.status, r.detected, r.actual, r.note, r.board_error, r.match_id,
         u.display_name AS reporter, COALESCE(b.name, r.details->'board'->>'name') AS board_name,
         (SELECT count(*)::int FROM bug_report_files f WHERE f.report_id = r.id) AS images
    FROM bug_reports r
    LEFT JOIN users u ON u.id = r.user_id
    LEFT JOIN boards b ON b.id = r.board_id`;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toSummary(r: SummaryRow): BugReportSummary {
  return {
    id: r.id,
    createdAt: r.created_at.toISOString(),
    kind: r.kind,
    status: r.status,
    detected: r.detected,
    actual: r.actual,
    note: r.note,
    reporter: r.reporter,
    boardName: r.board_name,
    matchId: r.match_id,
    images: r.images,
    boardError: r.board_error,
  };
}

export async function listReports(status: BugReportStatus | 'all' = 'all', since?: Date): Promise<BugReportSummary[]> {
  const rows = await query<SummaryRow>(
    `${SUMMARY_SQL}
      WHERE ($1 = 'all' OR r.status = $1) AND ($2::timestamptz IS NULL OR r.created_at >= $2)
      ORDER BY r.created_at DESC
      LIMIT 1000`,
    [status, since ?? null],
  );
  return rows.map(toSummary);
}

export async function getReport(id: string): Promise<(BugReportSummary & { details: Record<string, unknown> }) | null> {
  if (!UUID.test(id)) return null;
  const [row] = await query<SummaryRow & { details: Record<string, unknown> }>(`${SUMMARY_SQL.replace('SELECT r.id,', 'SELECT r.details, r.id,')} WHERE r.id = $1`, [id]);
  return row ? { ...toSummary(row), details: row.details } : null;
}

export async function reportFiles(id: string): Promise<BugReportFile[]> {
  return query<BugReportFile>('SELECT name, mime, octet_length(data)::int AS size FROM bug_report_files WHERE report_id = $1 ORDER BY name', [id]);
}

export async function reportFile(id: string, name: string): Promise<{ mime: string; data: Buffer } | null> {
  if (!UUID.test(id)) return null;
  const [row] = await query<{ mime: string; data: Buffer }>('SELECT mime, data FROM bug_report_files WHERE report_id = $1 AND name = $2', [id, name]);
  return row ?? null;
}

/** Folder of a report in a ZIP: time (UTC), kind and the start of the id - sorts by time. */
export function reportFolder(r: { id: string; createdAt: string; kind: string }): string {
  const t = r.createdAt.slice(0, 16).replace('T', '_').replace(':', '-');
  return `${t}_${r.kind}_${r.id.slice(0, 8)}`;
}

/** ZIP with one folder per report: report.json (everything except the images) and the images. */
export async function reportBundle(ids: string[]): Promise<Buffer> {
  const entries: ZipEntry[] = [];
  for (const id of ids) {
    const report = await getReport(id);
    if (!report) continue;
    const folder = reportFolder(report);
    const date = new Date(report.createdAt);
    const files = await query<{ name: string; mime: string; data: Buffer }>('SELECT name, mime, data FROM bug_report_files WHERE report_id = $1 ORDER BY name', [id]);
    const json = { ...report, files: files.map((f) => ({ name: f.name, mime: f.mime, size: f.data.length })) };
    entries.push({ name: `${folder}/report.json`, data: Buffer.from(JSON.stringify(json, null, 2)), date });
    for (const f of files) entries.push({ name: `${folder}/${f.name}`, data: f.data, date });
  }
  return zip(entries);
}
