# Gadstyle Shortlink Worker

Cloudflare Worker + D1 backend for Gadstyle shortlink resolution.

## Phase 2 endpoints

- `GET /health`
- `GET /api/test`
- `GET /api/shortlinks/resolve?code=...`
- `POST /api/shortlinks`

## POST body

```json
{
  "entity_type": "product",
  "entity_id": 174776,
  "code": "my-custom-code",
  "web_url": "https://www.gadstyle.com/item/174776/spaceship-clock-projection-lamp-convenient-for-travel-atmosphere-night-light/",
  "source": "phase2-test",
  "notes": "optional note"
}
```

## Behavior

- canonical app paths are always generated from entity type + ID
- product -> `/p/{id}`
- category -> `/c/{id}`
- brand -> `/b/{id}`
- no slug-based routing dependency
- resolve endpoint returns only active shortlinks
- API responses use `Cache-Control: no-store`

## Deployment

This Worker is deployed separately from the live Vercel shortlink frontend.
