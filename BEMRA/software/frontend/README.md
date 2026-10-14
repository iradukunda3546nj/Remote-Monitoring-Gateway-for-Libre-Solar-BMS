# BEMRA dashboard (frontend)

Single-page monitoring dashboard for Libre Solar BMS telemetry. It reads only from the
BEMRA REST API (`software/backend`) using REST polling every 5 s.

```powershell
cd BEMRA\software\frontend
npm install
npm run dev        # http://localhost:5173  (backend API + worker must be running)
```

`.env`: `VITE_API_BASE_URL=http://localhost:3000/api/v1` (see `.env.example`).

The page has a header (API status), a device selector (`?device=` in the URL), a telemetry
summary, the battery (SOC fill and current direction), cell voltages, a status panel, and a
trend chart (voltage / current / SOC / temperature; Live, 1h, 24h).

Endpoints used: `/ready`, `/api/v1/devices`, `/devices/:id`, `/devices/:id/status`,
`/devices/:id/latest`, `/devices/:id/telemetry`.

`npm test` · `npm run lint` · `npm run build`
