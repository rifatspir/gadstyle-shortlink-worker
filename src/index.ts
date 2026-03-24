export interface Env {
  DB: D1Database;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      pragma: 'no-cache',
      expires: '0',
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      try {
        const probe = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
        return json({
          ok: true,
          phase: 1,
          service: 'gadstyle-shortlink-worker',
          d1_connected: probe?.ok === 1,
          database_binding: 'DB',
        });
      } catch (error) {
        return json({
          ok: false,
          phase: 1,
          service: 'gadstyle-shortlink-worker',
          d1_connected: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        }, 500);
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/test') {
      try {
        const tables = await env.DB
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all<{ name: string }>();

        const shortlinkCount = await env.DB
          .prepare('SELECT COUNT(*) AS count FROM shortlinks')
          .first<{ count: number }>();

        return json({
          ok: true,
          phase: 1,
          service: 'gadstyle-shortlink-worker',
          tables: tables.results.map((row) => row.name),
          shortlinks_count: shortlinkCount?.count ?? 0,
        });
      } catch (error) {
        return json({
          ok: false,
          phase: 1,
          service: 'gadstyle-shortlink-worker',
          error: error instanceof Error ? error.message : 'Unknown error',
        }, 500);
      }
    }

    return json({ ok: false, error: 'Not found' }, 404);
  },
};
