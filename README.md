# Gadstyle Shortlink Worker

Stable Worker baseline for Phase 5 production cutover.

## Status
- Code unchanged from stable Phase 4
- Used by the live Vercel frontend through `SHORTLINK_API_BASE_URL`

## Stable endpoints
- `GET /health`
- `GET /api/test`
- `GET /api/shortlinks/resolve?code=...`
- `GET /api/shortlinks/resolve-direct?entity_type=product|category|brand&entity_id=...`
- `POST /api/shortlinks`
- `GET /api/admin/stats`
- `GET /api/admin/links`
- `GET /api/admin/recent-clicks`
