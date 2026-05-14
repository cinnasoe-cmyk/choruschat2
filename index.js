
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const session = require("express-session");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, "storage");
const UPLOAD_DIR = path.join(STORAGE_DIR, "uploads");
const DB_FILE = path.join(STORAGE_DIR, "chorus-data.json");

fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const defaultData = {
  nextUserId: 1,
  nextFriendId: 1,
  nextChatId: 1,
  nextMessageId: 1,
  users: [],
  friends: [],
  chats: [],
  messages: [],
  reactions: []
};

function readData() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 2));
    }
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return { ...defaultData, ...data };
  } catch (err) {
    console.error("Failed to read data file:", err);
    return structuredClone(defaultData);
  }
}

let data = readData();

function saveData() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function cleanUsername(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.]/g, "").slice(0, 24);
}

function publicUser(id) {
  const user = data.users.find(u => Number(u.id) === Number(id));
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    bio: user.bio || "",
    avatar: user.avatar || "/default-avatar.svg"
  };
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in" });
  next();
}

function areFriends(a, b) {
  return data.friends.some(f => {
    return f.status === "accepted" &&
      ((Number(f.requester_id) === Number(a) && Number(f.addressee_id) === Number(b)) ||
       (Number(f.requester_id) === Number(b) && Number(f.addressee_id) === Number(a)));
  });
}

function canAccessChat(userId, chatId) {
  const chat = data.chats.find(c => Number(c.id) === Number(chatId));
  return !!chat && chat.members.some(id => Number(id) === Number(userId));
}

function getOrCreateDM(a, b) {
  const found = data.chats.find(chat => {
    return chat.type === "dm" &&
      chat.members.length === 2 &&
      chat.members.some(id => Number(id) === Number(a)) &&
      chat.members.some(id => Number(id) === Number(b));
  });
  if (found) return found.id;

  const chat = {
    id: data.nextChatId++,
    type: "dm",
    name: "",
    owner_id: a,
    members: [a, b],
    created_at: new Date().toISOString()
  };
  data.chats.push(chat);
  saveData();
  return chat.id;
}

function chatSummary(chatId, viewerId) {
  const chat = data.chats.find(c => Number(c.id) === Number(chatId));
  if (!chat) return null;

  const members = chat.members.map(publicUser).filter(Boolean);
  const last = data.messages.filter(m => Number(m.chat_id) === Number(chat.id)).at(-1) || null;

  let title = chat.name || "Group";
  let avatar = "/default-avatar.svg";

  if (chat.type === "dm") {
    const other = members.find(m => Number(m.id) !== Number(viewerId)) || members[0];
    if (other) {
      title = other.display_name;
      avatar = other.avatar;
    }
  }

  return { id: chat.id, type: chat.type, title, avatar, members, last };
}

function messageWithUser(messageId) {
  const msg = data.messages.find(m => Number(m.id) === Number(messageId));
  if (!msg) return null;
  const user = publicUser(msg.sender_id);
  const grouped = {};
  data.reactions
    .filter(r => Number(r.message_id) === Number(msg.id))
    .forEach(r => grouped[r.emoji] = (grouped[r.emoji] || 0) + 1);

  return {
    ...msg,
    username: user?.username || "unknown",
    display_name: user?.display_name || "Unknown",
    avatar: user?.avatar || "/default-avatar.svg",
    reactions: Object.entries(grouped).map(([emoji, count]) => ({ emoji, count }))
  };
}

function notifyUser(userId, event, payload) {
  io.to(`user:${userId}`).emit(event, payload);
}

function notifyChat(chatId, event, payload) {
  const chat = data.chats.find(c => Number(c.id) === Number(chatId));
  if (!chat) return;
  chat.members.forEach(userId => notifyUser(userId, event, payload));
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true }, maxHttpBufferSize: 1e7 });

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 1000 * 60 * 60 * 24 * 30 }
});

app.use(express.json({ limit: "2mb" }));
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || ".png").toLowerCase() || ".png";
      cb(null, `avatar-${req.session.userId}-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith("image/"))
});

app.post("/api/register", async (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || "");
  const displayName = String(req.body.displayName || username).trim().slice(0, 32);

  if (username.length < 3) return res.status(400).json({ error: "Username must be at least 3 characters." });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  if (data.users.some(u => u.username === username)) return res.status(409).json({ error: "That username is already claimed." });

  const user = {
    id: data.nextUserId++,
    username,
    display_name: displayName || username,
    password_hash: await bcrypt.hash(password, 10),
    bio: "",
    avatar: "/default-avatar.svg",
    created_at: new Date().toISOString()
  };

  data.users.push(user);
  saveData();

  req.session.userId = user.id;
  res.json({ user: publicUser(user.id) });
});

app.post("/api/login", async (req, res) => {
  const username = cleanUsername(req.body.username);
  const found = data.users.find(u => u.username === username);
  if (!found || !(await bcrypt.compare(String(req.body.password || ""), found.password_hash))) {
    return res.status(401).json({ error: "Wrong username or password." });
  }

  req.session.userId = found.id;
  res.json({ user: publicUser(found.id) });
});

app.post("/api/logout", requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.session.userId) });
});

app.put("/api/me", requireAuth, (req, res) => {
  const user = data.users.find(u => Number(u.id) === Number(req.session.userId));
  user.display_name = String(req.body.displayName || user.display_name).trim().slice(0, 32);
  user.bio = String(req.body.bio || "").trim().slice(0, 180);
  saveData();
  res.json({ user: publicUser(user.id) });
});

app.post("/api/me/avatar", requireAuth, upload.single("avatar"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Upload an image file." });

  const user = data.users.find(u => Number(u.id) === Number(req.session.userId));
  user.avatar = `/uploads/${req.file.filename}`;
  saveData();

  res.json({ user: publicUser(user.id) });
});

app.post("/api/friends/request", requireAuth, (req, res) => {
  const username = cleanUsername(req.body.username);
  const target = data.users.find(u => u.username === username);

  if (!target) return res.status(404).json({ error: "User not found." });
  if (Number(target.id) === Number(req.session.userId)) return res.status(400).json({ error: "You cannot add yourself." });

  const existing = data.friends.find(f => {
    return (Number(f.requester_id) === Number(req.session.userId) && Number(f.addressee_id) === Number(target.id)) ||
           (Number(f.requester_id) === Number(target.id) && Number(f.addressee_id) === Number(req.session.userId));
  });

  if (existing) {
    if (existing.status === "pending" && Number(existing.addressee_id) === Number(req.session.userId)) {
      existing.status = "accepted";
      getOrCreateDM(req.session.userId, target.id);
    }
  } else {
    data.friends.push({
      id: data.nextFriendId++,
      requester_id: req.session.userId,
      addressee_id: target.id,
      status: "pending",
      created_at: new Date().toISOString()
    });
  }

  saveData();
  notifyUser(target.id, "friends:update", {});
  notifyUser(req.session.userId, "friends:update", {});
  notifyUser(target.id, "chats:update", {});
  notifyUser(req.session.userId, "chats:update", {});
  res.json({ ok: true });
});

app.post("/api/friends/respond", requireAuth, (req, res) => {
  const request = data.friends.find(f => {
    return Number(f.id) === Number(req.body.requestId) &&
           Number(f.addressee_id) === Number(req.session.userId) &&
           f.status === "pending";
  });

  if (!request) return res.status(404).json({ error: "Request not found." });

  request.status = req.body.action === "accept" ? "accepted" : "declined";
  if (request.status === "accepted") getOrCreateDM(request.requester_id, request.addressee_id);

  saveData();

  [request.requester_id, request.addressee_id].forEach(id => {
    notifyUser(id, "friends:update", {});
    notifyUser(id, "chats:update", {});
  });

  res.json({ ok: true });
});

app.get("/api/friends", requireAuth, (req, res) => {
  const uid = Number(req.session.userId);

  const accepted = data.friends.filter(f => {
    return f.status === "accepted" && (Number(f.requester_id) === uid || Number(f.addressee_id) === uid);
  });

  const friends = accepted.map(f => {
    const otherId = Number(f.requester_id) === uid ? f.addressee_id : f.requester_id;
    return publicUser(otherId);
  }).filter(Boolean);

  const incoming = data.friends
    .filter(f => f.status === "pending" && Number(f.addressee_id) === uid)
    .map(f => ({ request_id: f.id, ...publicUser(f.requester_id) }))
    .filter(Boolean);

  res.json({ friends, incoming });
});

app.get("/api/chats", requireAuth, (req, res) => {
  const chats = data.chats
    .filter(chat => chat.members.some(id => Number(id) === Number(req.session.userId)))
    .map(chat => chatSummary(chat.id, req.session.userId))
    .filter(Boolean);

  res.json({ chats });
});

app.post("/api/chats/group", requireAuth, (req, res) => {
  const ids = Array.isArray(req.body.userIds) ? req.body.userIds.map(Number) : [];
  const members = [...new Set([Number(req.session.userId), ...ids.filter(id => areFriends(req.session.userId, id))])];

  const chat = {
    id: data.nextChatId++,
    type: "group",
    name: String(req.body.name || "Group").trim().slice(0, 40) || "Group",
    owner_id: req.session.userId,
    members,
    created_at: new Date().toISOString()
  };

  data.chats.push(chat);
  saveData();

  members.forEach(id => notifyUser(id, "chats:update", {}));
  res.json({ chat: chatSummary(chat.id, req.session.userId) });
});

app.get("/api/chats/:id/messages", requireAuth, (req, res) => {
  const chatId = Number(req.params.id);
  if (!canAccessChat(req.session.userId, chatId)) return res.status(403).json({ error: "No access." });

  const messages = data.messages
    .filter(m => Number(m.chat_id) === chatId)
    .slice(-100)
    .map(m => messageWithUser(m.id));

  res.json({ messages });
});

app.delete("/api/chats/:id/messages", requireAuth, (req, res) => {
  const chatId = Number(req.params.id);
  if (!canAccessChat(req.session.userId, chatId)) return res.status(403).json({ error: "No access." });

  data.messages = data.messages.filter(m => Number(m.chat_id) !== chatId);
  data.reactions = data.reactions.filter(r => !data.messages.some(m => Number(m.id) === Number(r.message_id)));
  saveData();

  notifyChat(chatId, "messages:cleared", { chatId });
  res.json({ ok: true });
});

app.get("/api/ice", requireAuth, (req, res) => {
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ];

  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_PASSWORD) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_PASSWORD
    });
  }

  res.json({ iceServers });
});

io.on("connection", socket => {
  const uid = socket.request.session?.userId;
  if (!uid) return socket.disconnect(true);

  socket.join(`user:${uid}`);

  socket.on("message:send", payload => {
    const chatId = Number(payload.chatId);
    const body = String(payload.body || "").trim().slice(0, 2000);

    if (!body || !canAccessChat(uid, chatId)) return;

    const message = {
      id: data.nextMessageId++,
      chat_id: chatId,
      sender_id: uid,
      body,
      edited: 0,
      deleted: 0,
      created_at: new Date().toISOString()
    };

    data.messages.push(message);
    saveData();

    notifyChat(chatId, "message:new", messageWithUser(message.id));
    notifyChat(chatId, "chats:update", {});
  });

  socket.on("message:edit", payload => {
    const message = data.messages.find(m => Number(m.id) === Number(payload.id) && Number(m.sender_id) === Number(uid));
    if (!message) return;

    const body = String(payload.body || "").trim().slice(0, 2000);
    if (!body) return;

    message.body = body;
    message.edited = 1;
    saveData();

    notifyChat(message.chat_id, "message:update", messageWithUser(message.id));
  });

  socket.on("message:delete", payload => {
    const message = data.messages.find(m => Number(m.id) === Number(payload.id) && Number(m.sender_id) === Number(uid));
    if (!message) return;

    message.body = "Message deleted";
    message.deleted = 1;
    saveData();

    notifyChat(message.chat_id, "message:update", messageWithUser(message.id));
  });

  socket.on("message:react", payload => {
    const message = data.messages.find(m => Number(m.id) === Number(payload.id));
    const emoji = String(payload.emoji || "").slice(0, 8);

    if (!message || !emoji || !canAccessChat(uid, message.chat_id)) return;

    const index = data.reactions.findIndex(r => {
      return Number(r.message_id) === Number(message.id) &&
             Number(r.user_id) === Number(uid) &&
             r.emoji === emoji;
    });

    if (index >= 0) data.reactions.splice(index, 1);
    else data.reactions.push({ message_id: message.id, user_id: uid, emoji });

    saveData();
    notifyChat(message.chat_id, "message:update", messageWithUser(message.id));
  });

  function sendCall(event, payload) {
    const chatId = Number(payload.chatId);
    const targetId = Number(payload.targetId);

    if (!targetId) return;
    if (!["decline", "end"].includes(event) && (!canAccessChat(uid, chatId) || !canAccessChat(targetId, chatId))) return;

    const out = { chatId, from: publicUser(uid), fromUserId: uid };
    if (payload.offer) out.offer = payload.offer;
    if (payload.answer) out.answer = payload.answer;
    if (payload.candidate) out.candidate = payload.candidate;

    const outEvent = event === "invite" ? "incoming" :
      event === "accept" ? "accepted" :
      event === "decline" ? "declined" :
      event;

    notifyUser(targetId, `call:${outEvent}`, out);
  }

  ["invite", "accept", "decline", "offer", "answer", "ice", "end"].forEach(event => {
    socket.on(`call:${event}`, payload => sendCall(event, payload || {}));
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Chorus running on port ${PORT}`);
  console.log(`Storage directory: ${STORAGE_DIR}`);
});
