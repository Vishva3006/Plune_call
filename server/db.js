// Minimal file-backed "database" for demo purposes.
// Swap this out for MongoDB/PostgreSQL when you move past a prototype.
const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "users.json");

function readUsers() {
  if (!fs.existsSync(DB_PATH)) return [];
  const raw = fs.readFileSync(DB_PATH, "utf-8").trim();
  return raw ? JSON.parse(raw) : [];
}

function writeUsers(users) {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2));
}

function findUserByUsername(username) {
  return readUsers().find((u) => u.username === username);
}

function addUser(user) {
  const users = readUsers();
  users.push(user);
  writeUsers(users);
  return user;
}

module.exports = { readUsers, writeUsers, findUserByUsername, addUser };
