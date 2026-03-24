export interface Env {
  DB: D1Database;
}

type EntityType = 'product' | 'category' | 'brand';

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
  created_at: string;
  updated_at: string;
};

const SERVICE_NAME = 'gadstyle-shortlink-worker';
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
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
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
      `SELECT id, code, entity_type, entity_id, app_path, web_url, is_active, source, notes, created_at, updated_at
       FROM shortlinks
       WHERE code = ? AND is_active = 1
       LIMIT 1`,
    )
    .bind(normalized)
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
      `INSERT INTO shortlinks (code, entity_type, entity_id, app_path, web_url, is_active, source, notes)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(row.code, row.entityType, row.entityId, row.appPath, row.webUrl, row.source, row.notes)
    .run();

  const newId = insert.meta.last_row_id;
  if (!newId) {
    throw new Error('Shortlink insert did not return a row id.');
  }

  const created = await env.DB
    .prepare(
      `SELECT id, code, entity_type, entity_id, app_path, web_url, is_active, source, notes, created_at, updated_at
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

async function handleHealth(env: Env) {
  const probe = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return json({
    ok: true,
    phase: 2,
    service: SERVICE_NAME,
    d1_connected: probe?.ok === 1,
    database_binding: 'DB',
  });
}

async function handleTest(env: Env) {
  const tables = await getTables(env);
  const shortlinkCount = await env.DB
    .prepare('SELECT COUNT(*) AS count FROM shortlinks')
    .first<{ count: number }>();

  return json({
    ok: true,
    phase: 2,
    service: SERVICE_NAME,
    tables,
    shortlinks_count: shortlinkCount?.count ?? 0,
  });
}

async function handleResolve(url: URL, env: Env) {
  const code = normalizeText(url.searchParams.get('code'), 120);
  if (!code) {
    return json({
      ok: false,
      error: 'Missing required query parameter: code',
    }, 400);
  }

  const row = await findActiveByCode(env, code);
  if (!row) {
    return json({
      ok: false,
      error: 'Shortlink not found',
      code: normalizeCode(code),
    }, 404);
  }

  return json({
    ok: true,
    phase: 2,
    service: SERVICE_NAME,
    shortlink: serializeShortlink(row),
  });
}

async function handleCreate(request: Request, env: Env) {
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

  if (!entityType) {
    return json({
      ok: false,
      error: 'entity_type must be one of: product, category, brand',
    }, 400);
  }

  if (!entityId) {
    return json({
      ok: false,
      error: 'entity_id must be a numeric string or number',
    }, 400);
  }

  const appPath = buildAppPath(entityType, entityId);
  const desiredCode = requestedCodeRaw ? normalizeCode(requestedCodeRaw) : buildFallbackCode(entityType, entityId);

  if (!desiredCode) {
    return json({ ok: false, error: 'Unable to determine a valid short code' }, 400);
  }

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

  return json({
    ok: true,
    phase: 2,
    service: SERVICE_NAME,
    created: true,
    shortlink: serializeShortlink(created),
  }, 201);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return await handleHealth(env);
      }

      if (request.method === 'GET' && url.pathname === '/api/test') {
        return await handleTest(env);
      }

      if (request.method === 'GET' && url.pathname === '/api/shortlinks/resolve') {
        return await handleResolve(url, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/shortlinks') {
        return await handleCreate(request, env);
      }

      if (url.pathname === '/api/shortlinks' || url.pathname === '/api/shortlinks/resolve') {
        return json({ ok: false, error: 'Method not allowed' }, 405);
      }

      return json({ ok: false, error: 'Not found' }, 404);
    } catch (error) {
      return json({
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown worker error',
      }, 500);
    }
  },
};
