# Plune_call — Real-Time Communication App

A starter video conferencing + collaboration tool: multi-user video calls,
screen sharing, a shared whiteboard, file sharing, and JWT-based auth.

## Stack

- **Backend:** Node.js, Express, Socket.io (signaling only — media is peer-to-peer)
- **Frontend:** Vanilla HTML/CSS/JS + native `RTCPeerConnection` API (no build step)
- **Auth:** JWT + bcrypt, users stored in `data/users.json` (swap for a real DB later)
- **Topology:** WebRTC mesh (good for small groups, ~2–6 people)

## Setup

```bash
cd Plune_call
npm install
copy .env.example .env   # then edit JWT_SECRET to something long & random
npm start
```

Open `http://localhost:3000` in two different browser windows (or two
devices on the same network — see the HTTPS note below) to test a call.

Usernames must be 3–32 characters using letters, numbers, `_`, or `-`.
Room names use the same characters and are limited to 80 characters. File
sharing supports files up to 8 MB.

## How it works

1. **Auth** — `/api/register` and `/api/login` issue a JWT, stored in
   `localStorage`. The Socket.io connection sends that JWT during the
   handshake (`server/auth.js` → `socketAuth`), so only logged-in users can
   join rooms or exchange signaling data.
2. **Signaling** — `server/server.js` relays WebRTC offers/answers/ICE
   candidates between peers over Socket.io (see the `signal` event). The
   server never sees your audio/video — only this connection-setup metadata.
3. **Video mesh** — each participant opens a direct `RTCPeerConnection` to
   every other participant. New joiners fetch the list of existing users and
   initiate the offers (see `existing-users` / `user-joined` in `room.js`).
4. **Screen sharing** — swaps the outgoing video track
   (`RTCRtpSender.replaceTrack`) from the camera to `getDisplayMedia()`,
   and swaps it back when sharing stops.
5. **Whiteboard** — a `<canvas>` where draw events (line segments) are
   broadcast to the room via Socket.io and replayed on every client. Simple
   and good enough for a small group; see "Next steps" for real conflict-free
   collaborative editing.
6. **File sharing** — files are read as base64 client-side and relayed
   through Socket.io to the room (capped at ~8MB in `server.js`). Fine for a
   prototype; see "Next steps" for a more scalable approach.

## Security notes

- **Media encryption**: WebRTC encrypts all audio/video/data traffic with
  DTLS-SRTP automatically — this isn't something you implement yourself.
- **Transport**: `getUserMedia`/`getDisplayMedia` require a secure context.
  This works on `http://localhost` for local dev, but **any other host needs
  HTTPS** — e.g. put this behind a reverse proxy (Caddy/Nginx) with a real
  cert, or use a tool like [mkcert](https://github.com/FiloSottile/mkcert)
  for local HTTPS testing across devices.
- **Passwords**: hashed with bcrypt, never stored or sent in plaintext.
- **Tokens**: short-lived JWTs (`JWT_EXPIRES_IN` in `.env`); rotate
  `JWT_SECRET` and keep it out of source control.
- `helmet` is enabled with CSP disabled for simplicity — tighten this
  (proper `contentSecurityPolicy` config) before deploying anywhere real.

## Known limitations / next steps

- **Scaling past ~6 people**: mesh means every participant uploads their
  stream N-1 times. For larger rooms, introduce an SFU (e.g.
  [mediasoup](https://mediasoup.org/) or [LiveKit](https://livekit.io/)) so
  each client only uploads once.
- **NAT traversal**: only a public STUN server is configured
  (`stun.l.google.com`). Some networks (symmetric NATs, restrictive
  firewalls) will fail to connect without a **TURN** server — run your own
  with [coturn](https://github.com/coturn/coturn) for production use.
- **File sharing at scale**: base64-over-Socket.io works for small files but
  wastes bandwidth (~37% overhead) and holds the payload in server memory
  briefly. For larger files, either send over a WebRTC DataChannel
  (peer-to-peer, no server involved) or upload to object storage (S3) and
  share a link.
- **Whiteboard conflict resolution**: the current broadcast approach works
  fine for a handful of users; for many simultaneous editors without
  glitches, look at CRDT libraries like [Yjs](https://yjs.dev/).
- **Persistence**: users are stored in a flat JSON file — replace
  `server/db.js` with MongoDB/PostgreSQL before this goes anywhere near
  production, and add per-room chat/whiteboard history if you want it to
  survive a refresh.

## Project structure

```
Plune_call/
├── package.json
├── .env.example
├── server/
│   ├── server.js      # Express routes + Socket.io signaling/whiteboard/file relay
│   ├── auth.js         # JWT + bcrypt helpers, Express & Socket.io auth middleware
│   └── db.js           # Minimal JSON-file user store
├── data/
│   └── users.json       # Created automatically on first registration
└── public/
    ├── index.html       # Login / register
    ├── room.html         # Call UI: video grid, controls, whiteboard, file list
    ├── css/style.css
    └── js/
        ├── api.js       # Auth calls
        └── room.js      # WebRTC mesh, screen share, whiteboard, file sharing
```
