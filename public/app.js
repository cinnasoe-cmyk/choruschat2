
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
let activeCall = {
  pc: null,
  localStream: null,
  screenStream: null,
  chatId: null,
  peerId: null,
  incoming: null,
  pendingIce: [],
  muted: false,
  peerMuted: false,
  speaking: false,
  peerSpeaking: false,
  speakingTimer: null,
  speakingContext: null,
  connected: false
};

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
    <button class="row-btn" type="button" onclick="openDM(${friend.id}); closeFriendsTab()">
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
  closeFriendsTab();
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
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  const attachmentsHTML = attachments.length ? `<div class="msg-attachments">${attachments.map(file => {
    const url = esc(file.url || "");
    const name = esc(file.name || "attachment");
    const mime = String(file.type || "");
    if (mime.startsWith("image/")) return `<a class="image-attachment" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${name}"></a>`;
    return `<a class="file-attachment" href="${url}" target="_blank" rel="noopener"><img src="/icons/attach.svg" alt=""><span>${name}</span></a>`;
  }).join("")}</div>` : "";
  const time = new Date(msg.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const edited = msg.edited ? '<span class="msg-edited">edited</span>' : '';
  const reactions = (msg.reactions || []).map(r => `<button class="reaction-chip" type="button" onclick="reactMessage(${msg.id}, '${r.emoji}')">${r.emoji} <span>${r.count}</span></button>`).join("");
  const controls = `
    <button type="button" onclick="replyTo(${msg.id}, '${esc(msg.display_name).replace(/'/g, "\'")}')">Reply</button>
    <button type="button" onclick="pinMessage(${msg.id})">${msg.pinned ? 'Unpin' : 'Pin'}</button>
    <button type="button" onclick="reactMessage(${msg.id}, '❤️')">❤️</button>
    <button type="button" onclick="reactMessage(${msg.id}, '😭')">😭</button>
    <button type="button" onclick="reactMessage(${msg.id}, '🔥')">🔥</button>
    ${mine ? `<button type="button" onclick="editMessage(${msg.id})">Edit</button><button type="button" onclick="deleteMessage(${msg.id}, this)">Delete</button>` : ''}
  `;

  const replyBlock = msg.reply_preview ? `
    <div class="reply-inline">
      <span>↪</span>
      <b>${esc(msg.reply_preview.display_name)}</b>
      <small>${esc(msg.reply_preview.body || '').slice(0, 120)}</small>
    </div>
  ` : '';

  const callSystemLike = /^you missed a call/i.test(String(msg.body || '')) || /^call /i.test(String(msg.body || '')) || /started a call|call ended|ended a call/i.test(String(msg.body || ''));
  if (callSystemLike) {
    return `
      <div class="msg system call-system" id="msg-${msg.id}">
        <div class="system-line">
          <span class="system-icon" aria-hidden="true"><img src="/icons/phone.svg" alt=""></span>
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
        ${attachmentsHTML}
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
  const msgEl = $(`msg-${id}`);
  const bodyEl = msgEl?.querySelector(".msg-body");
  if (!bodyEl || msgEl.classList.contains("deleted") || msgEl.querySelector(".inline-editor")) return;

  const oldText = bodyEl.innerText || bodyEl.textContent || "";
  const editor = document.createElement("form");
  editor.className = "inline-editor";

  const input = document.createElement("textarea");
  input.value = oldText;
  input.maxLength = 2000;
  input.rows = Math.min(6, Math.max(2, oldText.split("\n").length));

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.textContent = "Save";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";

  editor.append(input, saveBtn, cancelBtn);
  bodyEl.style.display = "none";
  bodyEl.after(editor);
  input.focus();
  input.select();

  editor.onsubmit = e => {
    e.preventDefault();
    const body = input.value.trim();
    if (body && body !== oldText.trim()) socket.emit("message:edit", { id, body });
    editor.remove();
    bodyEl.style.display = "";
  };
  cancelBtn.onclick = () => { editor.remove(); bodyEl.style.display = ""; };
}

function deleteMessage(id, btn) {
  if (btn && btn.dataset.confirm !== "yes") {
    btn.dataset.confirm = "yes";
    btn.textContent = "Confirm?";
    setTimeout(() => {
      if (btn.dataset.confirm === "yes") {
        btn.dataset.confirm = "";
        btn.textContent = "Delete";
      }
    }, 3000);
    return;
  }
  socket.emit("message:delete", { id });
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


function setSettingsTab(tabName) {
  document.querySelectorAll(".settings-tab").forEach(x => x.classList.toggle("active", x.dataset.tab === tabName));
  document.querySelectorAll(".settings-page").forEach(x => x.classList.toggle("active", x.dataset.page === tabName));
}
function closeSelfPopup() {
  $("selfPopup")?.classList.add("hidden");
}
function openSelfPopup() {
  const popup = $("selfPopup");
  if (!popup) return;
  if ($("selfPopupAvatar")) $("selfPopupAvatar").src = me?.avatar || "/user-default.svg";
  if ($("selfPopupName")) $("selfPopupName").textContent = me?.display_name || me?.username || "user";
  if ($("selfPopupUser")) $("selfPopupUser").textContent = "@" + (me?.username || "user");
  if ($("selfPopupBio")) $("selfPopupBio").textContent = me?.bio || me?.tagline || "No bio yet.";
  if ($("selfPopupStatus")) $("selfPopupStatus").textContent = me?.status || "online";
  popup.classList.toggle("hidden");
}
$("selfCard").onclick = (e) => {
  e.stopPropagation();
  openSelfPopup();
};
document.addEventListener("click", (e) => {
  if (!$("selfPopup") || $("selfPopup").classList.contains("hidden")) return;
  if ($("selfPopup").contains(e.target) || $("selfCard").contains(e.target)) return;
  closeSelfPopup();
});
$("selfPopupEditBtn")?.addEventListener("click", () => {
  closeSelfPopup();
  openModal("settingsModal");
  setSettingsTab("profile");
});
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

if ($("attachBtn")) $("attachBtn").onclick = () => $("fileInput")?.click();
if ($("fileInput")) $("fileInput").addEventListener("change", () => {
  const count = $("fileInput").files?.length || 0;
  if (count) toast(`${count} file${count === 1 ? "" : "s"} ready to send.`);
});

async function uploadComposerFiles() {
  const input = $("fileInput");
  const files = [...(input?.files || [])];
  if (!files.length) return [];
  const uploaded = [];
  for (const file of files) {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/attachments", { method: "POST", body: form, credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not upload file.");
    uploaded.push(data.file);
  }
  input.value = "";
  return uploaded;
}

$("composer").onsubmit = async e => {
  e.preventDefault();
  if (!activeScope) return toast("Open a room first.");
  const body = $("messageInput").value.trim();
  const hasFiles = ($("fileInput")?.files?.length || 0) > 0;
  if (!body && !hasFiles) return;
  try {
    const attachments = await uploadComposerFiles();
    socket.emit("message:send", { scope: activeScope.type, scopeId: activeScope.id, body, attachments, replyTo: replyTarget });
    $("messageInput").value = "";
    clearReply();
    socket.emit("typing:stop", { scope: activeScope.type, scopeId: activeScope.id });
  } catch (err) { toast(err.message || "Could not send attachment."); }
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
  return { iceServers: [...(data.iceServers || []), ...fallback], iceCandidatePoolSize: 10 };
}

async function ensureLocalAudio() {
  if (activeCall.localStream && activeCall.localStream.active) return activeCall.localStream;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Your browser does not support voice calls.");
  }
  activeCall.localStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: settings.micId ? { exact: settings.micId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  });
  return activeCall.localStream;
}

async function createPeer(peerId) {
  const pc = new RTCPeerConnection(await iceConfig());
  activeCall.pc = pc;

  const local = await ensureLocalAudio();
  local.getTracks().forEach(track => pc.addTrack(track, local));

  pc.onicecandidate = event => {
    if (event.candidate && activeCall.chatId && peerId) {
      socket.emit("call:ice", { chatId: activeCall.chatId, targetId: peerId, candidate: event.candidate });
    }
  };

  pc.ontrack = event => {
    const stream = event.streams?.[0];
    if (!stream) return;
    const audio = $("remoteAudio");
    audio.srcObject = stream;
    audio.volume = settings.callVolume / 100;
    if (audio.setSinkId && settings.speakerId) audio.setSinkId(settings.speakerId).catch(() => {});
    audio.play().catch(() => toast("Click the call bar once to enable audio."));
    activeCall.connected = true;
    setCallStatus("connected");
  };

  const updateState = () => {
    const state = pc.connectionState || pc.iceConnectionState;
    if (!state) return;
    if (state === "connected" || state === "completed") {
      activeCall.connected = true;
      setCallStatus("connected");
    } else if (["failed", "disconnected", "closed"].includes(state)) {
      setCallStatus(state);
      if (state === "failed") toast("Call failed to connect. On Render, add TURN_URL, TURN_USERNAME, and TURN_PASSWORD if users are on different networks.");
    } else {
      setCallStatus(state);
    }
  };
  pc.onconnectionstatechange = updateState;
  pc.oniceconnectionstatechange = updateState;

  return pc;
}

function showCall(title, status, incoming = false) {
  const callEl = $("callModal");
  callEl.classList.remove("hidden", "ringing", "incoming-call", "connected-call");
  const normalized = String(status || "").toLowerCase();
  if (incoming) callEl.classList.add("incoming-call", "ringing");
  else if (normalized.includes("ring") || normalized.includes("incoming") || normalized.includes("getting microphone")) callEl.classList.add("ringing");
  else if (normalized.includes("connected")) callEl.classList.add("connected-call");
  $("incomingControls").classList.toggle("hidden", !incoming);
  $("callTitle").textContent = title;
  $("callStatus").textContent = status;
  const peer = activeCall.incoming?.from || getCallTarget() || activeChat?.members?.find(m => Number(m.id) !== Number(me.id));
  if ($("callSelfAvatar")) $("callSelfAvatar").src = me?.avatar || "/user-default.svg";
  if ($("callPeerAvatar")) $("callPeerAvatar").src = peer?.avatar || activeChat?.avatar || "/user-default.svg";
  updateCallMuteUi();
  $("remoteVideo").style.display = "none";
  $("localVideo").style.display = "none";
}

function setCallStatus(status) {
  if ($("callStatus")) $("callStatus").textContent = status;
  const callEl = $("callModal");
  if (!callEl) return;
  callEl.classList.remove("ringing", "connected-call");
  const normalized = String(status || "").toLowerCase();
  if (!normalized.includes("incoming")) callEl.classList.remove("incoming-call");
  if (normalized.includes("connected")) callEl.classList.add("connected-call");
  else if (normalized.includes("ring") || normalized.includes("incoming") || normalized.includes("getting microphone") || normalized.includes("connecting")) callEl.classList.add("ringing");
}

function getCallTarget() {
  if (activeScope?.type === "chat" && activeChat?.type === "dm" && activeChat?.members?.length) {
    return activeChat.members.find(m => Number(m.id) !== Number(me.id)) || null;
  }
  return null;
}


function stopSpeakingMonitor() {
  if (activeCall.speakingTimer) {
    clearInterval(activeCall.speakingTimer);
    activeCall.speakingTimer = null;
  }
  try { activeCall.speakingContext?.close?.(); } catch {}
  activeCall.speakingContext = null;
}

function startSpeakingMonitor() {
  stopSpeakingMonitor();
  if (!activeCall.localStream) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const source = ctx.createMediaStreamSource(activeCall.localStream);
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    activeCall.speakingContext = ctx;
    let lastState = false;
    let lastSent = 0;
    activeCall.speakingTimer = setInterval(() => {
      if (!activeCall.localStream) return;
      analyser.getByteFrequencyData(data);
      let total = 0;
      for (const value of data) total += value;
      const avg = total / data.length;
      const speaking = !activeCall.muted && avg > 13;
      activeCall.speaking = speaking;
      updateCallMuteUi();
      const now = Date.now();
      if ((speaking !== lastState || now - lastSent > 900) && activeCall.chatId && activeCall.peerId) {
        socket.emit("call:speaking", { chatId: activeCall.chatId, targetId: activeCall.peerId, speaking });
        lastState = speaking;
        lastSent = now;
      }
    }, 140);
  } catch (err) {
    console.warn("Voice activity unavailable", err);
  }
}

function updateCallMuteUi() {
  const selfBadge = $("callSelfMuted");
  const peerBadge = $("callPeerMuted");
  if (selfBadge) selfBadge.classList.toggle("hidden", !activeCall.muted);
  if (peerBadge) peerBadge.classList.toggle("hidden", !activeCall.peerMuted);
  $("callSelfWrap")?.classList.toggle("speaking", !!activeCall.speaking && !activeCall.muted);
  $("callPeerWrap")?.classList.toggle("speaking", !!activeCall.peerSpeaking && !activeCall.peerMuted);
  const muteSpan = $("muteBtn")?.querySelector("span");
  const muteImg = $("muteBtn")?.querySelector("img");
  if (muteSpan) muteSpan.textContent = activeCall.muted ? "Unmute" : "Mute";
  if (muteImg) muteImg.src = activeCall.muted ? "/icons/mic-off.svg" : "/icons/mic.svg";
}

function resetCall(send = true) {
  if (send && activeCall.peerId && activeCall.chatId) socket.emit("call:end", { chatId: activeCall.chatId, targetId: activeCall.peerId });
  try { activeCall.pc?.close(); } catch {}
  activeCall.localStream?.getTracks()?.forEach(track => track.stop());
  activeCall.screenStream?.getTracks()?.forEach(track => track.stop());
  stopSpeakingMonitor();
  activeCall = { pc:null, localStream:null, screenStream:null, chatId:null, peerId:null, incoming:null, pendingIce:[], muted:false, peerMuted:false, speaking:false, peerSpeaking:false, speakingTimer:null, speakingContext:null, connected:false };
  $("localVideo").srcObject = null;
  $("remoteVideo").srcObject = null;
  $("remoteAudio").srcObject = null;
  $("callModal").classList.add("hidden");
  $("incomingControls").classList.add("hidden");
  const shareSpan = $("toggleScreenBtn")?.querySelector("span"); if (shareSpan) shareSpan.textContent = "Share screen";
  const muteSpan = $("muteBtn")?.querySelector("span");
  const muteImg = $("muteBtn")?.querySelector("img");
  if (muteSpan) muteSpan.textContent = "Mute";
  if (muteImg) muteImg.src = "/icons/mic.svg";
  updateCallMuteUi();
}

$("callBtn").onclick = () => startCall();
if ($("screenShareBtn")) {
  $("screenShareBtn").classList.add("hidden");
  $("screenShareBtn").onclick = () => toast("Screen share is inside the call controls.");
}

async function startCall() {
  if (!activeChat || activeChat.type !== "dm") return toast("Open a one-on-one DM to call.");
  const target = getCallTarget();
  if (!target) return toast("No user found for this call.");
  if (activeCall.pc || activeCall.incoming) return toast("You are already in a call.");
  try {
    activeCall.chatId = activeChat.id;
    activeCall.peerId = target.id;
    showCall(`Calling ${target.display_name}`, "getting microphone", false);
    await ensureLocalAudio();
    startSpeakingMonitor();
    setCallStatus("ringing");
    socket.emit("call:invite", { chatId: activeChat.id, targetId: target.id });
  } catch (err) {
    toast(err.message || "Microphone permission was blocked.");
    resetCall(false);
  }
}

$("acceptCallBtn").onclick = async () => {
  const incoming = activeCall.incoming;
  if (!incoming) return;
  try {
    setCallStatus("getting microphone");
    await ensureLocalAudio();
    startSpeakingMonitor();
    socket.emit("call:accept", { chatId: incoming.chatId, targetId: incoming.from.id });
    $("incomingControls").classList.add("hidden");
    setCallStatus("connecting");
  } catch (err) {
    toast(err.message || "Microphone permission was blocked.");
    socket.emit("call:decline", { chatId: incoming.chatId, targetId: incoming.from.id });
    resetCall(false);
  }
};

$("declineCallBtn").onclick = () => {
  if (activeCall.incoming) socket.emit("call:decline", { chatId: activeCall.incoming.chatId, targetId: activeCall.incoming.from.id });
  resetCall(false);
};

$("endCallBtn").onclick = () => resetCall(true);

$("muteBtn").onclick = () => {
  if (!activeCall.localStream) return toast("Join the call before muting.");
  activeCall.muted = !activeCall.muted;
  activeCall.localStream.getAudioTracks().forEach(track => track.enabled = !activeCall.muted);
  if (activeCall.muted) { activeCall.speaking = false; socket.emit("call:speaking", { chatId: activeCall.chatId, targetId: activeCall.peerId, speaking:false }); }
  updateCallMuteUi();
  if (activeCall.chatId && activeCall.peerId) {
    socket.emit("call:mute", { chatId: activeCall.chatId, targetId: activeCall.peerId, muted: activeCall.muted });
  }
};

$("toggleScreenBtn").onclick = () => toast("Simple voice calling is enabled. Screen share is not included in this version.");
$("callModal").onclick = () => $("remoteAudio").play().catch(() => {});

function wireCallSocket() {
  socket.on("call:incoming", data => {
    if (activeCall.pc || activeCall.incoming) {
      socket.emit("call:decline", { chatId: data.chatId, targetId: data.from.id });
      return;
    }
    activeCall.chatId = data.chatId;
    activeCall.peerId = data.from.id;
    activeCall.incoming = data;
    showCall(`Incoming call from ${data.from.display_name}`, "incoming voice call", true);
  });

  socket.on("call:accepted", async data => {
    try {
      showCall(`Call with ${data.from.display_name}`, "connecting", false);
      activeCall.chatId = data.chatId;
      activeCall.peerId = data.from.id;
      activeCall.pc = await createPeer(data.from.id);
      const offer = await activeCall.pc.createOffer();
      await activeCall.pc.setLocalDescription(offer);
      socket.emit("call:offer", { chatId: data.chatId, targetId: data.from.id, offer });
    } catch (err) { toast(err.message || "Could not start call."); resetCall(true); }
  });

  socket.on("call:offer", async data => {
    try {
      activeCall.chatId = data.chatId;
      activeCall.peerId = data.fromUserId;
      activeCall.pc = await createPeer(data.fromUserId);
      await activeCall.pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      for (const c of activeCall.pendingIce.splice(0)) await activeCall.pc.addIceCandidate(new RTCIceCandidate(c));
      const answer = await activeCall.pc.createAnswer();
      await activeCall.pc.setLocalDescription(answer);
      socket.emit("call:answer", { chatId: data.chatId, targetId: data.fromUserId, answer });
      setCallStatus("connecting");
    } catch (err) { toast(err.message || "Could not answer call."); resetCall(true); }
  });

  socket.on("call:answer", async data => {
    try {
      if (!activeCall.pc) return;
      await activeCall.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      for (const c of activeCall.pendingIce.splice(0)) await activeCall.pc.addIceCandidate(new RTCIceCandidate(c));
      setCallStatus("connecting");
    } catch (err) { toast(err.message || "Could not connect call."); }
  });

  socket.on("call:ice", async data => {
    try {
      if (!data.candidate) return;
      if (activeCall.pc && activeCall.pc.remoteDescription) await activeCall.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      else activeCall.pendingIce.push(data.candidate);
    } catch (err) { console.warn(err); }
  });

  socket.on("call:mute", data => {
    activeCall.peerMuted = !!data.muted;
    if (activeCall.peerMuted) activeCall.peerSpeaking = false;
    updateCallMuteUi();
  });

  socket.on("call:speaking", data => {
    activeCall.peerSpeaking = !!data.speaking;
    updateCallMuteUi();
  });

  socket.on("call:declined", () => { toast("Call declined."); resetCall(false); });
  socket.on("call:end", () => { toast("Call ended."); resetCall(false); });
}


function setFriendsTabMode(mode = "list") {
  const tab = $("friendsTab");
  if (!tab) return;
  tab.classList.remove("show-list", "show-add", "show-requests");
  tab.classList.add(mode === "add" ? "show-add" : mode === "requests" ? "show-requests" : "show-list");
  $("friendsTabTitle").textContent = mode === "requests" ? "Message Requests" : mode === "add" ? "Add Friend" : "Friends";
  document.querySelectorAll(".friends-inner-tabs button").forEach(btn => btn.classList.remove("active"));
  if (mode === "add") $("friendsAddMode")?.classList.add("active");
  else if (mode === "requests") $("friendsRequestsMode")?.classList.add("active");
  else $("friendsListMode")?.classList.add("active");
  $("friendsNavBtn")?.classList.toggle("active", mode !== "requests");
  $("requestsNavBtn")?.classList.toggle("active", mode === "requests");
}

function openFriendsTab(mode = "list") {
  const tab = $("friendsTab");
  if (!tab) return;
  tab.classList.remove("hidden");
  setFriendsTabMode(mode);
  refreshFriends();
}

function closeFriendsTab() {
  const tab = $("friendsTab");
  if (!tab) return;
  tab.classList.add("hidden");
  $("friendsNavBtn")?.classList.remove("active");
  $("requestsNavBtn")?.classList.remove("active");
}

function toggleFriendsTab() {
  const tab = $("friendsTab");
  if (!tab) return;
  if (tab.classList.contains("hidden")) openFriendsTab("list");
  else closeFriendsTab();
}

const friendsTabBtn = document.getElementById("friendsTabBtn");
if (friendsTabBtn) friendsTabBtn.addEventListener("click", () => openFriendsTab("list"));
const friendsNavBtn = document.getElementById("friendsNavBtn");
if (friendsNavBtn) friendsNavBtn.addEventListener("click", () => openFriendsTab("list"));
const requestsNavBtn = document.getElementById("requestsNavBtn");
if (requestsNavBtn) requestsNavBtn.addEventListener("click", () => openFriendsTab("requests"));
const friendsListMode = document.getElementById("friendsListMode");
if (friendsListMode) friendsListMode.addEventListener("click", () => setFriendsTabMode("list"));
const friendsAddMode = document.getElementById("friendsAddMode");
if (friendsAddMode) friendsAddMode.addEventListener("click", () => setFriendsTabMode("add"));
const friendsRequestsMode = document.getElementById("friendsRequestsMode");
if (friendsRequestsMode) friendsRequestsMode.addEventListener("click", () => setFriendsTabMode("requests"));
const closeFriendsTabBtn = document.getElementById("closeFriendsTab");
if (closeFriendsTabBtn) closeFriendsTabBtn.addEventListener("click", closeFriendsTab);


window.selectSpace = selectSpace;
window.openChannel = openChannel;
window.openChat = openChat;
window.openDM = openDM;
window.closeFriendsTab = closeFriendsTab;
window.openFriendsTab = openFriendsTab;
window.setFriendsTabMode = setFriendsTabMode;
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
    setSettingsTab(btn.dataset.tab);
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
      <p>Pick a DM or group chat. Open the Friends tab when you want to add someone or check requests.</p>
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
  const appShell = $("app");
  if (appShell) {
    appShell.classList.toggle("server-mode", isServer);
    appShell.classList.toggle("dm-mode", !isServer);
  }
  $("chatActions")?.classList.toggle("hidden", !isChat);
  $("composer")?.classList.toggle("hidden", !(isChat || isChannel));
  $("newChannelBtn")?.classList.toggle("hidden", !isServer);
  $("newGroupBtn")?.classList.toggle("hidden", isServer);
  $("serverChannelsSection")?.classList.toggle("hidden", !isServer);
}

const dmHomeBtn = document.getElementById("dmHomeBtn");
if (dmHomeBtn) dmHomeBtn.addEventListener("click", showDMHome);
