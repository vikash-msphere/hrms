# Web (React SPA) — scaffold + conventions

The SPA is served as static assets by the Worker (`web/dist`, SPA fallback). It calls the API under
`/v1`, relies on the Cloudflare Access cookie for auth (no token storage), and parses RFC 9457 errors.

## Scaffold
```
npm create vite@latest web -- --template react-ts   # if starting fresh; this kit already has src/ samples
cd web && npm i
npm i -D tailwindcss postcss autoprefixer && npx tailwindcss init -p
# optional: npx shadcn@latest init   (then `npx shadcn@latest add button table dialog input ...`)
```
Set `build.outDir` to `../web/dist` in `web/vite.config.ts`, and proxy `/v1` to `http://localhost:8787`
during dev.

## Conventions
- All requests go through `src/api.ts` (adds `X-Requested-By: hrms-spa`, `credentials: 'include'`,
  parses problem+json).
- Update calls use `Content-Type: application/merge-patch+json` and send only changed snake_case fields,
  with the resource's `etag` in `If-Match`.
- Build one page per resource. `pages/Directory.example.tsx` is the reference (list + create).
- On a 401, redirect to `/` so Cloudflare Access re-challenges via Google.

## Files included
- `src/api.ts` — fetch wrapper (verified).
- `src/useMe.ts` — loads the current user/role.
- `src/App.example.tsx` — role-aware shell sketch.
- `src/pages/Directory.example.tsx` — employees list + create.
Rename the `.example.tsx` files as you flesh out the app.
