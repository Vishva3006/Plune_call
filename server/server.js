require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const db = require("./db");
const {
  hashPassword,
  comparePassword,
  issueToken,
  requireAuth,
  socketAuth,
} = require("./auth");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // File sharing uses a base64 data URL, so allow a little headroom over the
  // documented 8 MB file limit.
  maxHttpBufferSize: 11 * 1024 * 1024,
  // Same-origin by default since we serve the frontend from this server.
  // If you split frontend/backend, restrict this to your frontend's origin.
  cors: { origin: "*" },
});

app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled for demo simplicity; configure properly for production
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// ---------- Auth routes ----------

app.post("/api/register", async (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username) || password.length < 6) {
    return res
      .status(400)
      .json({ error: "Username must be 3-32 letters, numbers, underscores, or hyphens, and the password must be 6+ characters" });
  }
  if (db.findUserByUsername(username)) {
    return res.status(409).json({ error: "Username already taken" });
  }
  const passwordHash = await hashPassword(password);
  const user = { id: crypto.randomUUID(), username, passwordHash };
  db.addUser(user);
  const token = issueToken(user);
  res.json({ token, username: user.username });
});

app.post("/api/login", async (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const user = db.findUserByUsername(username);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const ok = await comparePassword(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });
  const token = issueToken(user);
  res.json({ token, username: user.username });
});

// Example of a protected route, in case you add more REST endpoints later
app.get("/api/me", requireAuth, (req, res) => {
  res.json({ username: req.user.username });
});

// JSON Error Handling Middleware
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({ error: "Invalid JSON body format" });
  }
  console.error("Server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ---------- Socket.io: signaling, whiteboard, file relay ----------

io.use(socketAuth);

// roomId -> Map<socketId, username>
const rooms = new Map();

io.on("connection", (socket) => {
  const username = socket.user.username;

  socket.on("join-room", (roomId) => {
    if (typeof roomId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(roomId)) {
      socket.emit("room-error", { message: "Room names may contain only letters, numbers, underscores, and hyphens (max 80 characters)." });
      return;
    }
    const previousRoomId = socket.data.roomId;
    if (previousRoomId && previousRoomId !== roomId) {
      const previousRoom = rooms.get(previousRoomId);
      previousRoom?.delete(socket.id);
      if (previousRoom?.size === 0) rooms.delete(previousRoomId);
      socket.leave(previousRoomId);
      socket.to(previousRoomId).emit("user-left", { socketId: socket.id, username });
    }
    socket.data.roomId = roomId;
    socket.join(roomId);

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const room = rooms.get(roomId);

    // Tell the newcomer who's already here (they'll initiate offers to each)
    const existingUsers = Array.from(room.entries()).map(([id, name]) => ({
      socketId: id,
      username: name,
    }));
    socket.emit("existing-users", existingUsers);

    room.set(socket.id, username);

    // Tell everyone else a new peer joined (they'll wait for an offer)
    socket.to(roomId).emit("user-joined", {
      socketId: socket.id,
      username,
    });
  });

  // WebRTC signaling relay: offers, answers, ICE candidates.
  // Media itself never touches this server — only this handshake metadata does.
  socket.on("signal", ({ to, data }) => {
    const roomId = socket.data.roomId;
    if (!roomId || typeof to !== "string" || !data || !io.sockets.sockets.get(to)?.rooms.has(roomId)) return;
    io.to(to).emit("signal", {
      from: socket.id,
      username,
      data,
    });
  });

  // Whiteboard: broadcast draw/clear events to everyone else in the room
  socket.on("whiteboard-draw", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId || !payload || !Number.isFinite(payload.x0) || !Number.isFinite(payload.y0) ||
        !Number.isFinite(payload.x1) || !Number.isFinite(payload.y1) ||
        !Number.isFinite(payload.width) || payload.width < 1 || payload.width > 20 ||
        typeof payload.color !== "string" || !/^#[0-9a-f]{6}$/i.test(payload.color)) return;
    socket.to(roomId).emit("whiteboard-draw", {
      x0: payload.x0, y0: payload.y0, x1: payload.x1, y1: payload.y1,
      color: payload.color, width: payload.width,
    });
  });

  socket.on("whiteboard-clear", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit("whiteboard-clear");
  });

  // File sharing: small/medium files relayed as base64 through the server.
  // Fine for a prototype; for large files, switch to a WebRTC DataChannel
  // (peer-to-peer) or an upload-to-S3-then-share-a-link flow.
  socket.on("file-share", (payload = {}) => {
    const roomId = socket.data.roomId;
    const { fileName, fileType, fileData } = payload;
    if (!roomId || typeof fileName !== "string" || !fileName.trim() ||
        fileName.length > 255 || typeof fileData !== "string" ||
        !/^data:[^;,]{1,100};base64,[A-Za-z0-9+/=\r\n]+$/.test(fileData)) {
      socket.emit("file-share-error", { message: "Invalid file payload." });
      return;
    }
    const MAX_BYTES = 8 * 1024 * 1024; // ~8MB safety cap for this relay approach
    const base64 = fileData.slice(fileData.indexOf(",") + 1).replace(/\s/g, "");
    const decodedBytes = Math.floor(base64.length * 3 / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
    if (decodedBytes > MAX_BYTES) {
      // base64 inflates size ~37%; reject oversized payloads early
      socket.emit("file-share-error", { message: "File too large for relay (max ~8MB)." });
      return;
    }
    socket.to(roomId).emit("file-share", {
      fileName,
      fileType: typeof fileType === "string" ? fileType.slice(0, 100) : "application/octet-stream",
      fileData,
      fromUsername: username,
    });
  });

  // Chat message relay
  socket.on("chat-message", (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || typeof payload.text !== "string" || !payload.text.trim()) return;
    const text = payload.text.slice(0, 1000).trim();
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    io.to(roomId).emit("chat-message", {
      id: crypto.randomUUID(),
      sender: username,
      text,
      time,
    });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room) {
      room.delete(socket.id);
      if (room.size === 0) rooms.delete(roomId);
    }
    socket.to(roomId).emit("user-left", { socketId: socket.id, username });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`RTC app listening on http://localhost:${PORT}`);
  console.log("Note: getUserMedia/getDisplayMedia require HTTPS on any host other than localhost.");
});
