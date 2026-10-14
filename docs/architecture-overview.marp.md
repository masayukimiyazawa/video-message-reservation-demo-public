---
marp: true
theme: default
size: 16:9
paginate: true
---
<style>
section { background: #0b1220; color: #e8eef8; font-family: Aptos, Arial, sans-serif; font-size: 21px; padding: 42px 54px; }
h1, h2, h3 { color: #f8fafc; }
h1 { font-size: 46px; margin-bottom: 18px; }
h2 { font-size: 34px; margin-bottom: 18px; }
h3 { color: #67e8f9; font-size: 23px; }
strong { color: #67e8f9; }
table { font-size: 17px; }
th { background: #17243a; color: #67e8f9; }
td, th { border-color: #334155; padding: 7px 10px; }
section table tbody tr td { background: #111c2e; color: #e8eef8; }
section table tbody tr:nth-child(even) td { background: #17243a; }
section table code { background: #263750; color: #f8fafc; }
section::after { color: #94a3b8; font-size: 13px; }
.eyebrow { color: #67e8f9; font-size: 18px; letter-spacing: 0.12em; }
.subtitle { color: #b9c7d9; font-size: 25px; }
.muted { color: #a6b5c9; font-size: 16px; }
.diagram { text-align: center; }
.diagram img { max-width: 100%; max-height: 485px; object-fit: contain; }
.diagram-wide img { max-height: 455px; }
.columns { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.card { background: #111c2e; border: 1px solid #263750; border-radius: 12px; padding: 14px 20px; }
.small { font-size: 17px; }
</style>

<!-- _class: lead -->
<!-- _paginate: false -->

<div class="eyebrow">SYSTEM ARCHITECTURE / 2026</div>

# Video Message Reservation
## From booking to a secure video session

<div class="subtitle">Vonage Video API × WhatsApp × React / Express</div>

<br>

<div class="muted">Architecture overview based on the repository implementation</div>

---

## 1. System overview

**Book through WhatsApp, then join a video session from a secure link when the appointment is due.**

<div class="columns">
<div class="card">

### Customer (WhatsApp)
- Choose a service and time through an interactive chat
- Confirm an available appointment
- Receive reminders and a join link in WhatsApp
- Join the reserved session with a guest token

</div>
<div class="card">

### Administrator and staff (Web)
- Manage appointments in a React admin console
- Receive live booking and recording status updates
- Operate Vonage Video calls, archives, and transcripts
- Use JWT, role, and assignment-based access control

</div>
</div>

<br>

**MongoDB Atlas stores core business data. Vonage Video API provides sessions, recording, and transcription.**

<div class="muted">Stack: Node.js / Express · React / Vite · Mongoose · Socket.IO · Vonage Messages and Video APIs</div>

---

## 2. System architecture

<div class="diagram diagram-wide">
<img src="./slide-assets/architecture.svg" alt="System architecture diagram">
</div>

<div class="muted">REST and Socket.IO share one Node.js HTTP server. The backend can also serve the built SPA.</div>

<!-- Mermaid source: ./slide-assets/architecture.mmd -->

---

## 3. Booking flow

<div class="diagram">
<img src="./slide-assets/reservation-sequence.svg" alt="WhatsApp reservation sequence diagram">
</div>

<div class="muted">Webhook receipt is acknowledged separately from the chat reply. Conversation state is keyed by sender.</div>

<!-- Mermaid source: ./slide-assets/reservation-sequence.mmd -->

---

## 4. Notifications and joining a video session

<div class="diagram">
<img src="./slide-assets/notification-session-sequence.svg" alt="Notification and video session sequence diagram">
</div>

<div class="muted">node-cron polls due and reminder bookings. WhatsApp and Socket.IO notifications are independent.</div>

<!-- Mermaid source: ./slide-assets/notification-session-sequence.mmd -->

---

## 5. Core data structures

| Entity | Key fields | Purpose |
|---|---|---|
| **Reservation** | `reservationId`, `contact`, `reservationTime`, `service`, `status`, `language`, `sessionId`, `assignedStaffId` | Connects a booking, a video session, and its assigned staff |
| **Notification flags** | `notified`, `reminderSent`, `tenMinReminderSent` | Track delivery independently for each notification type |
| **JoinToken** | `tokenId`, `reservationId`, `sessionId`, `expiresAt`, `consumedAt`, `invalidatedAt` | Expiring, one-time guest access; expired records are removed by MongoDB TTL |
| **SessionPresence** | `sessionId`, `connections[]`, `openedAt`, `closedAt` | Track participants and determine when a room is closed |
| **User** | `userId`, `role`, `passwordHash` | Authenticate `administrator` and `staff`; passwords are bcrypt-hashed |

<br>

<div class="muted"><strong>Note:</strong> DTO stands for <strong>Data Transfer Object</strong>. A reservation DTO carries contact, appointment time, service, and language from the chat to the reservation service.</div>

<div class="muted">Reservation statuses: pending / confirmed / cancelled / completed. Languages: en / ja.</div>

<div class="muted">In-progress chat state currently lives in a process-local Map keyed by sender, not in persistent storage.</div>

---

## 6. API surface and boundaries

| Area | Main endpoints | Access and behavior |
|---|---|---|
| Authentication | `POST /auth/login` | Public; returns a JWT on success |
| WhatsApp | `POST /webhooks/inbound-message`<br>`POST /webhooks/message-status` | Verify Vonage signatures; handle chat and delivery status |
| Reservations | `GET/POST /reservations`<br>`PATCH/DELETE /reservations/:id` | JWT required; administrator or assigned staff |
| Video access | `POST /sessions/:id/token`<br>`POST /sessions/:id/guest-token`<br>`POST /sessions/join/:tokenId` | Staff JWT, active reservation, or one-time guest link |
| Recording and transcript | `POST /recordings/start`<br>`POST /recordings/:archiveId/stop`<br>`GET /transcriptions/:archiveId` | JWT and action authorization; delegates to Video API |
| Video monitoring | `POST /webhooks/video-events`<br>`POST /webhooks/video-archive-events` | Synchronize room presence and archive status |

<br>

**Real-time events** use Socket.IO on the same HTTP server (for example, `reservation:due` and `recording:status`), separately from REST responses.

---

## 7. Design strengths

<div class="columns">
<div class="card">

### Separation of concerns
- Pure decisions and transformations in `domain/`
- Application use cases in `services/`
- MongoDB and Vonage adapters in `infra/`
- Dependency injection makes services and routes testable

</div>
<div class="card">

### Protected integration boundaries
- Signature verification for provider webhooks
- JWT, roles, and staff assignment authorization
- Reservation-backed guest token issuance
- One-time join tokens with expiry and room invalidation

</div>
</div>

<br>

### Operationally integrated lifecycle
- Admin Socket.IO updates continue independently of WhatsApp delivery
- Same-origin SPA hosting simplifies mobile join links
- Video recording, transcripts, and monitoring are connected to the admin experience

---

## 8. Improvement opportunities and takeaway

<div class="columns">
<div class="card small">

### High priority: multi-instance readiness
Chat state is held in a process-local Map, so restarts and horizontal scaling can lose in-progress conversations. Move it to Redis or another shared store; use distributed coordination and idempotency for scheduled notifications.

### Medium priority: operability
Add structured logs, correlation IDs across webhooks and provider calls, retry handling, and failure/backlog monitoring.

</div>
<div class="card small">

### Medium priority: API and session boundaries
Document request schemas and API contracts, add rate limits, and make webhook replay handling idempotent. Base all staff ownership checks on persisted reservation data.

### Takeaway
**The system unifies booking, messaging, and video-session lifecycle in one business flow** while separating domain, application, and infrastructure responsibilities. Persistent state and distributed execution are the main next steps for scale.

</div>
</div>

<br>

<div class="muted">Source: repository README and backend/src + frontend/src implementation. Improvement items are recommendations based on the current implementation.</div>
