# WhatsApp Integration

## Architecture
- **Daemon** (`scripts/whatsapp-daemon.ts`) — standalone process, NOT part of Next.js build (excluded in tsconfig)
- Uses `@whiskeysockets/baileys` (pure WebSocket, NO Puppeteer/Chromium) — ~5-10 MB per session
- **Multi-session**: one Baileys connection per user, managed in a `Map<userId, socket>`
- Auth state persisted per user in `./baileys_auth/<userId>/`
- Requires separate `npm install @whiskeysockets/baileys pino qrcode-terminal`
- Run with: `npx tsx scripts/whatsapp-daemon.ts`

## Daemon HTTP API (default port 3001)
- `GET /health` — alive check + session/connected counts
- `GET /sessions` — list all user sessions (userId, connected, phone, hasQr, error)
- `GET /status/:userId` — per-user connection status + QR code for pairing
- `POST /sessions/:userId/connect` — initiate new session (returns 202, poll `/status/:userId` for QR)
- `DELETE /sessions/:userId` — disconnect and remove a session
- `POST /send { userId, to, body }` — send message via specific user's session

## Message Flow
1. Daemon receives WA message via Baileys event → creates/reuses a `channels` record (type='whatsapp', identifier=phone), writes to Supabase `messages` table (`channel_id: <channel UUID>`, `external_thread_id: wa:+phone`)
2. Agent pipeline picks up WA messages in Step 3 (same as email)
3. Threading groups by phone number
4. AI receives channel context, adjusts tone
5. On execution, sender calls daemon's `/send` endpoint with `userId` to route to correct session

## Multi-Session Scaling
- No Puppeteer/Chromium — pure WebSocket connections
- ~5-10 MB RAM per session (vs 150-300 MB with whatsapp-web.js)
- 50-100 concurrent users comfortably on a single server
- On startup, daemon scans `./baileys_auth/` and auto-reconnects all existing sessions
- Staggered reconnect (2s delay) to avoid hammering WA servers

## Configuration
All in `src/config/client.ts` → `whatsapp` section:
- `enabled`, `sessionDataPath`, `daemonPort`, `autoAckMessage`, `blockedNumbers`, `monitoredGroups`
