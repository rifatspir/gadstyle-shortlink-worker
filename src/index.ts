export interface Env {
  DB: D1Database;
}

type EntityType = 'product' | 'category' | 'brand';
type RouteType = 'short_code' | 'direct_product' | 'direct_category' | 'direct_brand';

type ShortlinkRow = {
  id: number;
  code: string;
  entity_type: EntityType | 'shortcode';
  entity_id: string | null;
  app_path: string;
  web_url: string | null;
  is_active: number;
  source: string;
  notes: string | null;
  click_count?: number;
  created_at: string;
  updated_at: string;
};

type RecentClickRow = {
  id: number;
  route_type: RouteType;
  created_at: string;
  code: string;
  entity_type: EntityType;
  entity_id: string;
};

const SERVICE_NAME = 'gadstyle-shortlink-worker';
const PHASE = 5;
const DEFAULT_LINKS_PAGE_SIZE = 20;
const MAX_LINKS_PAGE_SIZE = 100;
const DEFAULT_RECENT_CLICKS_LIMIT = 20;
const MAX_RECENT_CLICKS_LIMIT = 100;
const MAX_RECENT_CLICK_ROWS = 5000;
const NO_STORE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  pragma: 'no-cache',
  expires: '0',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: NO_STORE_HEADERS,
  });
}

function normalizeCode(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function normalizeEntityType(value: unknown): EntityType | null {
  if (typeof value !== 'string') return null;
  if (value === 'product' || value === 'category' || value === 'brand') return value;
  return null;
}

function normalizeText(value: unknown, maxLength = 500) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function normalizeEntityId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) return null;
  return normalized;
}

function normalizePositiveInt(value: string | null, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt((value || '').trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function buildAppPath(entityType: EntityType, entityId: string) {
  if (entityType === 'product') return `/p/${entityId}`;
  if (entityType === 'category') return `/c/${entityId}`;
  return `/b/${entityId}`;
}

function buildFallbackCode(entityType: EntityType, entityId: string) {
  if (entityType === 'product') return `p-${entityId}`;
  if (entityType === 'category') return `c-${entityId}`;
  return `b-${entityId}`;
}

function serializeShortlink(row: ShortlinkRow) {
  return {
    id: row.id,
    code: row.code,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    app_path: row.app_path,
    web_url: row.web_url,
    is_active: row.is_active === 1,
    source: row.source,
    notes: row.notes,
    click_count: row.click_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toAdminLink(row: ShortlinkRow) {
  return {
    id: row.id,
    code: row.code,
    targetType: row.entity_type,
    targetId: row.entity_id ?? '',
    clickCount: row.click_count ?? 0,
    isActive: row.is_active === 1,
    updatedAt: row.updated_at,
    canonicalUrl: row.web_url,
  };
}

function toAdminRecentClick(row: RecentClickRow) {
  return {
    id: row.id,
    createdAt: row.created_at,
    routeType: row.route_type,
    shortLink: {
      code: row.code,
      targetType: row.entity_type,
      targetId: row.entity_id,
    },
  };
}

async function ensurePhase5Schema(env: Env) {
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS shortlinks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('product', 'category', 'brand', 'shortcode')),
      entity_id TEXT,
      app_path TEXT NOT NULL,
      web_url TEXT,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      source TEXT NOT NULL DEFAULT 'manual',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_shortlinks_code ON shortlinks(code);
    CREATE INDEX IF NOT EXISTS idx_shortlinks_entity_type_id ON shortlinks(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_shortlinks_active ON shortlinks(is_active);
    CREATE TABLE IF NOT EXISTS recent_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shortlink_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('product', 'category', 'brand')),
      entity_id TEXT NOT NULL,
      route_type TEXT NOT NULL CHECK (route_type IN ('short_code', 'direct_product', 'direct_category', 'direct_brand')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (shortlink_id) REFERENCES shortlinks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_recent_clicks_created_at ON recent_clicks(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_recent_clicks_shortlink_id ON recent_clicks(shortlink_id);
  `);

  try {
    await env.DB.exec(`ALTER TABLE shortlinks ADD COLUMN click_count INTEGER NOT NULL DEFAULT 0;`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes('duplicate column name')) throw error;
  }
}

async function getTables(env: Env) {
  const result = await env.DB
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all<{ name: string }>();
  return result.results.map((row) => row.name);
}

async function reserveUniqueCode(env: Env, requestedCode: string) {
  const normalizedBase = normalizeCode(requestedCode);
  if (!normalizedBase) {
    throw new Error('Unable to generate a valid short code.');
  }

  let candidate = normalizedBase;
  let suffix = 2;

  while (true) {
    const existing = await env.DB
      .prepare('SELECT id FROM shortlinks WHERE code = ? LIMIT 1')
      .bind(candidate)
      .first<{ id: number }>();

    if (!existing) return candidate;

    candidate = `${normalizedBase}-${suffix}`;
    suffix += 1;
  }
}

async function findActiveByCode(env: Env, code: string) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;

  return env.DB
    .prepare(
      `SELECT id, code, entity_type, entity_id, app_path, web_url, is_active, source, notes, click_count, created_at, updated_at
       FROM shortlinks
       WHERE code = ? AND is_active = 1
       LIMIT 1`,
    )
    .bind(normalized)
    .first<ShortlinkRow>();
}

async function findActiveByEntity(env: Env, entityType: EntityType, entityId: string) {
  return env.DB
    .prepare(
      `SELECT id, code, entity_type, entity_id, app_path, web_url, is_active, source, notes, click_count, created_at, updated_at
       FROM shortlinks
       WHERE entity_type = ? AND entity_id = ? AND is_active = 1
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(entityType, entityId)
    .first<ShortlinkRow>();
}

async function insertShortlink(env: Env, row: {
  code: string;
  entityType: EntityType;
  entityId: string;
  appPath: string;
  webUrl: string | null;
  source: string;
  notes: string | null;
}) {
  const insert = await env.DB
    .prepare(
      `INSERT INTO shortlinks (code, entity_type, entity_id, app_path, web_url, is_active, source, notes, click_count)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)`,
    )
    .bind(row.code, row.entityType, row.entityId, row.appPath, row.webUrl, row.source, row.notes)
    .run();

  const newId = insert.meta.last_row_id;
  if (!newId) {
    throw new Error('Shortlink insert did not return a row id.');
  }

  const created = await env.DB
    .prepare(
      `SELECT id, code, entity_type, entity_id, app_path, web_url, is_active, source, notes, click_count, created_at, updated_at
       FROM shortlinks
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(newId)
    .first<ShortlinkRow>();

  if (!created) {
    throw new Error('Created shortlink could not be reloaded.');
  }

  return created;
}

async function logClick(env: Env, row: ShortlinkRow, routeType: RouteType) {
  if (!row.entity_id || (row.entity_type !== 'product' && row.entity_type !== 'category' && row.entity_type !== 'brand')) {
    return;
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE shortlinks
       SET click_count = COALESCE(click_count, 0) + 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
    ).bind(row.id),
    env.DB.prepare(
      `INSERT INTO recent_clicks (shortlink_id, code, entity_type, entity_id, route_type)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(row.id, row.code, row.entity_type, row.entity_id, routeType),
  ]);

  await env.DB.prepare(
    `DELETE FROM recent_clicks
     WHERE id NOT IN (
       SELECT id FROM recent_clicks ORDER BY id DESC LIMIT ?
     )`,
  ).bind(MAX_RECENT_CLICK_ROWS).run();
}

async function handleHealth(env: Env) {
  await ensurePhase5Schema(env);
  const probe = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return json({
    ok: true,
    phase: PHASE,
    service: SERVICE_NAME,
    d1_connected: probe?.ok === 1,
    database_binding: 'DB',
  });
}

async function handleTest(env: Env) {
  await ensurePhase5Schema(env);
  const tables = await getTables(env);
  const shortlinkCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM shortlinks').first<{ count: number }>();
  const clickCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM recent_clicks').first<{ count: number }>();
  return json({
    ok: true,
    phase: PHASE,
    service: SERVICE_NAME,
    tables,
    shortlinks_count: shortlinkCount?.count ?? 0,
    recent_click_rows: clickCount?.count ?? 0,
  });
}

async function handleResolve(url: URL, env: Env) {
  await ensurePhase5Schema(env);
  const code = normalizeText(url.searchParams.get('code'), 120);
  if (!code) {
    return json({ ok: false, error: 'Missing required query parameter: code' }, 400);
  }

  const row = await findActiveByCode(env, code);
  if (!row) {
    return json({ ok: false, error: 'Shortlink not found', code: normalizeCode(code) }, 404);
  }

  await logClick(env, row, 'short_code');
  const refreshed = await findActiveByCode(env, code);
  return json({ ok: true, phase: PHASE, service: SERVICE_NAME, shortlink: serializeShortlink(refreshed || row) });
}

async function handleResolveDirect(url: URL, env: Env) {
  await ensurePhase5Schema(env);
  const entityType = normalizeEntityType(url.searchParams.get('entity_type'));
  const entityId = normalizeEntityId(url.searchParams.get('entity_id'));

  if (!entityType) return json({ ok: false, error: 'Missing or invalid required query parameter: entity_type' }, 400);
  if (!entityId) return json({ ok: false, error: 'Missing or invalid required query parameter: entity_id' }, 400);

  const row = await findActiveByEntity(env, entityType, entityId);
  if (!row) {
    return json({ ok: false, error: 'Shortlink not found', entity_type: entityType, entity_id: entityId }, 404);
  }

  const routeType: RouteType = entityType === 'product'
    ? 'direct_product'
    : entityType === 'category'
      ? 'direct_category'
      : 'direct_brand';

  await logClick(env, row, routeType);
  const refreshed = await findActiveByEntity(env, entityType, entityId);
  return json({ ok: true, phase: PHASE, service: SERVICE_NAME, shortlink: serializeShortlink(refreshed || row) });
}

async function handleCreate(request: Request, env: Env) {
  await ensurePhase5Schema(env);
  let body: Record<string, unknown>;
  try {
    body = await request.json<Record<string, unknown>>();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const entityType = normalizeEntityType(body.entity_type);
  const entityId = normalizeEntityId(body.entity_id);
  const requestedCodeRaw = normalizeText(body.code, 120);
  const webUrl = normalizeText(body.web_url, 2000);
  const source = normalizeText(body.source, 120) ?? 'worker-api';
  const notes = normalizeText(body.notes, 2000);

  if (!entityType) return json({ ok: false, error: 'entity_type must be one of: product, category, brand' }, 400);
  if (!entityId) return json({ ok: false, error: 'entity_id must be a numeric string or number' }, 400);

  const appPath = buildAppPath(entityType, entityId);
  const desiredCode = requestedCodeRaw ? normalizeCode(requestedCodeRaw) : buildFallbackCode(entityType, entityId);
  if (!desiredCode) return json({ ok: false, error: 'Unable to determine a valid short code' }, 400);

  const uniqueCode = await reserveUniqueCode(env, desiredCode);
  const created = await insertShortlink(env, {
    code: uniqueCode,
    entityType,
    entityId,
    appPath,
    webUrl,
    source,
    notes,
  });

  return json({ ok: true, phase: PHASE, service: SERVICE_NAME, created: true, shortlink: serializeShortlink(created) }, 201);
}

async function handleAdminStats(env: Env) {
  await ensurePhase5Schema(env);
  const [totalLinksRow, totalClicksRow, recentClicksRow] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS count FROM shortlinks').first<{ count: number }>(),
    env.DB.prepare('SELECT COALESCE(SUM(click_count), 0) AS count FROM shortlinks').first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM recent_clicks WHERE created_at >= datetime('now', '-14 days')").first<{ count: number }>(),
  ]);

  return json({
    ok: true,
    phase: PHASE,
    service: SERVICE_NAME,
    stats: {
      totalLinks: totalLinksRow?.count ?? 0,
      totalClicks: totalClicksRow?.count ?? 0,
      recentClicks: recentClicksRow?.count ?? 0,
    },
  });
}

async function handleAdminLinks(url: URL, env: Env) {
  await ensurePhase5Schema(env);
  const search = normalizeText(url.searchParams.get('q'), 120);
  const page = normalizePositiveInt(url.searchParams.get('page'), 1);
  const pageSize = normalizePositiveInt(url.searchParams.get('page_size'), DEFAULT_LINKS_PAGE_SIZE, 1, MAX_LINKS_PAGE_SIZE);
  const offset = (page - 1) * pageSize;

  const whereClause = search ? 'WHERE code LIKE ? OR web_url LIKE ? OR entity_id LIKE ?' : '';
  const countSql = `SELECT COUNT(*) AS count FROM shortlinks ${whereClause}`;
  const rowsSql = `SELECT id, code, entity_type, entity_id, app_path, web_url, is_active, source, notes, click_count, created_at, updated_at
                   FROM shortlinks
                   ${whereClause}
                   ORDER BY updated_at DESC, id DESC
                   LIMIT ? OFFSET ?`;

  const countStmt = env.DB.prepare(countSql);
  const rowsStmt = env.DB.prepare(rowsSql);

  const countPromise = search
    ? countStmt.bind(`%${search}%`, `%${search}%`, `%${search}%`).first<{ count: number }>()
    : countStmt.first<{ count: number }>();
  const rowsPromise = search
    ? rowsStmt.bind(`%${search}%`, `%${search}%`, `%${search}%`, pageSize, offset).all<ShortlinkRow>()
    : rowsStmt.bind(pageSize, offset).all<ShortlinkRow>();

  const [countRow, rows] = await Promise.all([countPromise, rowsPromise]);
  const totalItems = countRow?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  return json({
    ok: true,
    phase: PHASE,
    service: SERVICE_NAME,
    links: rows.results.map(toAdminLink),
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages,
    },
  });
}

async function handleRecentClicks(url: URL, env: Env) {
  await ensurePhase5Schema(env);
  const limit = normalizePositiveInt(url.searchParams.get('limit'), DEFAULT_RECENT_CLICKS_LIMIT, 1, MAX_RECENT_CLICKS_LIMIT);
  const result = await env.DB.prepare(
    `SELECT id, route_type, created_at, code, entity_type, entity_id
     FROM recent_clicks
     ORDER BY id DESC
     LIMIT ?`,
  ).bind(limit).all<RecentClickRow>();

  return json({
    ok: true,
    phase: PHASE,
    service: SERVICE_NAME,
    clicks: result.results.map(toAdminRecentClick),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && url.pathname === '/health') return await handleHealth(env);
      if (request.method === 'GET' && url.pathname === '/api/test') return await handleTest(env);
      if (request.method === 'GET' && url.pathname === '/api/shortlinks/resolve') return await handleResolve(url, env);
      if (request.method === 'GET' && url.pathname === '/api/shortlinks/resolve-direct') return await handleResolveDirect(url, env);
      if (request.method === 'POST' && url.pathname === '/api/shortlinks') return await handleCreate(request, env);
      if (request.method === 'GET' && url.pathname === '/api/admin/stats') return await handleAdminStats(env);
      if (request.method === 'GET' && url.pathname === '/api/admin/links') return await handleAdminLinks(url, env);
      if (request.method === 'GET' && url.pathname === '/api/admin/recent-clicks') return await handleRecentClicks(url, env);

      if (
        url.pathname === '/api/shortlinks' ||
        url.pathname === '/api/shortlinks/resolve' ||
        url.pathname === '/api/shortlinks/resolve-direct' ||
        url.pathname === '/api/admin/stats' ||
        url.pathname === '/api/admin/links' ||
        url.pathname === '/api/admin/recent-clicks'
      ) {
        return json({ ok: false, error: 'Method not allowed' }, 405);
      }

      return json({ ok: false, error: 'Not found' }, 404);
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : 'Unknown worker error' }, 500);
    }
  },
};
