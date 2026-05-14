
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const session = require("express-session");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const STORAGE_DIR = process.env.STORAGE_DIR || (fs.existsSync("/var/data") ? "/var/data" : path.join(__dirname, "storage"));
const UPLOAD_DIR = path.join(STORAGE_DIR, "uploads");
const DB_FILE = path.join(STORAGE_DIR, "chorus-data.json");

fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const defaultData = {
  nextUserId: 1,
  nextFriendId: 1,
  nextSpaceId: 1,
  nextChannelId: 1,
  nextChatId: 1,
  nextMessageId: 1,
  nextThreadId: 1,
  users: [],
  friends: [],
  spaces: [],
  channels: [],
  chats: [],
  messages: [],
  reactions: [],
  callRooms: []
};

function fresh() {
  return JSON.parse(JSON.stringify(defaultData));
}

function readData() {
  try {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 2));
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return { ...fresh(), ...parsed };
  } catch (err) {
    console.error("Failed to read DB:", err);
    return fresh();
  }
}

let data = readData();

function removeLegacyAutoSpaces() {
  const legacyIds = new Set();
  for (const space of data.spaces || []) {
    const owner = data.users.find(u => Number(u.id) === Number(space.owner_id));
    const expected = owner ? `${owner.display_name}'s Space` : "";
    const channels = data.channels.filter(c => Number(c.space_id) === Number(space.id));
    const names = channels.map(c => c.name).sort().join(",");
    const looksAuto = expected && space.name === expected && (names === "general,media" || names === "general");
    if (looksAuto) legacyIds.add(Number(space.id));
  }
  if (!legacyIds.size) return;
  const channelIds = new Set(data.channels.filter(c => legacyIds.has(Number(c.space_id))).map(c => Number(c.id)));
  data.spaces = data.spaces.filter(s => !legacyIds.has(Number(s.id)));
  data.channels = data.channels.filter(c => !channelIds.has(Number(c.id)));
  data.messages = data.messages.filter(m => !(m.scope === "channel" && channelIds.has(Number(m.scope_id))));
  data.reactions = data.reactions.filter(r => data.messages.some(m => Number(m.id) === Number(r.message_id)));
  saveData();
  console.log(`Removed ${legacyIds.size} legacy auto-created space(s).`);
}
removeLegacyAutoSpaces();

function saveData() {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const temp = DB_FILE + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(data, null, 2));
    fs.renameSync(temp, DB_FILE);
  } catch (err) {
    console.error("Failed to save DB:", err);
  }
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.]/g, "").slice(0, 24);
}

function cleanText(v, len = 2000) {
  return String(v || "").trim().slice(0, len);
}

function publicUser(id) {
  const user = data.users.find(u => Number(u.id) === Number(id));
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    bio: user.bio || "",
    avatar: (!user.avatar || user.avatar === "/logo-mark.svg") ? "/user-default.svg" : user.avatar,
    status: user.status || "online",
    tagline: user.tagline || "Listening for echoes."
  };
}

function spaceById(id) { return data.spaces.find(s => Number(s.id) === Number(id)); }
function channelById(id) { return data.channels.find(c => Number(c.id) === Number(id)); }
function chatById(id) { return data.chats.find(c => Number(c.id) === Number(id)); }
function messageById(id) { return data.messages.find(m => Number(m.id) === Number(id)); }

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in." });
  next();
}

function userCanAccessSpace(userId, spaceId) {
  const space = spaceById(spaceId);
  return !!space && (space.owner_id === Number(userId) || (space.members || []).includes(Number(userId)));
}

function userCanAccessChannel(userId, channelId) {
  const channel = channelById(channelId);
  return !!channel && userCanAccessSpace(userId, channel.space_id);
}

function userCanAccessChat(userId, chatId) {
  const chat = chatById(chatId);
  return !!chat && (chat.members || []).includes(Number(userId));
}

function areFriends(a, b) {
  return data.friends.some(f => f.status === "accepted" &&
    ((Number(f.requester_id) === Number(a) && Number(f.addressee_id) === Number(b)) ||
     (Number(f.requester_id) === Number(b) && Number(f.addressee_id) === Number(a)))
  );
}

function getOrCreateDM(a, b) {
  const found = data.chats.find(c => c.type === "dm" && c.members.length === 2 &&
    c.members.includes(Number(a)) && c.members.includes(Number(b)));
  if (found) return found.id;
  const chat = {
    id: data.nextChatId++,
    type: "dm",
    name: "",
    owner_id: Number(a),
    members: [Number(a), Number(b)],
    created_at: new Date().toISOString()
  };
  data.chats.push(chat);
  saveData();
  return chat.id;
}

function defaultStarterSpace(ownerId, ownerName) {
  const spaceId = data.nextSpaceId++;
  const generalId = data.nextChannelId++;
  const mediaId = data.nextChannelId++;
  data.spaces.push({
    id: spaceId,
    name: `${ownerName}'s Space`,
    icon: "/logo-mark.svg",
    theme: "aurora",
    owner_id: Number(ownerId),
    members: [Number(ownerId)],
    created_at: new Date().toISOString()
  });
  data.channels.push(
    { id: generalId, space_id: spaceId, name: "general", kind: "text", created_at: new Date().toISOString() },
    { id: mediaId, space_id: spaceId, name: "media", kind: "text", created_at: new Date().toISOString() }
  );
}

function listSpaceSummaries(userId) {
  return data.spaces
    .filter(s => userCanAccessSpace(userId, s.id))
    .map(s => ({
      id: s.id,
      name: s.name,
      icon: s.icon || "/logo-mark.svg",
      theme: s.theme || "aurora",
      channels: data.channels.filter(c => Number(c.space_id) === Number(s.id))
    }));
}

function chatSummary(chatId, viewerId) {
  const chat = chatById(chatId);
  if (!chat) return null;
  const members = (chat.members || []).map(publicUser).filter(Boolean);
  const last = data.messages.filter(m => m.scope === "chat" && Number(m.scope_id) === Number(chat.id)).at(-1) || null;
  let title = chat.name || "Group chat";
  let avatar = "/logo-mark.svg";
  if (chat.type === "dm") {
    const other = members.find(m => Number(m.id) !== Number(viewerId)) || members[0];
    if (other) {
      title = other.display_name;
      avatar = other.avatar;
    }
  }
  return { id: chat.id, type: chat.type, title, avatar, members, last };
}

function reactionSummary(messageId) {
  const grouped = {};
  data.reactions.filter(r => Number(r.message_id) === Number(messageId)).forEach(r => {
    grouped[r.emoji] = (grouped[r.emoji] || 0) + 1;
  });
  return Object.entries(grouped).map(([emoji, count]) => ({ emoji, count }));
}

function decorateMessage(msg) {
  const sender = publicUser(msg.sender_id);
  const reply = msg.reply_to ? messageById(msg.reply_to) : null;
  return {
    ...msg,
    display_name: sender?.display_name || "Unknown",
    username: sender?.username || "unknown",
    avatar: sender?.avatar || "/logo-mark.svg",
    reactions: reactionSummary(msg.id),
    reply_preview: reply ? { id: reply.id, body: reply.body, display_name: publicUser(reply.sender_id)?.display_name || "Unknown" } : null
  };
}

function scopeMessages(scope, scopeId) {
  return data.messages.filter(m => m.scope === scope && Number(m.scope_id) === Number(scopeId)).map(m => decorateMessage(m));
}

function notifyUser(userId, event, payload) {
  io.to(`user:${userId}`).emit(event, payload);
}
function notifyChat(chatId, event, payload) {
  const chat = chatById(chatId);
  if (!chat) return;
  (chat.members || []).forEach(id => notifyUser(id, event, payload));
}
function notifySpace(spaceId, event, payload) {
  const space = spaceById(spaceId);
  if (!space) return;
  (space.members || []).forEach(id => notifyUser(id, event, payload));
}

const app = express();
app.set("trust proxy", 1);
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true }, maxHttpBufferSize: 2e7 });

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
});

app.use(express.json({ limit: "4mb" }));
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || ".png").toLowerCase() || ".png";
      cb(null, `upload-${req.session.userId}-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 }
});

// Auth
app.post("/api/register", async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || "");
  const displayName = cleanText(req.body.displayName || username, 32);
  if (username.length < 3) return res.status(400).json({ error: "Username must be at least 3 characters." });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  if (data.users.some(u => u.username === username)) return res.status(409).json({ error: "That username is already claimed." });

  const user = {
    id: data.nextUserId++,
    username,
    display_name: displayName || username,
    password_hash: await bcrypt.hash(password, 10),
    bio: "",
    tagline: "Listening for echoes.",
    avatar: "/user-default.svg",
    status: "online",
    created_at: new Date().toISOString()
  };
  data.users.push(user);
  saveData();
  req.session.userId = user.id;
  res.json({ user: publicUser(user.id) });
});

app.post("/api/login", async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const found = data.users.find(u => u.username === username);
  if (!found || !(await bcrypt.compare(String(req.body.password || ""), found.password_hash))) {
    return res.status(401).json({ error: "Wrong username or password." });
  }
  found.status = "online";
  saveData();
  req.session.userId = found.id;
  res.json({ user: publicUser(found.id) });
});

app.post("/api/logout", requireAuth, (req, res) => {
  const me = data.users.find(u => Number(u.id) === Number(req.session.userId));
  if (me) me.status = "offline";
  saveData();
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", requireAuth, (req, res) => res.json({ user: publicUser(req.session.userId) }));
app.put("/api/me", requireAuth, (req, res) => {
  const me = data.users.find(u => Number(u.id) === Number(req.session.userId));
  me.display_name = cleanText(req.body.displayName || me.display_name, 32);
  me.bio = cleanText(req.body.bio || "", 220);
  me.tagline = cleanText(req.body.tagline || me.tagline || "", 80);
  me.status = ["online", "idle", "dnd", "offline"].includes(req.body.status) ? req.body.status : me.status;
  saveData();
  res.json({ user: publicUser(me.id) });
});
app.post("/api/me/avatar", requireAuth, upload.single("avatar"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Upload an image file." });
  const me = data.users.find(u => Number(u.id) === Number(req.session.userId));
  me.avatar = `/uploads/${req.file.filename}`;
  saveData();
  res.json({ user: publicUser(me.id) });
});

// Friends
app.get("/api/friends", requireAuth, (req, res) => {
  const uid = Number(req.session.userId);
  const friends = data.friends.filter(f => f.status === "accepted" && (Number(f.requester_id) === uid || Number(f.addressee_id) === uid))
    .map(f => publicUser(Number(f.requester_id) === uid ? f.addressee_id : f.requester_id)).filter(Boolean);
  const incoming = data.friends.filter(f => f.status === "pending" && Number(f.addressee_id) === uid)
    .map(f => ({ request_id: f.id, ...publicUser(f.requester_id) })).filter(Boolean);
  res.json({ friends, incoming });
});

app.post("/api/friends/request", requireAuth, (req, res) => {
  const target = data.users.find(u => u.username === normalizeUsername(req.body.username));
  const uid = Number(req.session.userId);
  if (!target) return res.status(404).json({ error: "User not found." });
  if (Number(target.id) === uid) return res.status(400).json({ error: "You cannot add yourself." });

  const existing = data.friends.find(f =>
    (Number(f.requester_id) === uid && Number(f.addressee_id) === Number(target.id)) ||
    (Number(f.requester_id) === Number(target.id) && Number(f.addressee_id) === uid)
  );

  if (!existing) {
    data.friends.push({ id: data.nextFriendId++, requester_id: uid, addressee_id: Number(target.id), status: "pending", created_at: new Date().toISOString() });
    saveData();
  }

  notifyUser(target.id, "friends:update", {});
  notifyUser(uid, "friends:update", {});
  res.json({ ok: true });
});

app.post("/api/friends/respond", requireAuth, (req, res) => {
  const request = data.friends.find(f => Number(f.id) === Number(req.body.requestId) && Number(f.addressee_id) === Number(req.session.userId) && f.status === "pending");
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

// DMs and group chats
app.get("/api/chats", requireAuth, (req, res) => {
  const chats = data.chats.filter(c => (c.members || []).includes(Number(req.session.userId))).map(c => chatSummary(c.id, req.session.userId)).filter(Boolean);
  res.json({ chats });
});
app.post("/api/chats/group", requireAuth, (req, res) => {
  const memberIds = [...new Set([Number(req.session.userId), ...(Array.isArray(req.body.userIds) ? req.body.userIds.map(Number) : [])])].filter(id => id === Number(req.session.userId) || areFriends(req.session.userId, id));
  const chat = { id: data.nextChatId++, type: "group", name: cleanText(req.body.name || "Group chat", 40), owner_id: Number(req.session.userId), members: memberIds, created_at: new Date().toISOString() };
  data.chats.push(chat);
  saveData();
  memberIds.forEach(id => notifyUser(id, "chats:update", {}));
  res.json({ chat: chatSummary(chat.id, req.session.userId) });
});

// Spaces and channels
app.get("/api/spaces", requireAuth, (req, res) => res.json({ spaces: listSpaceSummaries(req.session.userId) }));
app.post("/api/spaces", requireAuth, (req, res) => {
  const name = cleanText(req.body.name || "New Space", 40);
  const space = { id: data.nextSpaceId++, name, icon: "/logo-mark.svg", theme: req.body.theme || "aurora", owner_id: Number(req.session.userId), members: [Number(req.session.userId)], created_at: new Date().toISOString() };
  data.spaces.push(space);
  const channel = { id: data.nextChannelId++, space_id: space.id, name: "general", kind: "text", created_at: new Date().toISOString() };
  data.channels.push(channel);
  saveData();
  res.json({ space });
});
app.post("/api/spaces/join", requireAuth, (req, res) => {
  const space = spaceById(Number(req.body.spaceId));
  if (!space) return res.status(404).json({ error: "Space not found." });
  if (!(space.members || []).includes(Number(req.session.userId))) space.members.push(Number(req.session.userId));
  saveData();
  notifySpace(space.id, "spaces:update", {});
  res.json({ ok: true });
});
app.post("/api/spaces/:spaceId/channels", requireAuth, (req, res) => {
  const spaceId = Number(req.params.spaceId);
  if (!userCanAccessSpace(req.session.userId, spaceId)) return res.status(403).json({ error: "No access." });
  const channel = { id: data.nextChannelId++, space_id: spaceId, name: cleanText(req.body.name || "new-channel", 24).replace(/\s+/g, "-"), kind: "text", created_at: new Date().toISOString() };
  data.channels.push(channel);
  saveData();
  notifySpace(spaceId, "spaces:update", {});
  res.json({ channel });
});

// Messages unified
app.get("/api/messages/chat/:chatId", requireAuth, (req, res) => {
  const chatId = Number(req.params.chatId);
  if (!userCanAccessChat(req.session.userId, chatId)) return res.status(403).json({ error: "No access." });
  res.json({ messages: scopeMessages("chat", chatId).slice(-150) });
});
app.get("/api/messages/channel/:channelId", requireAuth, (req, res) => {
  const channelId = Number(req.params.channelId);
  if (!userCanAccessChannel(req.session.userId, channelId)) return res.status(403).json({ error: "No access." });
  res.json({ messages: scopeMessages("channel", channelId).slice(-200) });
});
app.delete("/api/messages/chat/:chatId", requireAuth, (req, res) => {
  const chatId = Number(req.params.chatId);
  if (!userCanAccessChat(req.session.userId, chatId)) return res.status(403).json({ error: "No access." });
  const deletedIds = new Set(data.messages.filter(m => m.scope === "chat" && Number(m.scope_id) === chatId).map(m => m.id));
  data.messages = data.messages.filter(m => !(m.scope === "chat" && Number(m.scope_id) === chatId));
  data.reactions = data.reactions.filter(r => !deletedIds.has(Number(r.message_id)));
  saveData();
  notifyChat(chatId, "messages:cleared", { scope: "chat", scopeId: chatId });
  res.json({ ok: true });
});

app.get("/api/search", requireAuth, (req, res) => {
  const q = cleanText(req.query.q || "", 60).toLowerCase();
  if (!q) return res.json({ results: [] });
  const allowedChats = data.chats.filter(c => (c.members || []).includes(Number(req.session.userId))).map(c => Number(c.id));
  const allowedChannels = data.channels.filter(c => userCanAccessChannel(req.session.userId, c.id)).map(c => Number(c.id));
  const results = data.messages.filter(m => m.body.toLowerCase().includes(q) &&
    ((m.scope === "chat" && allowedChats.includes(Number(m.scope_id))) ||
     (m.scope === "channel" && allowedChannels.includes(Number(m.scope_id)))))
    .slice(-50)
    .map(decorateMessage);
  res.json({ results });
});

app.get("/api/ice", requireAuth, (req, res) => {
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" }
  ];

  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_PASSWORD) {
    const urls = String(process.env.TURN_URL).split(',').map(s => s.trim()).filter(Boolean);
    iceServers.push({ urls: urls.length > 1 ? urls : urls[0], username: process.env.TURN_USERNAME, credential: process.env.TURN_PASSWORD });
  }

  res.json({ iceServers });
});

io.on("connection", socket => {
  const uid = Number(socket.request.session?.userId || 0);
  if (!uid) return socket.disconnect(true);
  socket.join(`user:${uid}`);

  socket.on("presence:set", payload => {
    const me = data.users.find(u => Number(u.id) === uid);
    if (!me) return;
    me.status = ["online","idle","dnd","offline"].includes(payload.status) ? payload.status : me.status;
    saveData();
    io.emit("presence:update", { userId: uid, status: me.status });
  });

  socket.on("typing:start", payload => {
    const room = `${payload.scope}:${payload.scopeId}`;
    socket.to(room).emit("typing:update", { scope: payload.scope, scopeId: payload.scopeId, user: publicUser(uid), active: true });
  });
  socket.on("typing:stop", payload => {
    const room = `${payload.scope}:${payload.scopeId}`;
    socket.to(room).emit("typing:update", { scope: payload.scope, scopeId: payload.scopeId, user: publicUser(uid), active: false });
  });
  socket.on("watch:scope", payload => {
    socket.join(`${payload.scope}:${payload.scopeId}`);
  });

  socket.on("message:send", payload => {
    const scope = payload.scope;
    const scopeId = Number(payload.scopeId);
    const body = cleanText(payload.body, 2000);
    if (!body) return;
    if (scope === "chat" && !userCanAccessChat(uid, scopeId)) return;
    if (scope === "channel" && !userCanAccessChannel(uid, scopeId)) return;
    const msg = { id: data.nextMessageId++, scope, scope_id: scopeId, sender_id: uid, body, edited: 0, deleted: 0, pinned: 0, reply_to: payload.replyTo ? Number(payload.replyTo) : null, created_at: new Date().toISOString() };
    data.messages.push(msg);
    saveData();
    const decorated = decorateMessage(msg);
    if (scope === "chat") notifyChat(scopeId, "message:new", decorated);
    else notifySpace(channelById(scopeId).space_id, "message:new", decorated);
    io.to(`${scope}:${scopeId}`).emit("message:new", decorated);
  });

  socket.on("message:edit", payload => {
    const msg = messageById(Number(payload.id));
    if (!msg || Number(msg.sender_id) !== uid) return;
    msg.body = cleanText(payload.body, 2000);
    msg.edited = 1;
    saveData();
    const decorated = decorateMessage(msg);
    io.to(`${msg.scope}:${msg.scope_id}`).emit("message:update", decorated);
    if (msg.scope === "chat") notifyChat(msg.scope_id, "message:update", decorated);
    else notifySpace(channelById(msg.scope_id).space_id, "message:update", decorated);
  });

  socket.on("message:delete", payload => {
    const msg = messageById(Number(payload.id));
    if (!msg || Number(msg.sender_id) !== uid) return;
    msg.body = "Message deleted";
    msg.deleted = 1;
    saveData();
    const decorated = decorateMessage(msg);
    io.to(`${msg.scope}:${msg.scope_id}`).emit("message:update", decorated);
  });

  socket.on("message:pin", payload => {
    const msg = messageById(Number(payload.id));
    if (!msg) return;
    if ((msg.scope === "chat" && !userCanAccessChat(uid, msg.scope_id)) || (msg.scope === "channel" && !userCanAccessChannel(uid, msg.scope_id))) return;
    msg.pinned = msg.pinned ? 0 : 1;
    saveData();
    io.to(`${msg.scope}:${msg.scope_id}`).emit("message:update", decorateMessage(msg));
  });

  socket.on("message:react", payload => {
    const msg = messageById(Number(payload.id));
    const emoji = String(payload.emoji || "").slice(0, 8);
    if (!msg || !emoji) return;
    const allowed = (msg.scope === "chat" && userCanAccessChat(uid, msg.scope_id)) || (msg.scope === "channel" && userCanAccessChannel(uid, msg.scope_id));
    if (!allowed) return;
    const idx = data.reactions.findIndex(r => Number(r.message_id) === Number(msg.id) && Number(r.user_id) === uid && r.emoji === emoji);
    if (idx >= 0) data.reactions.splice(idx, 1);
    else data.reactions.push({ message_id: msg.id, user_id: uid, emoji });
    saveData();
    io.to(`${msg.scope}:${msg.scope_id}`).emit("message:update", decorateMessage(msg));
  });

  // WebRTC signaling with screenshare supported by client track replacement
  function relayCall(event, payload) {
    const targetId = Number(payload.targetId || 0);
    const roomScope = payload.scope;
    const roomId = Number(payload.scopeId || 0);
    if (!targetId) return;
    const allowed = roomScope === "chat" ? userCanAccessChat(uid, roomId) && userCanAccessChat(targetId, roomId)
                  : roomScope === "channel" ? userCanAccessChannel(uid, roomId) && userCanAccessChannel(targetId, roomId)
                  : false;
    if (!["decline","end"].includes(event) && !allowed) return;

    const out = { scope: roomScope, scopeId: roomId, from: publicUser(uid), fromUserId: uid };
    if (payload.offer) out.offer = payload.offer;
    if (payload.answer) out.answer = payload.answer;
    if (payload.candidate) out.candidate = payload.candidate;
    if (payload.media) out.media = payload.media;

    const mapped = event === "invite" ? "incoming" :
      event === "accept" ? "accepted" :
      event === "decline" ? "declined" :
      event;

    notifyUser(targetId, `call:${mapped}`, out);
  }

  ["invite","accept","decline","offer","answer","ice","end"].forEach(name => {
    socket.on(`call:${name}`, payload => relayCall(name, payload || {}));
  });

  socket.on("disconnect", () => {});
});

app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

server.listen(PORT, "0.0.0.0", () => {
  console.log("Chorus running on port " + PORT);
  console.log("Storage directory: " + STORAGE_DIR);
});
