
let me = null;
let socket = null;
let spaces = [];
let chats = [];
let friends = [];
let activeSpace = null;
let activeChannel = null;
let activeChat = null;
let activeScope = null;
let replyTarget = null;
let typingTimer = null;
let settings = JSON.parse(localStorage.getItem("chorusSettings") || '{"messageVolume":65,"callVolume":100,"micId":"","speakerId":""}');
let activeCall = { pc:null, localStream:null, screenStream:null, scope:null, scopeId:null, peerId:null, incoming:null, pendingIce:[], muted:false, wantsScreen:false, connected:false };

const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

async function api(url, options = {}) {
  const headers = options.headers || {};
  const res = await fetch(url, { credentials: "include", ...options, headers: { "Content-Type": "application/json", ...headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function saveSettings() { localStorage.setItem("chorusSettings", JSON.stringify(settings)); }
function playPing() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 710;
    gain.gain.value = Math.max(.03, settings.messageVolume / 100 * .08);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.08);
  } catch {}
}

async function boot() {
  try {
    const data = await api("/api/me");
    me = data.user;
    showApp();
  } catch {
    $("auth").classList.remove("hidden");
  }
}

function showApp() {
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  renderSelf();
  connectSocket();
  refreshEverything();
  loadDevices();
}

function renderSelf() {
  $("selfAvatar").src = me.avatar;
  $("profilePreview").src = me.avatar;
  $("selfName").textContent = me.display_name;
  $("selfUsername").textContent = "@" + me.username;
  $("selfStatus").textContent = me.status;
  $("profileDisplay").value = me.display_name;
  $("profileTagline").value = me.tagline || "";
  $("profileBio").value = me.bio || "";
  $("profileStatus").value = me.status || "online";
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ withCredentials: true });

  socket.on("friends:update", refreshFriends);
  socket.on("chats:update", refreshChats);
  socket.on("spaces:update", refreshSpaces);
  socket.on("presence:update", ({ userId, status }) => {
    if (Number(userId) === Number(me.id)) { me.status = status; renderSelf(); }
    refreshFriends();
    if (activeScope) renderMembers();
  });

  socket.on("message:new", msg => {
    if (activeScope && msg.scope === activeScope.type && Number(msg.scope_id) === Number(activeScope.id)) appendMessage(msg);
    else playPing();
    refreshSidebarBits();
  });

  socket.on("message:update", msg => {
    const el = $(`msg-${msg.id}`);
    if (el) el.outerHTML = messageHTML(msg);
    renderPinned();
  });

  socket.on("typing:update", payload => {
    if (activeScope && payload.scope === activeScope.type && Number(payload.scopeId) === Number(activeScope.id) && Number(payload.user.id) !== Number(me.id)) {
      $("typingLine").textContent = payload.active ? `${payload.user.display_name} is typing...` : "";
    }
  });

  socket.on("messages:cleared", payload => {
    if (activeScope && payload.scope === activeScope.type && Number(payload.scopeId) === Number(activeScope.id)) {
      $("messages").innerHTML = "";
      renderPinned();
    }
  });

  wireCallSocket();
}

async function refreshEverything() {
  await Promise.all([refreshSpaces(), refreshChats(), refreshFriends()]);
  if (!activeScope) {
    if (chats[0]) {
      openChat(chats[0].id);
    } else {
      showDMHome();
    }
  }
  updateViewMode();
}

async function refreshSpaces() {
  const data = await api("/api/spaces");
  spaces = data.spaces || [];
  $("spaceList").innerHTML = spaces.map(space => `
    <button class="space-pill ${activeSpace && Number(activeSpace.id) === Number(space.id) ? 'active' : ''}" onclick="selectSpace(${space.id})" title="${esc(space.name)}">
      <img src="${space.icon || "/logo-mark.svg"}" alt="">
    </button>
  `).join("");
  if (activeSpace) {
    activeSpace = spaces.find(s => Number(s.id) === Number(activeSpace.id)) || null;
  }
  renderSpaceSidebar();
  updateViewMode();
}

function renderSpaceSidebar() {
  const section = $("serverChannelsSection");
  if (activeSpace) {
    $("activeSpaceName").textContent = activeSpace.name;
    if (section) section.classList.remove("hidden");
    $("channelList").innerHTML = (activeSpace.channels || []).length ? activeSpace.channels.map(ch => `
      <button class="row-btn ${activeChannel && Number(activeChannel.id) === Number(ch.id) ? 'active' : ''}" type="button" onclick="openChannel(${ch.id})">
        <div class="row-meta"><b># ${esc(ch.name)}</b><small>${esc(activeSpace.name)} channel</small></div>
      </button>
    `).join("") : `<div class="soft-empty">No channels yet. Tap + to create one.</div>`;
  } else {
    $("activeSpaceName").textContent = "messages";
    if (section) section.classList.add("hidden");
    $("channelList").innerHTML = "";
  }
  updateViewMode();
}

async function refreshChats() {
  const data = await api("/api/chats");
  chats = data.chats;
  $("chatList").innerHTML = chats.map(chat => `
    <button class="row-btn ${activeChat && Number(activeChat.id) === Number(chat.id) ? 'active' : ''}" type="button" onclick="openChat(${chat.id})">
      <img src="${chat.avatar}" alt="">
      <div class="row-meta"><b>${esc(chat.title)}</b><small>${esc(chat.last ? chat.last.body : 'No messages yet')}</small></div>
    </button>
  `).join("");
}

async function refreshFriends() {
  const data = await api("/api/friends");
  friends = data.friends;
  $("friendList").innerHTML = friends.map(friend => `
    <button class="row-btn" type="button" onclick="openDM(${friend.id})">
      <img src="${friend.avatar}" alt="">
      <div class="row-meta"><b>${esc(friend.display_name)}</b><small>@${esc(friend.username)} · ${esc(friend.status || 'online')}</small></div>
    </button>
  `).join("");
  $("requests").innerHTML = data.incoming.map(req => `
    <div class="request-card">
      <img src="${req.avatar}" style="width:40px;height:40px;border-radius:14px" alt="">
      <div class="row-meta"><b>${esc(req.display_name)}</b><small>@${esc(req.username)}</small></div>
      <button type="button" onclick="respondFriend(${req.request_id}, 'accept')">Accept</button>
      <button type="button" class="danger" onclick="respondFriend(${req.request_id}, 'decline')">Decline</button>
    </div>
  `).join("");
  renderGroupFriends();
  renderMembers();
}

function refreshSidebarBits() {
  refreshChats();
  if (activeScope?.type === "channel") loadMessages("channel", activeScope.id, false);
  else if (activeScope?.type === "chat") loadMessages("chat", activeScope.id, false);
}

function selectSpace(spaceId) {
  activeSpace = spaces.find(s => Number(s.id) === Number(spaceId)) || null;
  activeChannel = null;
  activeChat = null;
  activeScope = null;
  replyTarget = null;
  renderSpaceSidebar();
  refreshSpaces();
  refreshChats();
  if (activeSpace) {
    setRoomHeader(activeSpace.name, "Select a channel from this server.", "/logo-mark.svg");
    $("messages").innerHTML = `
      <div class="empty-state">
        <img src="/logo-mark.svg" alt="">
        <h2>${esc(activeSpace.name)}</h2>
        <p>Choose a channel on the left, or tap the music-note logo to return to your messages.</p>
      </div>
    `;
    renderPinned();
    renderMembers();
    updateViewMode();
  }
}

function openDM(userId) {
  const chat = chats.find(c => c.type === "dm" && c.members.some(m => Number(m.id) === Number(userId)));
  if (!chat) return toast("The DM appears after the request is accepted.");
  openChat(chat.id);
}

function setRoomHeader(title, subtitle, avatar) {
  $("roomTitle").textContent = title;
  $("roomSubtitle").textContent = subtitle;
  $("roomAvatar").src = avatar || "/logo-mark.svg";
}

async function openChannel(channelId) {
  activeChannel = activeSpace?.channels?.find(c => Number(c.id) === Number(channelId)) || spaces.flatMap(s => s.channels || []).find(c => Number(c.id) === Number(channelId));
  if (!activeChannel) return;
  if (!activeSpace) activeSpace = spaces.find(s => (s.channels || []).some(c => Number(c.id) === Number(channelId))) || null;
  activeChat = null;
  activeScope = { type: "channel", id: activeChannel.id };
  $("sidebar").classList.remove("open");
  setRoomHeader(`# ${activeChannel.name}`, `${activeSpace?.name || "Server"} channel`, "/logo-mark.svg");
  renderSpaceSidebar();
  updateViewMode();
  await loadMessages("channel", activeChannel.id);
  renderMembers();
}

async function openChat(chatId) {
  activeSpace = null;
  activeChannel = null;
  activeChat = chats.find(c => Number(c.id) === Number(chatId));
  if (!activeChat) return;
  activeScope = { type: "chat", id: activeChat.id };
  $("sidebar").classList.remove("open");
  setRoomHeader(activeChat.title, activeChat.members.map(m => m.display_name).join(", "), activeChat.avatar || "/user-default.svg");
  renderSpaceSidebar();
  updateViewMode();
  await loadMessages("chat", activeChat.id);
  refreshChats();
  renderMembers();
}

async function loadMessages(scope, id, scroll = true) {
  socket.emit("watch:scope", { scope, scopeId: id });
  const data = await api(`/api/messages/${scope}/${id}`);
  $("messages").innerHTML = data.messages.length ? data.messages.map(messageHTML).join("") : `<div class="empty-chat"><h3>No messages yet</h3><p>Say something to start the conversation.</p></div>`;
  if (scroll) scrollMessages();
  renderPinned();
}

function appendMessage(msg) {
  $("messages").insertAdjacentHTML("beforeend", messageHTML(msg));
  scrollMessages();
  renderPinned();
}

function messageHTML(msg) {
  const mine = Number(msg.sender_id) === Number(me.id);
  const isDeleted = !!msg.deleted;
  const bodyText = esc(msg.body || "").replace(/\n/g, "<br>");
  const time = new Date(msg.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const edited = msg.edited ? '<span class="msg-edited">edited</span>' : '';
  const reactions = (msg.reactions || []).map(r => `<button class="reaction-chip" type="button" onclick="reactMessage(${msg.id}, '${r.emoji}')">${r.emoji} <span>${r.count}</span></button>`).join("");
  const controls = `
    <button type="button" onclick="replyTo(${msg.id}, '${esc(msg.display_name).replace(/'/g, "\'")}')">Reply</button>
    <button type="button" onclick="pinMessage(${msg.id})">${msg.pinned ? 'Unpin' : 'Pin'}</button>
    <button type="button" onclick="reactMessage(${msg.id}, '❤️')">❤️</button>
    <button type="button" onclick="reactMessage(${msg.id}, '😭')">😭</button>
    <button type="button" onclick="reactMessage(${msg.id}, '🔥')">🔥</button>
    ${mine ? `<button type="button" onclick="editMessage(${msg.id})">Edit</button><button type="button" onclick="deleteMessage(${msg.id})">Delete</button>` : ''}
  `;

  const replyBlock = msg.reply_preview ? `
    <div class="reply-inline">
      <span>↪</span>
      <b>${esc(msg.reply_preview.display_name)}</b>
      <small>${esc(msg.reply_preview.body || '').slice(0, 120)}</small>
    </div>
  ` : '';

  const systemLike = /^you missed a call/i.test(String(msg.body || '')) || /^call /i.test(String(msg.body || ''));
  if (systemLike) {
    return `
      <div class="msg system" id="msg-${msg.id}">
        <div class="system-line">
          <span class="system-icon">📞</span>
          <span class="system-copy">${bodyText}</span>
          <small>${time}</small>
        </div>
      </div>
    `;
  }

  return `
    <article class="msg ${mine ? 'mine' : ''} ${isDeleted ? 'deleted' : ''}" id="msg-${msg.id}">
      <img class="avatar" src="${msg.avatar || '/user-default.svg'}" alt="">
      <div class="msg-main">
        <div class="msg-head">
          <b class="msg-name">${esc(msg.display_name)}</b>
          <small class="msg-time">${time}</small>
          ${msg.pinned ? '<span class="msg-badge">Pinned</span>' : ''}
          ${edited}
        </div>
        ${replyBlock}
        <div class="msg-body">${bodyText}</div>
        <div class="msg-reactions">${reactions}</div>
      </div>
      <div class="message-actions">${controls}</div>
    </article>
  `;
}

function scrollMessages() {
  const box = $("messages");
  box.scrollTop = box.scrollHeight;
}

function renderPinned() {
  const cards = [...$("messages").querySelectorAll(".msg .msg-badge")].map(badge => {
    const root = badge.closest('.msg');
    const name = root?.querySelector('.msg-name')?.textContent || "";
    const body = root?.querySelector('.msg-body')?.textContent || "";
    return `<div class="pin-card"><div class="row-meta"><b>${esc(name)}</b><small>${esc((body || '').slice(0, 120))}</small></div></div>`;
  });
  $("pinnedList").innerHTML = cards.join("") || `<p class="muted tiny">No pinned messages yet.</p>`;
}

function renderMembers() {
  let members = [];
  if (activeChat) members = activeChat.members || [];
  else if (activeScope?.type === "channel") {
    members = friends;
    const owner = me;
    const seen = new Set();
    members = [owner, ...members].filter(m => m && !seen.has(m.id) && seen.add(m.id));
  }
  $("memberList").innerHTML = members.map(member => `
    <div class="member-chip">
      <img src="${member.avatar}" alt="">
      <div class="row-meta"><b>${esc(member.display_name)}</b><small>@${esc(member.username)}</small></div>
      <span class="status-dot" style="background:${statusColor(member.status)}"></span>
    </div>
  `).join("") || `<p class="muted tiny">No members to show.</p>`;
}

function statusColor(status) {
  return status === "dnd" ? "#ff5a79" : status === "idle" ? "#f5c15d" : status === "offline" ? "#68718c" : "#3ed49a";
}

function replyTo(id, name) {
  replyTarget = id;
  $("replyBanner").classList.remove("hidden");
  $("replyBanner").innerHTML = `Replying to <b>${esc(name)}</b> <button type="button" onclick="clearReply()">cancel</button>`;
}
function clearReply() {
  replyTarget = null;
  $("replyBanner").classList.add("hidden");
  $("replyBanner").innerHTML = "";
}

function reactMessage(id, emoji) { socket.emit("message:react", { id, emoji }); }
function pinMessage(id) { socket.emit("message:pin", { id }); }

function editMessage(id) {
  const text = $(`msg-${id}`)?.querySelector("p")?.textContent || "";
  const body = prompt("Edit message", text);
  if (body) socket.emit("message:edit", { id, body });
}
function deleteMessage(id) {
  if (confirm("Delete this message?")) socket.emit("message:delete", { id });
}

async function respondFriend(id, action) {
  await api("/api/friends/respond", { method: "POST", body: JSON.stringify({ requestId: id, action }) });
  refreshFriends(); refreshChats();
}

function renderGroupFriends() {
  $("groupFriends").innerHTML = friends.map(f => `<label><input type="checkbox" value="${f.id}"> ${esc(f.display_name)}</label>`).join("");
}

$("showLogin").onclick = () => {
  $("loginForm").classList.remove("hidden");
  $("registerForm").classList.add("hidden");
  $("showLogin").classList.add("active");
  $("showRegister").classList.remove("active");
};
$("showRegister").onclick = () => {
  $("registerForm").classList.remove("hidden");
  $("loginForm").classList.add("hidden");
  $("showRegister").classList.add("active");
  $("showLogin").classList.remove("active");
};

$("loginForm").onsubmit = async e => {
  e.preventDefault();
  try {
    const data = await api("/api/login", { method: "POST", body: JSON.stringify({ username: $("loginUsername").value, password: $("loginPassword").value }) });
    me = data.user;
    showApp();
  } catch (err) { $("authError").textContent = err.message; }
};
$("registerForm").onsubmit = async e => {
  e.preventDefault();
  try {
    const data = await api("/api/register", { method: "POST", body: JSON.stringify({ username: $("registerUsername").value, displayName: $("registerDisplay").value, password: $("registerPassword").value }) });
    me = data.user;
    showApp();
  } catch (err) { $("authError").textContent = err.message; }
};

$("selfCard").onclick = () => openModal("profileModal");
$("openSettings").onclick = () => openModal("settingsModal");
$("createSpaceBtn").onclick = () => openModal("spaceModal");
$("newChannelBtn").onclick = () => openModal("channelModal");
$("newGroupBtn").onclick = () => openModal("groupModal");
document.querySelectorAll(".closeModal").forEach(btn => btn.onclick = () => btn.closest(".modal").classList.add("hidden"));
function openModal(id) { $(id).classList.remove("hidden"); }

$("logoutBtn").onclick = async () => { await api("/api/logout", { method: "POST" }); location.reload(); };

$("saveProfileBtn").onclick = async () => {
  try {
    const data = await api("/api/me", {
      method: "PUT",
      body: JSON.stringify({
        displayName: $("profileDisplay").value,
        tagline: $("profileTagline").value,
        bio: $("profileBio").value,
        status: $("profileStatus").value
      })
    });
    me = data.user;
    renderSelf();
    socket.emit("presence:set", { status: me.status });
    toast("Profile saved.");
  } catch (err) { toast(err.message); }
};

$("avatarFile").onchange = async () => {
  const file = $("avatarFile").files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("avatar", file);
  const res = await fetch("/api/me/avatar", { method: "POST", credentials: "include", body: fd });
  const data = await res.json();
  if (!res.ok) return toast(data.error || "Upload failed.");
  me = data.user;
  renderSelf();
};

$("saveSpaceBtn").onclick = async () => {
  await api("/api/spaces", { method: "POST", body: JSON.stringify({ name: $("spaceName").value, theme: $("spaceTheme").value }) });
  $("spaceModal").classList.add("hidden");
  refreshSpaces();
};

$("saveChannelBtn").onclick = async () => {
  if (!activeSpace) return toast("Select a space first.");
  await api(`/api/spaces/${activeSpace.id}/channels`, { method: "POST", body: JSON.stringify({ name: $("channelName").value }) });
  $("channelModal").classList.add("hidden");
  refreshSpaces();
};

$("createGroupBtn").onclick = async () => {
  const ids = [...document.querySelectorAll("#groupFriends input:checked")].map(input => Number(input.value));
  await api("/api/chats/group", { method: "POST", body: JSON.stringify({ name: $("groupName").value, userIds: ids }) });
  $("groupModal").classList.add("hidden");
  refreshChats();
};

$("addFriendBtn").onclick = async () => {
  try {
    await api("/api/friends/request", { method: "POST", body: JSON.stringify({ username: $("friendUsername").value }) });
    $("friendUsername").value = "";
    toast("Friend request sent.");
  } catch (err) { toast(err.message); }
};

$("composer").onsubmit = e => {
  e.preventDefault();
  if (!activeScope) return toast("Open a room first.");
  const body = $("messageInput").value.trim();
  if (!body) return;
  socket.emit("message:send", { scope: activeScope.type, scopeId: activeScope.id, body, replyTo: replyTarget });
  $("messageInput").value = "";
  clearReply();
  socket.emit("typing:stop", { scope: activeScope.type, scopeId: activeScope.id });
};

$("messageInput").addEventListener("input", () => {
  if (!activeScope) return;
  socket.emit("typing:start", { scope: activeScope.type, scopeId: activeScope.id });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => socket.emit("typing:stop", { scope: activeScope.type, scopeId: activeScope.id }), 1000);
});

$("clearRoomBtn").onclick = async () => {
  if (!activeScope) return;
  if (activeScope.type !== "chat") return toast("Clear is enabled for DMs/groups only in this build.");
  if (confirm("Clear this room?")) await api(`/api/messages/chat/${activeScope.id}`, { method: "DELETE" });
};

$("searchInput").addEventListener("keydown", async e => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const q = $("searchInput").value.trim();
  if (!q) return;
  const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
  $("searchResults").innerHTML = data.results.map(msg => `
    <div class="pin-card">
      <div class="row-meta">
        <b>${esc(msg.display_name)}</b>
        <small>${esc(msg.body)}</small>
      </div>
    </div>
  `).join("") || `<p class="muted tiny">No results found.</p>`;
  openModal("searchModal");
});

$("mobileSidebarBtn").onclick = () => $("sidebar").classList.toggle("open");
$("mobileBack").onclick = () => $("sidebar").classList.toggle("open");

$("messageVolume").value = settings.messageVolume;
$("callVolume").value = settings.callVolume;
$("messageVolume").oninput = e => { settings.messageVolume = Number(e.target.value); saveSettings(); };
$("callVolume").oninput = e => { settings.callVolume = Number(e.target.value); saveSettings(); $("remoteAudio").volume = settings.callVolume / 100; };

async function loadDevices() {
  try {
    const temp = await navigator.mediaDevices.getUserMedia({ audio: true });
    temp.getTracks().forEach(track => track.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === "audioinput");
    const speakers = devices.filter(d => d.kind === "audiooutput");
    $("micSelect").innerHTML = `<option value="">Default</option>` + mics.map(d => `<option value="${d.deviceId}">${esc(d.label || "Microphone")}</option>`).join("");
    $("speakerSelect").innerHTML = `<option value="">Default</option>` + speakers.map(d => `<option value="${d.deviceId}">${esc(d.label || "Speaker")}</option>`).join("");
    $("micSelect").value = settings.micId || "";
    $("speakerSelect").value = settings.speakerId || "";
  } catch {}
}
$("refreshDevicesBtn").onclick = loadDevices;
$("micSelect").onchange = e => { settings.micId = e.target.value; saveSettings(); };
$("speakerSelect").onchange = e => { settings.speakerId = e.target.value; saveSettings(); };

async function iceConfig() {
  const data = await api("/api/ice");
  const fallback = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" }
  ];
  const iceServers = [...(data.iceServers || []), ...fallback];
  return { iceServers, iceCandidatePoolSize: 10 };
}
async function getUserMediaStream(withVideo = false) {
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: settings.micId ? { exact: settings.micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false
  });
}
async function createPeer(targetId) {
  const pc = new RTCPeerConnection(await iceConfig());
  activeCall.pc = pc;
  pc.onicecandidate = e => {
    if (e.candidate) socket.emit("call:ice", { scope: activeCall.scope, scopeId: activeCall.scopeId, targetId, candidate: e.candidate });
  };
  pc.ontrack = e => {
    const stream = e.streams[0];
    $("remoteAudio").srcObject = stream;
    $("remoteAudio").volume = settings.callVolume / 100;
    if ($("remoteAudio").setSinkId && settings.speakerId) $("remoteAudio").setSinkId(settings.speakerId).catch(() => {});
    $("remoteAudio").play().catch(() => {});
    const hasVideo = stream.getVideoTracks().length > 0;
    $("remoteVideo").srcObject = hasVideo ? stream : null;
    if (hasVideo) $("remoteVideo").play().catch(() => {});
    $("callStatus").textContent = hasVideo ? "voice + screen connected" : "voice connected";
  };
  pc.onconnectionstatechange = async () => {
    if (pc.connectionState === "connected") {
      activeCall.connected = true;
      $("callStatus").textContent = "connected";
      if (activeCall.wantsScreen && !activeCall.screenStream) {
        try { await startScreenshare(); } catch {}
      }
    }
    if (["failed","disconnected","closed"].includes(pc.connectionState)) {
      $("callStatus").textContent = pc.connectionState;
      if (pc.connectionState === 'failed') toast('Call connection failed. If this keeps happening, add TURN variables to your host.');
    }
  };
  return pc;
}
async function attachLocalMedia(withVideo = false) {
  activeCall.localStream = await getUserMediaStream(withVideo);
  if (withVideo) {
    $("localVideo").srcObject = activeCall.localStream;
    $("localVideo").play().catch(() => {});
  } else {
    $("localVideo").srcObject = null;
  }
  activeCall.localStream.getTracks().forEach(track => activeCall.pc.addTrack(track, activeCall.localStream));
}
function showCall(title, status) {
  $("callModal").classList.remove("hidden");
  $("callTitle").textContent = title;
  $("callStatus").textContent = status;
}
function getCallTarget() {
  if (activeScope?.type === "chat" && activeChat?.members?.length) {
    const other = activeChat.members.find(m => Number(m.id) !== Number(me.id));
    return other || null;
  }
  return null;
}
function resetCall(send = true) {
  if (send && activeCall.peerId) socket.emit("call:end", { scope: activeCall.scope, scopeId: activeCall.scopeId, targetId: activeCall.peerId });
  try { activeCall.pc?.close(); } catch {}
  activeCall.localStream?.getTracks()?.forEach(t => t.stop());
  activeCall.screenStream?.getTracks()?.forEach(t => t.stop());
  activeCall = { pc:null, localStream:null, screenStream:null, scope:null, scopeId:null, peerId:null, incoming:null, pendingIce:[], muted:false, wantsScreen:false, connected:false };
  $("localVideo").srcObject = null; $("remoteVideo").srcObject = null; $("remoteAudio").srcObject = null; $("callModal").classList.add("hidden"); $("incomingControls").classList.add("hidden"); $("toggleScreenBtn").textContent = "Share screen"; $("muteBtn").textContent = "Mute";
}
$("callBtn").onclick = () => startCall(false);
$("screenShareBtn").onclick = () => startCall(true);
async function startCall(withScreen) {
  if (!activeScope || activeScope.type !== "chat" || !activeChat || activeChat.type !== "dm") return toast("Calls are available in one-on-one DMs.");
  const target = getCallTarget();
  if (!target) return toast("No user found for this call.");
  activeCall.scope = activeScope.type;
  activeCall.scopeId = activeScope.id;
  activeCall.peerId = target.id;
  activeCall.wantsScreen = !!withScreen;
  activeCall.connected = false;
  showCall(`Calling ${target.display_name}`, withScreen ? "ringing... will share screen after connect" : "ringing...");
  socket.emit("call:invite", { scope: activeScope.type, scopeId: activeScope.id, targetId: target.id, media: withScreen ? "screen" : "audio" });
}
$("acceptCallBtn").onclick = () => {
  const incoming = activeCall.incoming;
  if (!incoming) return;
  socket.emit("call:accept", { scope: incoming.scope, scopeId: incoming.scopeId, targetId: incoming.from.id });
  $("incomingControls").classList.add("hidden");
  $("callStatus").textContent = "connecting";
};
$("declineCallBtn").onclick = () => {
  if (activeCall.incoming) socket.emit("call:decline", { scope: activeCall.incoming.scope, scopeId: activeCall.incoming.scopeId, targetId: activeCall.incoming.from.id });
  resetCall(false);
};
$("endCallBtn").onclick = () => resetCall(true);
$("muteBtn").onclick = () => {
  activeCall.muted = !activeCall.muted;
  activeCall.localStream?.getAudioTracks().forEach(track => track.enabled = !activeCall.muted);
  $("muteBtn").textContent = activeCall.muted ? "Unmute" : "Mute";
};
$("toggleScreenBtn").onclick = async () => {
  if (!activeCall.pc) return toast("Start a call first.");
  if (!activeCall.screenStream) {
    try {
      await startScreenshare();
    } catch (err) { toast("Screen share cancelled."); }
  } else {
    await stopScreenshare();
  }
};
async function startScreenshare() {
  activeCall.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const track = activeCall.screenStream.getVideoTracks()[0];
  let sender = activeCall.pc.getSenders().find(s => s.track && s.track.kind === "video");
  if (sender) await sender.replaceTrack(track);
  else activeCall.pc.addTrack(track, activeCall.screenStream);
  $("localVideo").srcObject = activeCall.screenStream;
  $("localVideo").play().catch(() => {});
  $("toggleScreenBtn").textContent = "Stop sharing";
  track.onended = () => stopScreenshare();
}
async function stopScreenshare() {
  if (!activeCall.screenStream) return;
  activeCall.screenStream.getTracks().forEach(t => t.stop());
  activeCall.screenStream = null;
  const cameraTrack = activeCall.localStream?.getVideoTracks()?.[0];
  const sender = activeCall.pc?.getSenders().find(s => s.track && s.track.kind === "video");
  if (cameraTrack && sender) await sender.replaceTrack(cameraTrack);
  $("localVideo").srcObject = activeCall.localStream;
  $("toggleScreenBtn").textContent = "Share screen";
}

function wireCallSocket() {
  socket.on("call:incoming", data => {
    activeCall.scope = data.scope;
    activeCall.scopeId = data.scopeId;
    activeCall.peerId = data.from.id;
    activeCall.incoming = data;
    showCall(`Incoming call from ${data.from.display_name}`, data.media === "screen" ? "incoming call + screen share" : "incoming voice call");
    $("incomingControls").classList.remove("hidden");
  });

  socket.on("call:accepted", async data => {
    try {
      showCall(`Call with ${data.from.display_name}`, "connecting voice...");
      activeCall.peerId = data.from.id;
      activeCall.pc = await createPeer(data.from.id);
      activeCall.scope = data.scope; activeCall.scopeId = data.scopeId;
      await attachLocalMedia(false);
      const offer = await activeCall.pc.createOffer();
      await activeCall.pc.setLocalDescription(offer);
      socket.emit("call:offer", { scope: data.scope, scopeId: data.scopeId, targetId: data.from.id, offer });
    } catch (err) { toast(err.message); resetCall(true); }
  });

  socket.on("call:offer", async data => {
    try {
      activeCall.scope = data.scope; activeCall.scopeId = data.scopeId; activeCall.peerId = data.fromUserId;
      activeCall.pc = await createPeer(data.fromUserId);
      await attachLocalMedia(false);
      await activeCall.pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      for (const c of activeCall.pendingIce) await activeCall.pc.addIceCandidate(new RTCIceCandidate(c));
      activeCall.pendingIce = [];
      const answer = await activeCall.pc.createAnswer();
      await activeCall.pc.setLocalDescription(answer);
      socket.emit("call:answer", { scope: data.scope, scopeId: data.scopeId, targetId: data.fromUserId, answer });
      $("callStatus").textContent = "connecting";
    } catch (err) { toast(err.message); resetCall(true); }
  });

  socket.on("call:answer", async data => {
    try {
      await activeCall.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      for (const c of activeCall.pendingIce) await activeCall.pc.addIceCandidate(new RTCIceCandidate(c));
      activeCall.pendingIce = [];
    } catch (err) { toast(err.message); }
  });

  socket.on("call:ice", async data => {
    try {
      if (activeCall.pc && activeCall.pc.remoteDescription) await activeCall.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      else activeCall.pendingIce.push(data.candidate);
    } catch (err) { console.warn(err); }
  });

  socket.on("call:declined", () => { toast("Call declined."); resetCall(false); });
  socket.on("call:end", () => { toast("Call ended."); resetCall(false); });
}

window.selectSpace = selectSpace;
window.openChannel = openChannel;
window.openChat = openChat;
window.openDM = openDM;
window.respondFriend = respondFriend;
window.replyTo = replyTo;
window.clearReply = clearReply;
window.reactMessage = reactMessage;
window.pinMessage = pinMessage;
window.editMessage = editMessage;
window.deleteMessage = deleteMessage;

boot();


// Settings glass tabs
document.querySelectorAll(".settings-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".settings-tab").forEach(x => x.classList.remove("active"));
    document.querySelectorAll(".settings-page").forEach(x => x.classList.remove("active"));
    btn.classList.add("active");
    document.querySelector(`.settings-page[data-page="${btn.dataset.tab}"]`)?.classList.add("active");
  });
});
const settingsProfileBtn = document.getElementById("settingsOpenProfile");
if (settingsProfileBtn) {
  settingsProfileBtn.addEventListener("click", () => {
    document.getElementById("settingsModal")?.classList.add("hidden");
    document.getElementById("profileModal")?.classList.remove("hidden");
  });
}


function showDMHome() {
  activeSpace = null;
  activeChannel = null;
  activeChat = null;
  activeScope = null;
  replyTarget = null;
  renderSpaceSidebar();
  refreshSpaces();
  refreshChats();
  setRoomHeader("Your messages", "Pick a DM, group, or create a new conversation.", "/logo-mark.svg");
  $("messages").innerHTML = `
    <div class="empty-state">
      <img src="/logo-mark.svg" alt="">
      <h2>Your messages</h2>
      <p>Add a friend, accept a request, or create a group chat. Servers stay hidden until you open one.</p>
    </div>
  `;
  renderPinned();
  renderMembers();
  updateViewMode();
}

function updateViewMode() {
  const isChat = !!(activeScope && activeScope.type === "chat");
  const isChannel = !!(activeScope && activeScope.type === "channel");
  const isServer = !!activeSpace;
  $("chatActions")?.classList.toggle("hidden", !isChat);
  $("composer")?.classList.toggle("hidden", !(isChat || isChannel));
  $("newChannelBtn")?.classList.toggle("hidden", !isServer);
  $("newGroupBtn")?.classList.remove("hidden");
  $("serverChannelsSection")?.classList.toggle("hidden", !isServer);
}

const dmHomeBtn = document.getElementById("dmHomeBtn");
if (dmHomeBtn) dmHomeBtn.addEventListener("click", showDMHome);
