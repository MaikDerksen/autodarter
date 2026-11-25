/**
 * Export bug reports as ZIP (one folder per report: report.json + camera images) - for the analysis
 * on the server via SSH, without the app:
 *
 *   docker compose exec -T server node dist/export-reports.js > berichte.zip            # open reports
 *   docker compose exec -T server node dist/export-reports.js --all > berichte.zip      # all reports
 *   docker compose exec -T server node dist/export-reports.js --since 2026-11-01 > berichte.zip
 *   docker compose exec -T server node dist/export-reports.js --list                     # overview only
 *
 * Mark as done after the analysis: --done <id> [<id> …]
 */
import { segmentLabel } from '@shared/board';
import { pool, query } from './db';
import { UUID, listReports, reportBundle, reportFolder } from './reportStore';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const value = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  if (flag('--done')) {
    const ids = args.filter((a) => UUID.test(a));
    for (const id of ids) await query(`UPDATE bug_reports SET status = 'done' WHERE id = $1`, [id]);
    console.error(`${ids.length} Bericht(e) als erledigt markiert`);
    return;
  }

  const since = value('--since') ? new Date(value('--since') as string) : undefined;
  if (since && Number.isNaN(since.getTime())) throw new Error('--since: Datum wie 2026-11-01 angeben');
  const reports = await listReports(flag('--all') ? 'all' : 'open', since);
  for (const r of reports) {
    const seg = (s: typeof r.detected) => (s ? segmentLabel(s) : '–');
    console.error(
      `${reportFolder(r)}  ${r.status.padEnd(4)}  erkannt ${seg(r.detected).padEnd(5)} wirklich ${seg(r.actual).padEnd(5)} ${r.images} Bilder  ${r.id}${r.note ? `  „${r.note}“` : ''}`,
    );
  }
  console.error(`${reports.length} Bericht(e)`);
  if (flag('--list')) return;
  if (process.stdout.isTTY) {
    console.error('Die ZIP-Datei bitte umleiten:  … export-reports.js > berichte.zip');
    return;
  }
  const data = await reportBundle(reports.map((r) => r.id));
  await new Promise<void>((resolve, reject) => process.stdout.write(data, (err) => (err ? reject(err) : resolve())));
}

main()
  .catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
