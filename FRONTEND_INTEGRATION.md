# Frontend integration

The frontend should call this backend, not Apify directly. Never put `APIFY_TOKEN` in the browser or localStorage.

Endpoints:
- GET /api/health
- GET /api/accounts
- POST /api/accounts { username, category }
- POST /api/accounts/:id/sync
- POST /api/batch/random
- POST /api/jobs/:id/render { hook, caption }
- GET /api/jobs/:id
- GET /api/batches/:batchId
