import pg from 'pg';
import { config } from './config';

// connectionTimeoutMillis: never hang forever if the database is not reachable (pg default is no timeout)
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 5000 });

export async function query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE boards (
    id TEXT PRIMARY KEY,
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL DEFAULT 'Dartboard',
    secret_hash TEXT NOT NULL,
    pairing_code TEXT UNIQUE,
    calibration JSONB NOT NULL DEFAULT '{}'::jsonb,
    settings JSONB,
    last_seen TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX boards_owner_idx ON boards(owner_id);
  CREATE TABLE matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    board_id TEXT REFERENCES boards(id) ON DELETE SET NULL,
    settings JSONB NOT NULL,
    players JSONB NOT NULL,
    events JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'running',
    winner INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
  );
  CREATE INDEX matches_owner_idx ON matches(owner_id, created_at DESC);
  CREATE TABLE match_players (
    match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    player_index INT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (match_id, player_index)
  );
  CREATE INDEX match_players_user_idx ON match_players(user_id);
  `,
  // v2: boards can be shared (n users <-> m boards) and friends
  `
  CREATE TABLE board_members (
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (board_id, user_id)
  );
  CREATE INDEX board_members_user_idx ON board_members(user_id);
  INSERT INTO board_members(board_id, user_id, role) SELECT id, owner_id, 'owner' FROM boards WHERE owner_id IS NOT NULL;

  CREATE TABLE friendships (
    requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (requester_id, addressee_id),
    CHECK (requester_id <> addressee_id)
  );
  CREATE INDEX friendships_addressee_idx ON friendships(addressee_id);
  `,
  `
  -- last known calibration per camera id: survives a lost data folder on the Pi
  ALTER TABLE boards ADD COLUMN calibration_backup JSONB NOT NULL DEFAULT '{}';

  CREATE TABLE voice_packs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    shared BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX voice_packs_owner_idx ON voice_packs(owner_id);
  CREATE TABLE voice_clips (
    pack_id UUID NOT NULL REFERENCES voice_packs(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    mime TEXT NOT NULL,
    data BYTEA NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (pack_id, key)
  );
  ALTER TABLE users ADD COLUMN voice_pack_id UUID REFERENCES voice_packs(id) ON DELETE SET NULL;
  ALTER TABLE matches ADD COLUMN voice_pack_id UUID REFERENCES voice_packs(id) ON DELETE SET NULL;
  `,
  `
  -- who speaks in a match: 'host' = pack of the creator for everybody, 'own' = every player their own
  ALTER TABLE matches ADD COLUMN voice_mode TEXT NOT NULL DEFAULT 'host';
  CREATE INDEX matches_running_idx ON matches(owner_id) WHERE status = 'running';
  `,
  `
  -- bug reports: a wrongly detected dart with the camera images of the board (for the analysis)
  CREATE TABLE bug_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    board_id TEXT REFERENCES boards(id) ON DELETE SET NULL,
    match_id UUID REFERENCES matches(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    detected JSONB,
    actual JSONB,
    note TEXT NOT NULL DEFAULT '',
    details JSONB NOT NULL DEFAULT '{}',
    board_error TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX bug_reports_created_idx ON bug_reports(created_at DESC);
  CREATE TABLE bug_report_files (
    report_id UUID NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    data BYTEA NOT NULL,
    PRIMARY KEY (report_id, name)
  );
  `,
];

async function waitForDb(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      // give up after ~3 minutes – Docker (restart: unless-stopped) starts the server again
      if (attempt >= 30) throw err;
      console.log(`[db] Datenbank noch nicht erreichbar (Versuch ${attempt}): ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function migrate(): Promise<void> {
  await waitForDb();
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await query<{ version: number }>('SELECT version FROM schema_migrations')).map((r) => r.version));
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const version = i + 1;
    if (done.has(version)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(MIGRATIONS[i]);
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      console.log(`[db] Migration ${version} angewendet`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
