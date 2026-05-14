
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const STORE = process.env.STORAGE_DIR || __dirname;
const DATA = path.join(STORE, "data");
const UPLOADS = path.join(STORE, "uploads");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true }, maxHttpBufferSize: 1e7 });

const sessionMw = session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: DATA }),
  secret: process.env.SESSION_SECRET || "change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 24 * 30 }
});

const db = new Database(path.join(DATA, "chorus.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  bio TEXT DEFAULT '',
  avatar TEXT DEFAULT '/default-avatar.svg'
);
CREATE TABLE IF NOT EXISTS friends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL,
  addressee_id INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  UNIQUE(requester_id, addressee_id)
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT DEFAULT 'dm',
  name TEXT,
  owner_id INTEGER
);
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY(chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  edited INTEGER DEFAULT 0,
  deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  PRIMARY KEY(message_id, user_id, emoji)
);
`);

app.use(express.json({ limit: "2mb" }));
app.use(sessionMw);
io.engine.use(sessionMw);
app.use("/uploads", express.static(UPLOADS));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS),
    filename: (req, file, cb) => cb(null, `avatar-${req.session.userId}-${Date.now()}${path.extname(file.originalname || ".png")}`)
  }),
  limits: { fileSize: 4 * 1024 * 1024 }
});

const norm = v => String(v || "").trim().toLowerCase().replace(/[^a-z0-9_.]/g, "").slice(0, 24);
const publicUser = id => db.prepare("SELECT id, username, display_name, bio, avatar FROM users WHERE id=?").get(id);
const requireAuth = (req, res, next) => req.session.userId ? next() : res.status(401).json({ error: "Not logged in" });
const canChat = (uid, cid) => !!db.prepare("SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?").get(cid, uid);
const areFriends = (a, b) => !!db.prepare(`
  SELECT 1 FROM friends WHERE status='accepted'
  AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))
`).get(a, b, b, a);

function getOrCreateDM(a, b) {
  const row = db.prepare(`
    SELECT c.id FROM chats c
    JOIN chat_members x ON x.chat_id=c.id
    JOIN chat_members y ON y.chat_id=c.id
    WHERE c.type='dm' AND x.user_id=? AND y.user_id=?
  `).get(a, b);
  if (row) return row.id;
  const info = db.prepare("INSERT INTO chats(type, owner_id) VALUES('dm', ?)").run(a);
  db.prepare("INSERT INTO chat_members(chat_id,user_id) VALUES(?,?)").run(info.lastInsertRowid, a);
  db.prepare("INSERT INTO chat_members(chat_id,user_id) VALUES(?,?)").run(info.lastInsertRowid, b);
  return info.lastInsertRowid;
}

function chatMembers(cid) {
  return db.prepare(`
    SELECT u.id, u.username, u.display_name, u.bio, u.avatar
    FROM chat_members cm JOIN users u ON u.id=cm.user_id
    WHERE cm.chat_id=? ORDER BY u.display_name COLLATE NOCASE
  `).all(cid);
}

function chatSummary(cid, uid) {
  const c = db.prepare("SELECT * FROM chats WHERE id=?").get(cid);
  const members = chatMembers(cid);
  const last = db.prepare("SELECT body FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 1").get(cid);
  let title = c.name || "Group";
  let avatar = "/default-avatar.svg";
  if (c.type === "dm") {
    const other = members.find(m => m.id !== uid) || members[0];
    title = other ? other.display_name : "DM";
    avatar = other ? other.avatar : avatar;
  }
  return { id: c.id, type: c.type, title, avatar, members, last };
}

function messageWithUser(id) {
  const m = db.prepare(`
    SELECT m.*, u.username, u.display_name, u.avatar
    FROM messages m JOIN users u ON u.id=m.sender_id
    WHERE m.id=?
  `).get(id);
  if (!m) return null;
  m.reactions = db.prepare("SELECT emoji, COUNT(*) AS count FROM reactions WHERE message_id=? GROUP BY emoji").all(id);
  return m;
}

function notifyChat(cid, event, payload) {
  db.prepare("SELECT user_id FROM chat_members WHERE chat_id=?").all(cid).forEach(row => {
    io.to(`user:${row.user_id}`).emit(event, payload);
  });
}

app.post("/api/register", async (req, res) => {
  const username = norm(req.body.username);
  const password = String(req.body.password || "");
  const displayName = String(req.body.displayName || username).trim().slice(0, 32);
  if (username.length < 3) return res.status(400).json({ error: "Username must be at least 3 characters." });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  if (db.prepare("SELECT 1 FROM users WHERE username=?").get(username)) return res.status(409).json({ error: "That username is already claimed." });
  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare("INSERT INTO users(username,display_name,password_hash) VALUES(?,?,?)").run(username, displayName, hash);
  req.session.userId = info.lastInsertRowid;
  res.json({ user: publicUser(info.lastInsertRowid) });
});

app.post("/api/login", async (req, res) => {
  const found = db.prepare("SELECT * FROM users WHERE username=?").get(norm(req.body.username));
  if (!found || !(await bcrypt.compare(String(req.body.password || ""), found.password_hash))) return res.status(401).json({ error: "Wrong username or password." });
  req.session.userId = found.id;
  res.json({ user: publicUser(found.id) });
});

app.post("/api/logout", requireAuth, (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/me", requireAuth, (req, res) => res.json({ user: publicUser(req.session.userId) }));

app.put("/api/me", requireAuth, (req, res) => {
  db.prepare("UPDATE users SET display_name=?, bio=? WHERE id=?").run(
    String(req.body.displayName || "").trim().slice(0, 32),
    String(req.body.bio || "").trim().slice(0, 180),
    req.session.userId
  );
  res.json({ user: publicUser(req.session.userId) });
});

app.post("/api/me/avatar", requireAuth, upload.single("avatar"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Upload an image file." });
  db.prepare("UPDATE users SET avatar=? WHERE id=?").run(`/uploads/${req.file.filename}`, req.session.userId);
  res.json({ user: publicUser(req.session.userId) });
});

app.post("/api/friends/request", requireAuth, (req, res) => {
  const target = db.prepare("SELECT id FROM users WHERE username=?").get(norm(req.body.username));
  if (!target) return res.status(404).json({ error: "User not found." });
  if (target.id === req.session.userId) return res.status(400).json({ error: "You cannot add yourself." });

  const old = db.prepare(`
    SELECT * FROM friends
    WHERE (requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)
  `).get(req.session.userId, target.id, target.id, req.session.userId);

  if (old && old.status === "pending" && old.addressee_id === req.session.userId) {
    db.prepare("UPDATE friends SET status='accepted' WHERE id=?").run(old.id);
    getOrCreateDM(req.session.userId, target.id);
  } else if (!old) {
    db.prepare("INSERT INTO friends(requester_id, addressee_id, status) VALUES(?,?, 'pending')").run(req.session.userId, target.id);
  }

  io.to(`user:${target.id}`).emit("friends:update");
  io.to(`user:${req.session.userId}`).emit("friends:update");
  res.json({ ok: true });
});

app.post("/api/friends/respond", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM friends WHERE id=? AND addressee_id=? AND status='pending'").get(Number(req.body.requestId), req.session.userId);
  if (!row) return res.status(404).json({ error: "Request not found." });
  const status = req.body.action === "accept" ? "accepted" : "declined";
  db.prepare("UPDATE friends SET status=? WHERE id=?").run(status, row.id);
  if (status === "accepted") getOrCreateDM(row.requester_id, row.addressee_id);
  [row.requester_id, row.addressee_id].forEach(id => {
    io.to(`user:${id}`).emit("friends:update");
    io.to(`user:${id}`).emit("chats:update");
  });
  res.json({ ok: true });
});

app.get("/api/friends", requireAuth, (req, res) => {
  const uid = req.session.userId;
  const friends = db.prepare(`
    SELECT u.id,u.username,u.display_name,u.bio,u.avatar
    FROM friends f JOIN users u ON u.id = CASE WHEN f.requester_id=? THEN f.addressee_id ELSE f.requester_id END
    WHERE f.status='accepted' AND (f.requester_id=? OR f.addressee_id=?)
  `).all(uid, uid, uid);
  const incoming = db.prepare(`
    SELECT f.id AS request_id,u.id,u.username,u.display_name,u.bio,u.avatar
    FROM friends f JOIN users u ON u.id=f.requester_id
    WHERE f.addressee_id=? AND f.status='pending'
  `).all(uid);
  res.json({ friends, incoming });
});

app.get("/api/chats", requireAuth, (req, res) => {
  const chats = db.prepare("SELECT chat_id FROM chat_members WHERE user_id=?").all(req.session.userId).map(r => chatSummary(r.chat_id, req.session.userId));
  res.json({ chats });
});

app.post("/api/chats/group", requireAuth, (req, res) => {
  const info = db.prepare("INSERT INTO chats(type,name,owner_id) VALUES('group',?,?)").run(String(req.body.name || "Group").slice(0, 40), req.session.userId);
  const ids = [...new Set([req.session.userId, ...(req.body.userIds || []).map(Number)])];
  ids.forEach(id => {
    if (id === req.session.userId || areFriends(req.session.userId, id)) {
      db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,user_id) VALUES(?,?)").run(info.lastInsertRowid, id);
      io.to(`user:${id}`).emit("chats:update");
    }
  });
  res.json({ chat: chatSummary(info.lastInsertRowid, req.session.userId) });
});

app.get("/api/chats/:id/messages", requireAuth, (req, res) => {
  const cid = Number(req.params.id);
  if (!canChat(req.session.userId, cid)) return res.status(403).json({ error: "No access" });
  const messages = db.prepare("SELECT id FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 80").all(cid).reverse().map(r => messageWithUser(r.id));
  res.json({ messages });
});

app.delete("/api/chats/:id/messages", requireAuth, (req, res) => {
  const cid = Number(req.params.id);
  if (!canChat(req.session.userId, cid)) return res.status(403).json({ error: "No access" });
  db.prepare("DELETE FROM messages WHERE chat_id=?").run(cid);
  notifyChat(cid, "messages:cleared", { chatId: cid });
  res.json({ ok: true });
});

app.get("/api/ice", requireAuth, (req, res) => {
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_PASSWORD) {
    iceServers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USERNAME, credential: process.env.TURN_PASSWORD });
  }
  res.json({ iceServers });
});

io.on("connection", socket => {
  const uid = socket.request.session?.userId;
  if (!uid) return socket.disconnect(true);
  socket.join(`user:${uid}`);

  socket.on("message:send", data => {
    const cid = Number(data.chatId);
    const body = String(data.body || "").trim().slice(0, 2000);
    if (!body || !canChat(uid, cid)) return;
    const info = db.prepare("INSERT INTO messages(chat_id,sender_id,body) VALUES(?,?,?)").run(cid, uid, body);
    notifyChat(cid, "message:new", messageWithUser(info.lastInsertRowid));
    notifyChat(cid, "chats:update", {});
  });

  socket.on("message:edit", data => {
    const m = db.prepare("SELECT * FROM messages WHERE id=? AND sender_id=?").get(Number(data.id), uid);
    const body = String(data.body || "").trim().slice(0, 2000);
    if (!m || !body) return;
    db.prepare("UPDATE messages SET body=?, edited=1 WHERE id=?").run(body, m.id);
    notifyChat(m.chat_id, "message:update", messageWithUser(m.id));
  });

  socket.on("message:delete", data => {
    const m = db.prepare("SELECT * FROM messages WHERE id=? AND sender_id=?").get(Number(data.id), uid);
    if (!m) return;
    db.prepare("UPDATE messages SET body='Message deleted', deleted=1 WHERE id=?").run(m.id);
    notifyChat(m.chat_id, "message:update", messageWithUser(m.id));
  });

  socket.on("message:react", data => {
    const m = db.prepare("SELECT * FROM messages WHERE id=?").get(Number(data.id));
    const emoji = String(data.emoji || "").slice(0, 8);
    if (!m || !emoji || !canChat(uid, m.chat_id)) return;
    const exists = db.prepare("SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND emoji=?").get(m.id, uid, emoji);
    if (exists) db.prepare("DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?").run(m.id, uid, emoji);
    else db.prepare("INSERT INTO reactions(message_id,user_id,emoji) VALUES(?,?,?)").run(m.id, uid, emoji);
    notifyChat(m.chat_id, "message:update", messageWithUser(m.id));
  });

  function sendCall(event, data) {
    const cid = Number(data.chatId);
    const targetId = Number(data.targetId);
    if (!targetId) return;
    if (!["decline", "end"].includes(event) && (!canChat(uid, cid) || !canChat(targetId, cid))) return;
    const payload = { chatId: cid, from: publicUser(uid), fromUserId: uid };
    if (data.offer) payload.offer = data.offer;
    if (data.answer) payload.answer = data.answer;
    if (data.candidate) payload.candidate = data.candidate;
    const outEvent = event === "invite" ? "incoming" : event === "accept" ? "accepted" : event === "decline" ? "declined" : event;
    io.to(`user:${targetId}`).emit(`call:${outEvent}`, payload);
  }

  ["invite","accept","decline","offer","answer","ice","end"].forEach(ev => {
    socket.on(`call:${ev}`, data => sendCall(ev, data || {}));
  });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
server.listen(PORT, "0.0.0.0", () => console.log(`Chorus running on port ${PORT}`));
