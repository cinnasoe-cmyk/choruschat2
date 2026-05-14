
let me = null;
let socket = null;
let chats = [];
let friends = [];
let activeChat = null;

let settings = JSON.parse(localStorage.getItem("chorusSettings") || '{"messageVolume":70,"callVolume":100,"micId":"","speakerId":""}');

let activeCall = {
  pc: null,
  localStream: null,
  chatId: null,
  peerId: null,
  incoming: null,
  pendingIce: [],
  muted: false
};

const $ = id => document.getElementById(id);

async function api(url, options = {}) {
  const headers = options.headers || {};
  const res = await fetch(url, {
    credentials: "include",
    ...options,
    headers: { "Content-Type": "application/json", ...headers }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function saveSettings() {
  localStorage.setItem("chorusSettings", JSON.stringify(settings));
}

function playMessageSound() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 660;
    gain.gain.value = settings.messageVolume / 100 * 0.07;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
  } catch {}
}

async function boot() {
  try {
    const data = await api("/api/me");
    me = data.user;
    showApp();
  } catch {
    showAuth();
  }
}

function showAuth() {
  $("auth").classList.remove("hidden");
  $("app").classList.add("hidden");
}

function showApp() {
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  renderMe();
  connectSocket();
  refreshFriends();
  refreshChats();
  loadDevices();
}

function renderMe() {
  $("selfAvatar").src = me.avatar;
  $("profilePreview").src = me.avatar;
  $("selfName").textContent = me.display_name;
  $("selfUsername").textContent = "@" + me.username;
  $("profileDisplay").value = me.display_name;
  $("profileBio").value = me.bio || "";
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ withCredentials: true });

  socket.on("friends:update", refreshFriends);
  socket.on("chats:update", refreshChats);

  socket.on("message:new", msg => {
    if (activeChat && Number(msg.chat_id) === Number(activeChat.id)) addMessage(msg);
    else playMessageSound();
    refreshChats();
  });

  socket.on("message:update", updateMessage);

  socket.on("messages:cleared", data => {
    if (activeChat && Number(data.chatId) === Number(activeChat.id)) {
      $("messages").innerHTML = "";
    }
  });

  wireCallSocket();
}

async function refreshFriends() {
  const data = await api("/api/friends");
  friends = data.friends;

  $("friendList").innerHTML = friends.map(user => `
    <button class="row" onclick="openDM(${user.id})" type="button">
      <img src="${user.avatar}">
      <div>
        <b>${esc(user.display_name)}</b>
        <small>@${esc(user.username)}</small>
      </div>
    </button>
  `).join("");

  $("requests").innerHTML = data.incoming.map(req => `
    <div class="request">
      <b>${esc(req.display_name)}</b>
      <small>@${esc(req.username)}</small>
      <button onclick="friendRespond(${req.request_id}, 'accept')" type="button">Accept</button>
      <button onclick="friendRespond(${req.request_id}, 'decline')" class="danger" type="button">Decline</button>
    </div>
  `).join("");

  renderGroupFriends();
}

async function refreshChats() {
  const data = await api("/api/chats");
  chats = data.chats;

  $("chatList").innerHTML = chats.map(chat => `
    <button class="row ${activeChat && activeChat.id === chat.id ? "active" : ""}" onclick="openChat(${chat.id})" type="button">
      <img src="${chat.avatar}">
      <div>
        <b>${esc(chat.title)}</b>
        <small>${esc(chat.last ? chat.last.body : "No messages yet")}</small>
      </div>
    </button>
  `).join("");
}

function openDM(userId) {
  const chat = chats.find(c => c.type === "dm" && c.members.some(m => Number(m.id) === Number(userId)));
  if (!chat) return toast("A DM appears after the friend request is accepted.");
  openChat(chat.id);
}

async function openChat(chatId) {
  activeChat = chats.find(c => Number(c.id) === Number(chatId));
  if (!activeChat) return;

  $("sidebar").classList.remove("open");
  $("chatTitle").textContent = activeChat.title;
  $("chatAvatar").src = activeChat.avatar;
  $("chatSubtitle").textContent = activeChat.members.map(m => m.display_name).join(", ");

  await refreshMessages();
  refreshChats();
}

async function refreshMessages() {
  const data = await api(`/api/chats/${activeChat.id}/messages`);
  $("messages").innerHTML = "";
  data.messages.forEach(addMessage);
  scrollMessages();
}

function addMessage(msg) {
  const el = document.createElement("div");
  el.className = "msg";
  el.id = `message-${msg.id}`;
  el.innerHTML = messageHTML(msg);
  $("messages").appendChild(el);
  scrollMessages();
}

function updateMessage(msg) {
  const el = $(`message-${msg.id}`);
  if (el) el.innerHTML = messageHTML(msg);
}

function messageHTML(msg) {
  const controls = Number(msg.sender_id) === Number(me.id)
    ? `<button onclick="editMessage(${msg.id})" type="button">edit</button><button onclick="deleteMessage(${msg.id})" type="button">delete</button>`
    : "";

  const reactions = (msg.reactions || []).map(r => `<button onclick="react(${msg.id}, '${r.emoji}')" type="button">${r.emoji} ${r.count}</button>`).join("");

  return `
    <img src="${msg.avatar}">
    <div class="bubble">
      <div>
        <b>${esc(msg.display_name)}</b>
        <small>${new Date(msg.created_at).toLocaleString()}${msg.edited ? " · edited" : ""}</small>
      </div>
      <p>${esc(msg.body)}</p>
      <div class="reacts">
        ${reactions}
        <button onclick="react(${msg.id}, '❤️')" type="button">❤️</button>
        <button onclick="react(${msg.id}, '😭')" type="button">😭</button>
        ${controls}
      </div>
    </div>
  `;
}

function scrollMessages() {
  const box = $("messages");
  box.scrollTop = box.scrollHeight;
}

function react(id, emoji) {
  socket.emit("message:react", { id, emoji });
}

function editMessage(id) {
  const oldText = $(`message-${id}`).querySelector("p").textContent;
  const body = prompt("Edit message", oldText);
  if (body) socket.emit("message:edit", { id, body });
}

function deleteMessage(id) {
  if (confirm("Delete this message?")) socket.emit("message:delete", { id });
}

async function friendRespond(id, action) {
  await api("/api/friends/respond", {
    method: "POST",
    body: JSON.stringify({ requestId: id, action })
  });
  refreshFriends();
  refreshChats();
}

function renderGroupFriends() {
  $("groupFriends").innerHTML = friends.map(friend => `
    <label><input type="checkbox" value="${friend.id}"> ${esc(friend.display_name)}</label>
  `).join("");
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

$("loginForm").onsubmit = async event => {
  event.preventDefault();
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: $("loginUsername").value,
        password: $("loginPassword").value
      })
    });
    me = data.user;
    showApp();
  } catch (err) {
    $("authError").textContent = err.message;
  }
};

$("registerForm").onsubmit = async event => {
  event.preventDefault();
  try {
    const data = await api("/api/register", {
      method: "POST",
      body: JSON.stringify({
        username: $("registerUsername").value,
        displayName: $("registerDisplay").value,
        password: $("registerPassword").value
      })
    });
    me = data.user;
    showApp();
  } catch (err) {
    $("authError").textContent = err.message;
  }
};

$("composer").onsubmit = event => {
  event.preventDefault();
  if (!activeChat) return toast("Open a chat first.");
  const body = $("messageInput").value.trim();
  if (!body) return;

  socket.emit("message:send", { chatId: activeChat.id, body });
  $("messageInput").value = "";
};

$("addFriendBtn").onclick = async () => {
  try {
    await api("/api/friends/request", {
      method: "POST",
      body: JSON.stringify({ username: $("friendUsername").value })
    });
    $("friendUsername").value = "";
    toast("Friend request sent.");
  } catch (err) {
    toast(err.message);
  }
};

$("clearChatBtn").onclick = async () => {
  if (!activeChat) return;
  if (confirm("Clear all messages in this chat?")) {
    await api(`/api/chats/${activeChat.id}/messages`, { method: "DELETE" });
  }
};

$("selfPanel").onclick = () => openModal("profileModal");
$("openSettings").onclick = () => openModal("settingsModal");
$("newGroupBtn").onclick = () => openModal("groupModal");

document.querySelectorAll(".closeModal").forEach(button => {
  button.onclick = () => button.closest(".modal").classList.add("hidden");
});

function openModal(id) {
  $(id).classList.remove("hidden");
}

$("logoutBtn").onclick = async () => {
  await api("/api/logout", { method: "POST" });
  location.reload();
};

$("saveProfileBtn").onclick = async () => {
  try {
    const data = await api("/api/me", {
      method: "PUT",
      body: JSON.stringify({
        displayName: $("profileDisplay").value,
        bio: $("profileBio").value
      })
    });
    me = data.user;
    renderMe();
    toast("Profile saved.");
  } catch (err) {
    toast(err.message);
  }
};

$("avatarFile").onchange = async () => {
  const file = $("avatarFile").files[0];
  if (!file) return;

  const form = new FormData();
  form.append("avatar", file);

  const res = await fetch("/api/me/avatar", {
    method: "POST",
    credentials: "include",
    body: form
  });

  const data = await res.json();
  if (!res.ok) return toast(data.error || "Upload failed.");

  me = data.user;
  renderMe();
  toast("Profile picture updated.");
};

$("createGroupBtn").onclick = async () => {
  const ids = Array.from(document.querySelectorAll("#groupFriends input:checked")).map(input => Number(input.value));

  await api("/api/chats/group", {
    method: "POST",
    body: JSON.stringify({ name: $("groupName").value, userIds: ids })
  });

  $("groupModal").classList.add("hidden");
  refreshChats();
};

$("mobileMenu").onclick = () => $("sidebar").classList.toggle("open");
$("mobileBack").onclick = () => $("sidebar").classList.toggle("open");

$("messageVolume").value = settings.messageVolume;
$("callVolume").value = settings.callVolume;

$("messageVolume").oninput = event => {
  settings.messageVolume = Number(event.target.value);
  saveSettings();
};

$("callVolume").oninput = event => {
  settings.callVolume = Number(event.target.value);
  saveSettings();
  $("remoteAudio").volume = settings.callVolume / 100;
};

async function loadDevices() {
  try {
    const temp = await navigator.mediaDevices.getUserMedia({ audio: true });
    temp.getTracks().forEach(track => track.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === "audioinput");
    const speakers = devices.filter(d => d.kind === "audiooutput");

    $("micSelect").innerHTML = `<option value="">Default</option>` + mics.map(d => {
      return `<option value="${d.deviceId}">${esc(d.label || "Microphone")}</option>`;
    }).join("");

    $("speakerSelect").innerHTML = `<option value="">Default</option>` + speakers.map(d => {
      return `<option value="${d.deviceId}">${esc(d.label || "Speaker")}</option>`;
    }).join("");

    $("micSelect").value = settings.micId || "";
    $("speakerSelect").value = settings.speakerId || "";
  } catch {}
}

$("refreshDevicesBtn").onclick = loadDevices;

$("micSelect").onchange = event => {
  settings.micId = event.target.value;
  saveSettings();
};

$("speakerSelect").onchange = event => {
  settings.speakerId = event.target.value;
  saveSettings();
};

async function iceConfig() {
  const data = await api("/api/ice");
  return { iceServers: data.iceServers, iceCandidatePoolSize: 10 };
}

async function getLocalStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: settings.micId ? { exact: settings.micId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  });
}

async function createPeer(peerId) {
  const pc = new RTCPeerConnection(await iceConfig());
  activeCall.pc = pc;

  pc.onicecandidate = event => {
    if (event.candidate) {
      socket.emit("call:ice", {
        chatId: activeCall.chatId,
        targetId: peerId,
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = event => {
    const audio = $("remoteAudio");
    audio.srcObject = event.streams[0];
    audio.volume = settings.callVolume / 100;

    if (audio.setSinkId && settings.speakerId) {
      audio.setSinkId(settings.speakerId).catch(() => {});
    }

    audio.play().catch(() => toast("Tap the call window once to enable audio."));
    $("callStatus").textContent = "connected";
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === "connected") $("callStatus").textContent = "connected";
    if (state === "failed" || state === "disconnected") $("callStatus").textContent = state;
  };

  return pc;
}

async function addLocalAudio() {
  activeCall.localStream = await getLocalStream();
  activeCall.localStream.getTracks().forEach(track => activeCall.pc.addTrack(track, activeCall.localStream));
}

function showCall(title, status, user, incoming = false) {
  $("callModal").classList.remove("hidden");
  $("incomingControls").classList.toggle("hidden", !incoming);
  $("callTitle").textContent = title;
  $("callStatus").textContent = status;
  $("callAvatar").src = user ? user.avatar : "/default-avatar.svg";
}

function resetCall(send = true) {
  if (send && activeCall.peerId && activeCall.chatId) {
    socket.emit("call:end", { chatId: activeCall.chatId, targetId: activeCall.peerId });
  }

  try {
    if (activeCall.pc) activeCall.pc.close();
  } catch {}

  if (activeCall.localStream) {
    activeCall.localStream.getTracks().forEach(track => track.stop());
  }

  activeCall = {
    pc: null,
    localStream: null,
    chatId: null,
    peerId: null,
    incoming: null,
    pendingIce: [],
    muted: false
  };

  $("callModal").classList.add("hidden");
  $("incomingControls").classList.add("hidden");
  $("muteBtn").textContent = "Mute";
}

$("callBtn").onclick = () => {
  if (!activeChat) return toast("Open a DM first.");
  if (activeChat.type !== "dm") return toast("Calls are one-on-one for now.");

  const other = activeChat.members.find(member => Number(member.id) !== Number(me.id));
  if (!other) return toast("No user found to call.");

  activeCall.chatId = activeChat.id;
  activeCall.peerId = other.id;

  showCall(`Calling ${other.display_name}`, "ringing", other, false);
  socket.emit("call:invite", { chatId: activeChat.id, targetId: other.id });
};

$("acceptCallBtn").onclick = () => {
  const incoming = activeCall.incoming;
  if (!incoming) return;

  socket.emit("call:accept", {
    chatId: incoming.chatId,
    targetId: incoming.from.id
  });

  $("incomingControls").classList.add("hidden");
  $("callStatus").textContent = "connecting";
};

$("declineCallBtn").onclick = () => {
  if (activeCall.incoming) {
    socket.emit("call:decline", {
      chatId: activeCall.incoming.chatId,
      targetId: activeCall.incoming.from.id
    });
  }
  resetCall(false);
};

$("endCallBtn").onclick = () => resetCall(true);

$("muteBtn").onclick = () => {
  activeCall.muted = !activeCall.muted;
  if (activeCall.localStream) {
    activeCall.localStream.getAudioTracks().forEach(track => track.enabled = !activeCall.muted);
  }
  $("muteBtn").textContent = activeCall.muted ? "Unmute" : "Mute";
};

$("callModal").onclick = () => $("remoteAudio").play().catch(() => {});

function wireCallSocket() {
  socket.on("call:incoming", data => {
    activeCall.chatId = data.chatId;
    activeCall.peerId = data.from.id;
    activeCall.incoming = data;
    showCall("Incoming Call", "incoming", data.from, true);
  });

  socket.on("call:accepted", async data => {
    try {
      $("callStatus").textContent = "connecting";
      activeCall.peerId = data.from.id;
      activeCall.pc = await createPeer(data.from.id);
      await addLocalAudio();

      const offer = await activeCall.pc.createOffer();
      await activeCall.pc.setLocalDescription(offer);

      socket.emit("call:offer", {
        chatId: data.chatId,
        targetId: data.from.id,
        offer
      });
    } catch (err) {
      toast(err.message);
      resetCall(true);
    }
  });

  socket.on("call:offer", async data => {
    try {
      activeCall.chatId = data.chatId;
      activeCall.peerId = data.fromUserId;
      activeCall.pc = await createPeer(data.fromUserId);
      await addLocalAudio();

      await activeCall.pc.setRemoteDescription(new RTCSessionDescription(data.offer));

      for (const candidate of activeCall.pendingIce) {
        await activeCall.pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
      activeCall.pendingIce = [];

      const answer = await activeCall.pc.createAnswer();
      await activeCall.pc.setLocalDescription(answer);

      socket.emit("call:answer", {
        chatId: data.chatId,
        targetId: data.fromUserId,
        answer
      });

      $("callStatus").textContent = "connecting";
    } catch (err) {
      toast(err.message);
      resetCall(true);
    }
  });

  socket.on("call:answer", async data => {
    try {
      await activeCall.pc.setRemoteDescription(new RTCSessionDescription(data.answer));

      for (const candidate of activeCall.pendingIce) {
        await activeCall.pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
      activeCall.pendingIce = [];

      $("callStatus").textContent = "connecting";
    } catch (err) {
      toast(err.message);
    }
  });

  socket.on("call:ice", async data => {
    try {
      if (activeCall.pc && activeCall.pc.remoteDescription) {
        await activeCall.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } else {
        activeCall.pendingIce.push(data.candidate);
      }
    } catch (err) {
      console.warn(err);
    }
  });

  socket.on("call:declined", () => {
    toast("Call declined.");
    resetCall(false);
  });

  socket.on("call:end", () => {
    toast("Call ended.");
    resetCall(false);
  });
}

boot();
