const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "8h";

async function hashPassword(plain) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plain, salt);
}

function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function issueToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET); // throws if invalid/expired
}

// Express middleware — protects REST routes
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    req.user = verifyToken(token);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Socket.io middleware — protects the signaling connection itself,
// so only authenticated users can join rooms or exchange signals.
function socketAuth(socket, next) {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Missing auth token"));
  try {
    socket.user = verifyToken(token);
    next();
  } catch (err) {
    next(new Error("Invalid or expired token"));
  }
}

module.exports = {
  hashPassword,
  comparePassword,
  issueToken,
  verifyToken,
  requireAuth,
  socketAuth,
};
