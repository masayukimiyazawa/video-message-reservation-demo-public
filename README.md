# Vonage Video Reservation

A video calling application with appointment booking, built around Vonage Video API.

- **backend/**: Node.js / Express, Vonage Video & Messages API, MongoDB Atlas (Mongoose), Socket.IO, node-cron, JWT/RBAC
- **frontend/**: React SPA, react-i18next (en/ja), Vonage Video Client SDK, Socket.IO client

## Main Features

| Feature | Description |
|---------|-------------|
| **WhatsApp Reservation Flow** | Interactive messages with reply button / list / carousel to select service and time, confirmation OK / correction selection, automatic embedding of entry link upon confirmation |
| **Time Slot Selection** | Fixed slots at 09:00 / 10:30 / 14:00 / 15:30, same-day filtering, and multi-day fallback when no candidates remain (see current limitations below) |
| **Reminder Notifications** | Independently poll confirmed bookings within 24 hours and within 10 minutes; the latter includes a join URL button and admin notifications |
| **Reservation Time Arrival Notification** | Notifies via WhatsApp (with entry link) and Admin screen Socket.IO when reservation time arrives |
| **Entry Link (One-time)** | The `/join/:tokenId` page calls `POST /sessions/join/:tokenId` to consume the link, obtain guest credentials, and navigate to `/call/:sessionId`. The same link cannot be reused |
| **Enhanced Confirmation Screen** | Displays reservation content, Confirm / Correction buttons, returns to service selection when corrected |
| **Multilingual Support** | English and Japanese. WhatsApp defaults to Japanese; the Web UI initially defaults to English and persists the selected language. Chat language choices appear at the start |
| **Admin Panel** | Reservation management, notifications, recording, transcription, test link generation (admin token / user one-time URL) |
| **RBAC** | administrator / staff roles and assignment matching are implemented; see staff API and Socket.IO limitations below |
| **Video Call** | Responsive UI, background skin, screen sharing (admin only), reconnection, hangup |
| **Recording and Transcription** | Auto-record on guest join, stop recording and close the room when everyone leaves, and retrieve per-stream transcripts |

## Setup

Run commands from the repository root. **Node.js 24 LTS is recommended.** Although the root `engines` declares `>=20.0.0`, the current lockfile requires `^20.19.0 || >=22.12.0` for Vite 8 and `^22.12.0 || ^24.0.0 || >=26.0.0` for Vitest 5. Node.js 20.0–20.18 cannot run the current frontend toolchain.

```bash
npm ci
cp backend/.env.example backend/.env
```

Configure `backend/.env` (see [backend/.env.example](backend/.env.example)).

| Setting | Purpose |
|---|---|
| `MONGODB_URI` / `MONGODB_DB_NAME` | MongoDB connection; database name defaults to `video_reservation` |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | Admin JWT signing secret and expiry (default `1h`) |
| `VONAGE_VIDEO_APPLICATION_ID` / `VONAGE_VIDEO_PRIVATE_KEY_PATH` | Video sessions, tokens, and archives; relative key paths are resolved from `backend/` |
| `VONAGE_API_KEY` / `VONAGE_API_SECRET` / `VONAGE_APPLICATION_ID` / `VONAGE_PRIVATE_KEY_PATH` / `VONAGE_WHATSAPP_FROM` | Messages API credentials and WhatsApp sender; configure for your Application / Sandbox |
| `PUBLIC_APP_URL` | Public URL opened by users; set after configuring the tunnel |
| Three signature secrets | Webhook verification described below; required in production |

Configure MongoDB network access and the Vonage capabilities as well. Never commit private keys or `.env`.

## Scripts

- `npm run dev:backend` — Start backend development server
- `npm run dev:frontend` — Start frontend development server
- `npm run build:frontend` — Build the frontend into `frontend/dist`
- `npm run start --workspace=backend` — Start the backend without watch mode
- `npm run seed:user --workspace=backend -- --help` — Show account CLI usage
- `npm run test:backend` — Run backend Jest tests
- `npm run test:frontend` — Run frontend Vitest tests
- `npm test` — Run tests in both workspaces

Test counts and pass totals are not fixed guarantees. Some HTTP integration tests replace Vonage / MongoDB boundaries with mocks or stubs; integration tests do not uniformly require live Vonage credentials. For real delivery, calling, and archive checks, see the [manual E2E guide (Japanese)](docs/manual-e2e-recording-transcription.md).

## Architecture

- Domain layer (pure functions): `backend/src/domain/`
- Application layer: `backend/src/services/`
- Infrastructure layer: `backend/src/infra/`

See the English [Marp slides](docs/architecture-overview.marp.md), [PowerPoint](docs/architecture-overview.pptx), and [Japanese PowerPoint](docs/architecture-overview.ja.pptx).

## Local Vonage Webhook Setup (Cloudflare Tunnel)

Vonage Messages API (WhatsApp) cannot deliver webhooks directly to local `localhost`, so a public HTTPS tunnel is required. This uses Cloudflare's quick tunnel which is usable without an account.

### Webhook Endpoints (This Application)

The backend exposes 4 webhooks on `PORT=4000` (default):

| Type | Path | Method |
|------|------|--------|
| Inbound (Received) | `/webhooks/inbound-message` | POST |
| Status (Delivery Status) | `/webhooks/message-status` | POST |
| **Video Session Monitoring** | `/webhooks/video-events` | POST |
| **Video Archive Monitoring** | `/webhooks/video-archive-events` | POST |

### Procedure

1. Complete setup and configure `backend/.env`. Start the backend only once in the next step.

2. Build the frontend and start the backend.

    The entry link `/join/:tokenId` is a React Router client-side route, no HTML file exists. The backend delivers **built frontend** (with history fallback), so build first.

    ```bash
    # Build frontend (backend delivers frontend/dist)
    npm run build:frontend

    # Start backend
    npm run dev:backend
    # Health check: curl http://localhost:4000/health
    # Entry page: curl -I 'http://localhost:4000/join/example-token' → 200 text/html
    ```

    > If `frontend/dist` is missing, backend will not deliver SPA (development uses Vite dev server).
    > After code changes, re-run `npm run build:frontend`.
    > `/health` and `/api/health` only report HTTP server liveness. The server still starts after a MongoDB connection failure, so these endpoints do not establish database or Vonage readiness.

3. Install `cloudflared` and start the quick tunnel (no login or domain settings required).

    **Publish the backend (4000) as-is.** Both API and SPA can reach through this single tunnel.

    ```bash
    # macOS
    brew install cloudflared

    # Publish 4000 port (both API and SPA)
    cloudflared tunnel --url http://localhost:4000
    ```

    A public URL in the format `https://<random>.trycloudflare.com` will be displayed.

    Set the displayed URL to `backend/.env` and restart the backend:

    ```bash
    # backend/.env
    PUBLIC_APP_URL=https://<random>.trycloudflare.com
    ```

4. Enable Messages capability in Vonage Dashboard's Application, and use the displayed public URL to set the following (if testing in WhatsApp Sandbox, register the same 2 URLs in Messages API Sandbox screen as well).

    - **Inbound URL**: `https://<random>.trycloudflare.com/webhooks/inbound-message`
    - **Status URL**: `https://<random>.trycloudflare.com/webhooks/message-status`

5. Check the backend startup log for the following:

    ```
    [backend] public app url: https://<random>.trycloudflare.com
    ```

    A warning about `PUBLIC_APP_URL` indicates a missing or invalid setting; join-link issuance is rejected in this state. Diagnostic messages are currently in Japanese.

6. Send any message from WhatsApp (e.g., "Reservation" or "hello") and check the bot reply or processing logs. There is no built-in HTTP access logger. **No specific keyword is required** to start the reservation flow.

For Messages API Sandbox, set `VONAGE_MESSAGES_API_HOST=https://messages-sandbox.nexmo.com` and `WHATSAPP_INTERACTIVE_FALLBACK_TEXT=true`. The latter converts interactive output to text; it does not translate numeric replies back into option IDs. Text replies in Sandbox do not necessarily reproduce the production booking interaction.

### Entry Link Public URL (PUBLIC_APP_URL)

Separate from `CLIENT_ORIGIN` (for CORS allowance), specify the **URL that users actually open** using `PUBLIC_APP_URL`. The purposes are different.

| Environment | `PUBLIC_APP_URL` value | Notes |
|-------------|------------------------|-------|
| Test | `https://<random>.trycloudflare.com` | Cloudflare quick tunnel.**Changes with each restart**, so update `.env` and restart backend |
| Production | `https://<deployed-domain>` | Public application URL |

- Trailing slashes are removed when links are built. Subpaths are retained in the URL string, but React Router `basename` and corresponding deployment support are not configured. Serve the standard deployment at the public URL root.
- Unset values, loopback hosts (`localhost`, `127.0.0.1`, etc.), invalid URLs, and non-HTTP(S) schemes **reject link issuance** before a new token is stored. Startup also logs a warning. This validation applies to issuance, not redemption.
- Editing `.env` requires a backend restart. The join-link service reads the running process's `process.env.PUBLIC_APP_URL` on each issuance, while startup diagnostics and CORS use startup configuration.

### Frontend Delivery (SPA history fallback)

The entry link `/join/:tokenId` is a React Router client-side route, no corresponding HTML file exists. The backend delivers built frontend (`frontend/dist`), and returns `index.html` for unknown paths other than APIs (history fallback).

- **Run `npm run build:frontend` first.** If `frontend/dist` is missing, backend will not deliver SPA.
- `/api` `/auth` `/sessions` `/reservations` `/recordings` `/transcriptions` `/webhooks` `/monitoring` `/health` `/socket.io` are excluded from SPA history fallback, preserving API JSON responses and statuses such as 401/403/404.
- Front API base URL is **same origin** (`VITE_API_BASE_URL` unset = relative path). Delivered from the same origin as the backend, so users' smartphones don't need to refer to `localhost`.
- The current Vite dev proxy (5173) does not include `/reservations` or `/socket.io` (WebSocket). For separate frontend/backend development, set `VITE_API_BASE_URL=http://localhost:4000` in `frontend/.env.local`, restart Vite, and match `CLIENT_ORIGIN` to the frontend origin. Mobile devices need an externally reachable HTTPS backend URL. The same-origin tunnel setup above is recommended for normal end-to-end checks.

### Admin Account Creation (First-time only)

To log in to the Admin UI, a bcrypt-hashed user is required in the `users` collection. **No registration API is prepared**, so insert via CLI.

Do not put passwords in command arguments or literal command text. **Read the password without echoing, then pass it through a temporary environment variable** (Bash example):

```bash
read -r -s -p 'Password (12+ characters): ' USER_SEED_PASSWORD
printf '\n'
export USER_SEED_PASSWORD
npm run seed:user --workspace=backend -- --id admin --role administrator
unset USER_SEED_PASSWORD
```

To reset an existing user's password, enter the password again and replace the CLI invocation with `npm run seed:user --workspace=backend -- --id admin --force`.

| Argument | Description |
|----------|-------------|
| `--id <userId>` | Login ID (required, no spaces, unique) |
| `--role <role>` | `administrator` / `staff` (default `administrator`) |
| `--force` | Reset an existing password; if absent, create an `administrator` (`--role` is not applied) |
| `--help` | Display usage |

- Only the bcrypt hash is stored in the database. The CLI deletes the input from its own `process.env` after reading it; this is not a guarantee of secure memory erasure.
- `--force` does not change the role (rights). Existing rights are maintained.
- Minimum password length is 12 (`domain/validateUserInput.js` `MIN_PASSWORD_LENGTH`).

### Admin Password Storage Method

| Item | Detail |
|------|--------|
| **Storage location** | MongoDB `users` collection; database name comes from `MONGODB_DB_NAME` (default `video_reservation`) |
| **Document example** | `{ "_id": ObjectId("..."), "userId": "admin", "passwordHash": "$2a$12$...", "role": "administrator" }` |
| **Hash method** | **bcrypt (cost = 12)** (`$2a$12$...` format) |
| **Plain text handling** | Read from an environment variable and hashed by the CLI; plaintext is not stored in the database |
| **Logs / Environment variables** | The application does not log plaintext passwords. Temporary environment input, parent-shell cleanup, shell history, and process-environment exposure remain the operator's responsibility |

> **Note**: Do not write the administrator password in `backend/.env`. Literal passwords in command text can enter shell history even when passed as environment variables. Run `unset USER_SEED_PASSWORD` in the parent shell after use.

### Notes

- Quick tunnel URLs **change with each startup**. Update `PUBLIC_APP_URL` and all four Messages / Video webhook URLs after a restart. For a fixed URL, create a Named Tunnel (`cloudflared tunnel create`) with a custom domain in your Cloudflare account.
- **Signature verification**: Each Vonage function uses an independent signature secret. All must be set in production.

  | Capability | Environment variable | Dashboard setting |
  |---|---|---|
  | Messages API (WhatsApp) | `VONAGE_MESSAGES_SIGNATURE_SECRET` | Settings → Signed Webhooks |
  | Video Session Monitoring | `VONAGE_VIDEO_SESSION_MONITORING_SIGNATURE_SECRET` | Application → Video → Session Monitoring |
  | Video Archive Monitoring | `VONAGE_VIDEO_ARCHIVE_MONITORING_SIGNATURE_SECRET` | Application → Video → Archiving → Configure Callback URL |

- If unset (empty value), signature verification is skipped (for local development only. Must be set in production). If unset at `NODE_ENV=production`, becomes **fail-closed (503 rejection)**.
- Messages API webhook always delivers as `POST` with JSON body.

### About Screen Sharing (Chrome Tab / Safari, etc.)

This application's admin screen "Document/Screen Share" button uses Vonage Video SDK's `videoSource: 'screen'`. Internally, it calls browser standard `navigator.mediaDevices.getDisplayMedia()`.

**This application uses SDK screen capture, not an extension integration.**

The application has no extension registration code. Available screen, window, and tab sources depend on the browser, OS, and Vonage SDK support. In particular, mobile browsers and Safari may not offer the same sharing capabilities as desktop Chrome.

**Notes**:
- Choose from the sources actually offered by the browser's share picker
- HTTPS required (`getDisplayMedia` only works in secure context). Use Cloudflare Tunnel etc. for HTTPS in development.

### Local Direct Smoke Test (Assuming signature secrets are empty)

```bash
curl -s -X POST http://localhost:4000/webhooks/inbound-message \
  -H 'content-type: application/json' \
  -d '{"from":"1234567890","text":"Reservation"}'
```

> The `text` value is just an example. **No specific keyword is required** to start the reservation flow; the first message can be anything. (Using "Reservation" in integration tests is just a convention/sample.)

This check assumes a non-production `NODE_ENV` and empty signature secrets. Even a local HTTP request runs the normal bot logic and attempts a real WhatsApp reply. Replace `from` with a test recipient you control; checking the reply requires configured Messages API credentials and sender.

## Vonage Video Application Settings (Features Used This Time)

This application's Video features use server-side SDK calls **and** receive Vonage Video callbacks (webhooks). In particular, **auto-recording on guest join and recording stop at meeting end depend on the Session Monitoring callback**, so the callback URLs must be configured in the Vonage dashboard. Authentication credentials (Application ID + private key) alone are not sufficient.

### Features Used with Video API This Time and Implementation Method

| Function | Implementation Method | Webhook Required |
|----------|----------------------|-----------------|
| Session creation / token issuance | `createSession` / `generateClientToken` (embed userId/role in connection data, speaker ↔ stream mapping) | Not required |
| Video room lifecycle | `POST /webhooks/video-events` (Session Monitoring): `connectionCreated` → auto-start recording on guest join; `connectionDestroyed` → stop recording and close the room when everyone leaves | **Required** |
| Recording (archive) start/stop | Automatic control or SDK calls through `POST /recordings/start` / `POST /recordings/:archiveId/stop`; Archive Monitoring handles status and follow-up processing | Recommended for live status |
| Speaker-separated transcription | Individual stream archive (`outputMode: individual` + `hasTranscription`); auto-fetch on `available` / `uploaded` callbacks, or fetch through `GET /transcriptions/:archiveId` and format with `groupBySpeaker` | Recommended for auto-fetch |

### Callback URLs (Implemented in This Application)

Vonage Video Application has optional callback URL fields inside **Capabilities → Video**.

| Function | Path | Implementation in This Application |
|---|---|---|
| **Session Monitoring** | `/webhooks/video-events` | ✅ Implemented (`connectionCreated` / `connectionDestroyed` for room lifecycle management) |
| **Archive Monitoring** | `/webhooks/video-archive-events` | ✅ Status events; fetch transcription on `available` / `uploaded`, confirm stop handling on `stopped`, log failures on `failed` |

This application implements **both**. Configure each callback URL in the Vonage dashboard.

### Setup (Dashboard)

1. [Vonage API Dashboard](https://dashboard.nexmo.com/) → **Applications** → select the Video-enabled application.
2. Enable **Capabilities → Video**.
3. In the **Session Monitoring** section, set the Callback URL:
   - URL: `https://<public URL>/webhooks/video-events`
   - Signature Secret: the same value as `VONAGE_VIDEO_SESSION_MONITORING_SIGNATURE_SECRET`
4. In the **Archiving** section, set the Callback URL:
   - URL: `https://<public URL>/webhooks/video-archive-events`
   - Signature Secret: the same value as `VONAGE_VIDEO_ARCHIVE_MONITORING_SIGNATURE_SECRET`
5. Obtain the application's **Application ID** and **private key** and set them in `backend/.env`.

```bash
VONAGE_VIDEO_APPLICATION_ID=<Video enabled Application ID>
VONAGE_VIDEO_PRIVATE_KEY_PATH=./vonage_video_private.key   # Path to downloaded private key
```

> Messages (WhatsApp) and Video can be grouped in the same Application or separated into different Applications. If separated, set the Messages ones (`VONAGE_APPLICATION_ID` / `VONAGE_PRIVATE_KEY_PATH`) and the Video ones (`VONAGE_VIDEO_APPLICATION_ID` / `VONAGE_VIDEO_PRIVATE_KEY_PATH`) respectively.

---

## Notification Scheduler Configuration (Notification Scheduler)

The backend polls three notification types using `node-cron`. These run on the next scheduled poll, not necessarily at an exact offset before the appointment.

### 1. Reservation Time Arrival Notification (`reservation:due`)
- **Schedule**: `NOTIFICATION_CRON` (default: every minute `* * * * *`)
- **Target**: `reservationTime <= now` and `notified !== true`. The current implementation does not filter by reservation status; cancelled or completed reservations can also qualify
- **Operation**: WhatsApp sending (with entry link) + Socket.IO `reservation:due` event emission
- **Double Prevention**: Update to `notified = true` after sending

### 2. Advance Reminder (`reservation:reminder`)
- **Schedule**: `NOTIFICATION_REMINDER_CRON` (default: every hour at 0 min `0 * * * *`)
- **Target**: `reservationTime > now` and `reservationTime - now <= windowMs` and `reminderSent !== true` and `status === 'confirmed'`
- **Window**: `NOTIFICATION_REMINDER_WINDOW_MS` (default: 24 hours = 86400000 ms)
- **Operation**: WhatsApp reminder without a join link + Socket.IO `reservation:reminder` emission. The current AdminPage does not subscribe to this event
- **Double Prevention**: Update to `reminderSent = true` after sending

### 3. Within-10-Minute Reminder (`reservation:tenMinReminder`)
- **Schedule**: `NOTIFICATION_TEN_MIN_REMINDER_CRON` (default: every minute `* * * * *`)
- **Target**: `status === 'confirmed'`, `tenMinReminderSent !== true`, and `0 < reservationTime - now <= windowMs`
- **Window**: `NOTIFICATION_TEN_MIN_REMINDER_WINDOW_MS` (default: 600000 ms = 10 minutes), not "10 minutes before ± 5 minutes"
- **Operation**: WhatsApp join URL button (`cta_url`, or a text URL with Sandbox fallback) + admin event; browser notifications require browser support and permission
- **Double Prevention**: Update `tenMinReminderSent = true`, independently of the within-24-hour reminder flag

Manual admin re-notification uses `POST /reservations/:id/resend-notification` to send a new join link, and emits `reservation:manualJoinLink` on success.

### Environment Variables (`backend/.env`)
```bash
# Arrival notification scheduler (recommended every minute execution)
NOTIFICATION_CRON=* * * * *

# Reminder notification scheduler (default: every hour at 0 min. */15 * * * * etc. also possible in production)
NOTIFICATION_REMINDER_CRON=0 * * * *

# Reminder window (ms). Default 24h = 86400000
NOTIFICATION_REMINDER_WINDOW_MS=86400000

# Within-10-minute reminder (polled every minute)
NOTIFICATION_TEN_MIN_REMINDER_CRON=* * * * *
NOTIFICATION_TEN_MIN_REMINDER_WINDOW_MS=600000
```

### Partial Failure Tolerance (Requirement 3.4)
- Scheduled notifications attempt Socket.IO emission and update the notification flag even after a WhatsApp exception. This does not guarantee delivery or implement automatic retries
- Flags are updated after sending; failed updates, concurrent polls, or multiple processes can still cause duplicate delivery
- `whatsappFailures` counts thrown exceptions. The due and advance senders use `sendText`, which returns `{ ok: false }` on failure; such failures may be logged by the client without appearing in this counter

## Current Implementation Limitations

- **Time and slot candidates**: Admin slot APIs use JST calendar days. WhatsApp date/time candidates use the default UTC basis in some paths, while selected times are resolved as JST. The empty-candidate fallback spans three days including the selected date and can reintroduce past slots. Future-only candidates are not guaranteed.
- **State**: Chat conversation state and active archive ID mappings are process-local. Shared state for restarts and horizontal scaling is not implemented.
- **Staff authorization**: Roles and assignment matching exist, but some APIs derive ownership from requests. List APIs do not resolve assignment from persisted reservations, so normal staff requests may receive 403. Assignment handling is not complete across all APIs.
- **Socket.IO**: The client sends a JWT, but server-side handshake authentication and assignment-scoped rooms are not implemented. Events use `io.emit` to broadcast to all connections. Access control is required before public deployment.
- **Guest access**: In addition to one-time links, `POST /sessions/:id/guest-token` is available without a JWT and checks for a non-cancelled reservation and room state. Not every guest entry path requires a one-time link.
- **Transcription**: Speaker separation is channel / stream-based, not diarization of multiple speakers in one stream. Some development archive-list paths return mock data after external API failures; seeing a list entry does not establish that a real recording succeeded.