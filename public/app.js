let me = null;
let socket = null;
let chats = [];
let friends = [];
let active = null;

let call = freshCall();
let settings = JSON.parse(localStorage.getItem("chorusSettings") || '{"msg":60,"call":100,"mic":"","speaker":""}');

function freshCall() {
  return { pc:null, local:null, screen:null, chatId:null, peer:null, peerUser:null, incoming:null, pending:[], muted:false, sharing:false, state:"idle" };
}
function $(id){ return document.getElementById(id); }
function esc(value){ return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]); }
function saveSettings(){ localStorage.setItem("chorusSettings", JSON.stringify(settings)); }

async function api(url, options = {}) {
  const isForm = options.body instanceof FormData;
  const headers = isForm ? (options.headers || {}) : { "Content-Type":"application/json", ...(options.headers || {}) };
  const res = await fetch(url, { credentials:"include", ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
function toast(text){ const el=document.createElement("div"); el.className="toast"; el.textContent=text; $("toasts").appendChild(el); setTimeout(()=>el.remove(),4000); }
function beep(){ try{ const audio=new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA="); audio.volume=settings.msg/100; audio.play().catch(()=>{}); }catch{} }

async function boot(){ try{ const data=await api("/api/me"); me=data.user; showApp(); }catch{ showAuth(); } }
function showAuth(){ $("auth").classList.remove("hide"); $("app").classList.add("hide"); }
function showApp(){ $("auth").classList.add("hide"); $("app").classList.remove("hide"); renderMe(); connectSocket(); refreshFriends(); refreshChats(); loadDevices(); }
function renderMe(){ $("selfPic").src=me.avatar; $("profilePic").src=me.avatar; $("selfName").textContent=me.display_name; $("selfUser").textContent="@"+me.username; $("displayName").value=me.display_name; $("bio").value=me.bio||""; }

function connectSocket(){
  if (socket) socket.disconnect();
  socket = io({ withCredentials:true });
  socket.on("friends:update", refreshFriends);
  socket.on("chats:update", refreshChats);
  socket.on("message:new", msg => { if (active && Number(msg.chat_id) === Number(active.id)) addMessage(msg); else beep(); refreshChats(); });
  socket.on("message:update", updateMessage);
  socket.on("messages:cleared", data => { if (active && Number(data.chatId) === Number(active.id)) $("messages").innerHTML = ""; });
  wireCallSocket();
}

async function refreshFriends(){
  const data = await api("/api/friends");
  friends = data.friends;
  $("friendList").innerHTML = friends.map(userRow).join("");
  $("requests").innerHTML = data.incoming.map(req => `<div class="request"><b>${esc(req.display_name)}</b><small>@${esc(req.username)}</small><br><button onclick="friendRespond(${req.request_id}, 'accept')">Accept</button><button class="danger" onclick="friendRespond(${req.request_id}, 'decline')">Decline</button></div>`).join("");
  renderGroupFriends();
}
async function refreshChats(){
  const data = await api("/api/chats");
  chats = data.chats;
  $("chatList").innerHTML = chats.map(chat => `<button class="row ${active && active.id === chat.id ? "active" : ""}" onclick="openChat(${chat.id})"><img src="${esc(chat.avatar)}"><div><b>${esc(chat.title)}</b><small>${esc(chat.last ? chat.last.body : "No messages yet")}</small></div></button>`).join("");
  if (active) active = chats.find(c => c.id === active.id) || active;
}
function userRow(user){ return `<button class="row" onclick="openDM(${user.id})"><img src="${esc(user.avatar)}"><div><b>${esc(user.display_name)}</b><small>@${esc(user.username)} · online</small></div></button>`; }
function openDM(id){ const chat = chats.find(item => item.type === "dm" && item.members.some(member => member.id === id)); if (!chat) return toast("DM opens after the friend request is accepted."); openChat(chat.id); }
async function openChat(id){
  active = chats.find(chat => chat.id === id);
  if (!active) return;
  $("side").classList.remove("open");
  $("chatTitle").textContent = active.title;
  $("chatPic").src = active.avatar || "/default-avatar.svg";
  $("chatSub").textContent = active.members.map(m => m.display_name).join(", ");
  $("msgInput").placeholder = `Message @${active.title}`;
  renderMembers();
  await refreshMessages();
  refreshChats();
}
function renderMembers(){
  const members = active ? active.members : [];
  $("memberList").innerHTML = members.map(m => `<div class="member"><img src="${esc(m.avatar)}"><div><b>${esc(m.display_name)}</b><small>@${esc(m.username)}</small></div></div>`).join("");
}
async function refreshMessages(){
  const data = await api(`/api/chats/${active.id}/messages`);
  $("messages").innerHTML = "";
  data.messages.forEach(addMessage);
  if (!data.messages.length) $("messages").innerHTML = `<div class="emptyState"><div><h1>${esc(active.title)}</h1><p>This is the beginning of your conversation.</p></div></div>`;
  scrollEnd();
}
function addMessage(msg){
  const empty = $("messages").querySelector(".emptyState");
  if (empty) empty.remove();
  const el = document.createElement("div");
  el.className = "msg";
  el.id = "msg-" + msg.id;
  el.innerHTML = messageHTML(msg);
  $("messages").appendChild(el);
  scrollEnd();
}
function updateMessage(msg){ const el=$("msg-"+msg.id); if (el) el.innerHTML = messageHTML(msg); }
function messageHTML(msg){
  const isMine = msg.sender_id === me.id;
  const controls = isMine ? `<button onclick="startEdit(${msg.id})">edit</button><button onclick="deleteMsg(${msg.id})">delete</button>` : "";
  const reactions = (msg.reactions || []).map(r => `<button onclick="react(${msg.id}, '${esc(r.emoji)}')">${esc(r.emoji)} ${r.count}</button>`).join("");
  return `<img src="${esc(msg.avatar)}"><div class="msgContent"><div class="msgHead"><b>${esc(msg.display_name)}</b><small>${new Date(msg.created_at).toLocaleString()}${msg.edited ? " · edited" : ""}</small></div><div class="message-body" data-body="${esc(msg.body)}">${esc(msg.body)}</div><div class="reacts">${reactions}</div></div><div class="msgActions"><button onclick="react(${msg.id}, '😭')">😭</button><button onclick="react(${msg.id}, '❤️')">❤️</button>${controls}</div>`;
}
function scrollEnd(){ const box=$("messages"); box.scrollTop=box.scrollHeight; }
function react(id, emoji){ socket.emit("message:react", { id, emoji }); }
function startEdit(id){
  const el = $("msg-" + id);
  if (!el) return;
  const body = el.querySelector(".message-body");
  const old = body.dataset.body || body.textContent;
  body.innerHTML = `<div class="editBox"><input id="edit-${id}" value="${esc(old)}"><button onclick="saveEdit(${id})">Save</button><button onclick="cancelEdit(${id}, '${encodeURIComponent(old)}')">Cancel</button></div>`;
  const input = $("edit-" + id);
  input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  input.onkeydown = e => { if (e.key === "Enter") saveEdit(id); if (e.key === "Escape") cancelEdit(id, encodeURIComponent(old)); };
}
function saveEdit(id){ const input=$("edit-"+id); if (!input) return; const body=input.value.trim(); if (body) socket.emit("message:edit", { id, body }); }
function cancelEdit(id, encoded){ const el=$("msg-"+id); if (!el) return; const body=decodeURIComponent(encoded); el.querySelector(".message-body").textContent = body; }
function deleteMsg(id){ if (confirm("Delete this message?")) socket.emit("message:delete", { id }); }
async function friendRespond(id, action){ await api("/api/friends/respond", { method:"POST", body:JSON.stringify({ requestId:id, action }) }); refreshFriends(); refreshChats(); }
function renderGroupFriends(){ const box=$("groupFriends"); if (!box) return; box.innerHTML = friends.map(f => `<label><input type="checkbox" value="${f.id}"> ${esc(f.display_name)}</label>`).join(""); }

$("showLogin").onclick = () => { $("loginForm").classList.remove("hide"); $("regForm").classList.add("hide"); $("showLogin").classList.add("on"); $("showReg").classList.remove("on"); };
$("showReg").onclick = () => { $("regForm").classList.remove("hide"); $("loginForm").classList.add("hide"); $("showReg").classList.add("on"); $("showLogin").classList.remove("on"); };
$("loginForm").onsubmit = async e => { e.preventDefault(); try{ const data=await api("/api/login", { method:"POST", body:JSON.stringify({ username:$("loginUser").value, password:$("loginPass").value }) }); me=data.user; showApp(); }catch(err){ $("authErr").textContent=err.message; } };
$("regForm").onsubmit = async e => { e.preventDefault(); try{ const data=await api("/api/register", { method:"POST", body:JSON.stringify({ username:$("regUser").value, displayName:$("regDisplay").value, password:$("regPass").value }) }); me=data.user; showApp(); }catch(err){ $("authErr").textContent=err.message; } };
$("composer").onsubmit = e => { e.preventDefault(); if (!active) return toast("Open a chat first."); const body=$("msgInput").value.trim(); if (!body) return; socket.emit("message:send", { chatId:active.id, body }); $("msgInput").value=""; };
$("addFriend").onclick = async () => { try{ await api("/api/friends/request", { method:"POST", body:JSON.stringify({ username:$("friendUser").value }) }); $("friendUser").value=""; toast("Friend request sent."); }catch(err){ toast(err.message); } };
$("clearBtn").onclick = async () => { if (!active) return; if (confirm("Clear this chat?")) await api(`/api/chats/${active.id}/messages`, { method:"DELETE" }); };
$("self").onclick = () => openModal("profile");
$("settingsBtn").onclick = () => openModal("settings");
$("newGroup").onclick = () => openModal("group");
document.querySelectorAll(".x").forEach(btn => btn.onclick = () => btn.closest(".modal").classList.add("hide"));
function openModal(id){ $(id).classList.remove("hide"); }
$("logout").onclick = async () => { await api("/api/logout", { method:"POST" }); location.reload(); };
$("saveProfile").onclick = async () => { try{ const data=await api("/api/me", { method:"PUT", body:JSON.stringify({ displayName:$("displayName").value, bio:$("bio").value }) }); me=data.user; renderMe(); toast("Profile saved."); }catch(err){ toast(err.message); } };
$("avatarFile").onchange = async () => { const form=new FormData(); form.append("avatar", $("avatarFile").files[0]); const res=await fetch("/api/me/avatar", { method:"POST", credentials:"include", body:form }); const data=await res.json(); if (!res.ok) return toast(data.error || "Upload failed"); me=data.user; renderMe(); toast("Avatar updated."); };
$("createGroup").onclick = async () => { const ids=Array.from(document.querySelectorAll("#groupFriends input:checked")).map(i=>Number(i.value)); await api("/api/chats/group", { method:"POST", body:JSON.stringify({ name:$("groupName").value, userIds:ids }) }); $("group").classList.add("hide"); refreshChats(); };
$("mobileMenu").onclick = () => $("side").classList.toggle("open");
$("mobileBack").onclick = () => $("side").classList.toggle("open");

$("msgVol").value = settings.msg; $("callVol").value = settings.call;
$("msgVol").oninput = e => { settings.msg=Number(e.target.value); saveSettings(); };
$("callVol").oninput = e => { settings.call=Number(e.target.value); saveSettings(); $("remoteAudio").volume=settings.call/100; };
async function loadDevices(){ try{ const temp=await navigator.mediaDevices.getUserMedia({ audio:true }); temp.getTracks().forEach(t=>t.stop()); const devices=await navigator.mediaDevices.enumerateDevices(); const mics=devices.filter(d=>d.kind==="audioinput"); const speakers=devices.filter(d=>d.kind==="audiooutput"); $("mic").innerHTML=`<option value="">Default</option>`+mics.map(d=>`<option value="${d.deviceId}">${esc(d.label||"Microphone")}</option>`).join(""); $("speaker").innerHTML=`<option value="">Default</option>`+speakers.map(d=>`<option value="${d.deviceId}">${esc(d.label||"Speaker")}</option>`).join(""); $("mic").value=settings.mic||""; $("speaker").value=settings.speaker||""; }catch{} }
$("refreshDevices").onclick = loadDevices; $("mic").onchange=e=>{ settings.mic=e.target.value; saveSettings(); }; $("speaker").onchange=e=>{ settings.speaker=e.target.value; saveSettings(); };

async function iceConfig(){ const data=await api("/api/ice"); return { iceServers:data.iceServers, iceCandidatePoolSize:10 }; }
async function getMicStream(){
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Your browser is blocking microphone access. Use HTTPS and allow the mic.");
  return navigator.mediaDevices.getUserMedia({ audio:{ deviceId:settings.mic ? { exact:settings.mic } : undefined, echoCancellation:true, noiseSuppression:true, autoGainControl:true }, video:false });
}
async function createPeer(peerId){
  const pc = new RTCPeerConnection(await iceConfig());
  call.pc = pc;
  pc.onicecandidate = e => { if (e.candidate && call.chatId && peerId) socket.emit("call:ice", { chatId:call.chatId, targetId:peerId, candidate:e.candidate }); };
  pc.ontrack = e => {
    const audio = $("remoteAudio");
    audio.srcObject = e.streams[0];
    audio.volume = settings.call / 100;
    if (audio.setSinkId && settings.speaker) audio.setSinkId(settings.speaker).catch(()=>{});
    audio.play().catch(() => toast("Click anywhere once if you cannot hear the call."));
    updateCallDock("connected");
  };
  pc.onconnectionstatechange = () => {
    if (["connected","connecting","disconnected","failed"].includes(pc.connectionState)) updateCallDock(pc.connectionState);
    if (pc.connectionState === "failed") toast("Call connection failed. Add TURN settings on Render if this happens between different networks.");
  };
  return pc;
}
async function ensureLocalAudio(){
  if (call.local) return call.local;
  call.local = await getMicStream();
  call.local.getTracks().forEach(track => call.pc.addTrack(track, call.local));
  return call.local;
}
function showCallDock(title, status, mode="calling"){
  $("callDock").classList.remove("hide");
  $("callTitle").textContent = title;
  updateCallDock(status);
  $("incoming").classList.toggle("hide", mode !== "incoming");
  $("inCallControls").classList.toggle("hide", mode === "incoming");
}
function updateCallDock(status){ call.state=status; $("callStatus").textContent=status; $("callBtn").textContent = call.chatId ? "☎ In Call" : "☎ Call"; }
function stopTracks(stream){ if (stream) stream.getTracks().forEach(t=>t.stop()); }
function resetCall(send=true){
  if (send && call.peer && call.chatId) socket.emit("call:end", { chatId:call.chatId, targetId:call.peer });
  try{ if (call.pc) call.pc.close(); }catch{}
  stopTracks(call.local); stopTracks(call.screen);
  call = freshCall();
  $("callDock").classList.add("hide"); $("incoming").classList.add("hide"); $("inCallControls").classList.add("hide"); $("mute").textContent="Mute"; $("shareScreen").textContent="Share screen"; updateCallDock("idle");
}
async function startOutgoingCall(){
  if (!active) return toast("Open a DM first.");
  if (active.type !== "dm") return toast("Calls are one-on-one for now.");
  const other = active.members.find(m => m.id !== me.id);
  if (!other) return toast("No user found to call.");

  resetCall(false);
  call.chatId = active.id;
  call.peer = other.id;
  call.peerUser = other;
  showCallDock("Calling " + other.display_name, "ringing", "calling");
  socket.emit("call:invite", { chatId: active.id, targetId: other.id });
}
async function acceptIncomingCall(){
  const incoming = call.incoming;
  if (!incoming) return;

  call.chatId = incoming.chatId;
  call.peer = incoming.from.id;
  call.peerUser = incoming.from;
  showCallDock("Voice call with " + incoming.from.display_name, "connecting", "calling");
  socket.emit("call:accept", { chatId: incoming.chatId, targetId: incoming.from.id });
}
async function handleAccepted(data){
  try{
    updateCallDock("connecting");
    call.peer = data.from.id;
    call.peerUser = data.from;
    call.pc = await createPeer(data.from.id);
    await ensureLocalAudio();
    const offer = await call.pc.createOffer({ offerToReceiveAudio:true });
    await call.pc.setLocalDescription(offer);
    socket.emit("call:offer", { chatId: data.chatId, targetId: data.from.id, offer });
  }catch(err){
    toast(err.message || "Could not start the call.");
    resetCall(true);
  }
}
async function handleOffer(data){
  try{
    call.chatId = data.chatId;
    call.peer = data.fromUserId;
    call.peerUser = data.from;
    showCallDock("Voice call with " + (data.from?.display_name || "friend"), "connecting", "calling");
    call.pc = await createPeer(data.fromUserId);
    await ensureLocalAudio();
    await call.pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    for (const c of call.pending) await call.pc.addIceCandidate(new RTCIceCandidate(c));
    call.pending = [];
    const answer = await call.pc.createAnswer();
    await call.pc.setLocalDescription(answer);
    socket.emit("call:answer", { chatId: data.chatId, targetId: data.fromUserId, answer });
    updateCallDock("connecting");
  }catch(err){
    toast(err.message || "Could not answer the call.");
    resetCall(true);
  }
}
async function handleAnswer(data){
  try{
    if (!call.pc) return;
    await call.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    for (const c of call.pending) await call.pc.addIceCandidate(new RTCIceCandidate(c));
    call.pending = [];
    updateCallDock("connecting");
  }catch(err){
    toast(err.message || "Could not connect the call.");
  }
}
function wireCallSocket(){
  socket.on("call:incoming", data => {
    if (call.chatId) {
      socket.emit("call:decline", { chatId:data.chatId, targetId:data.from.id });
      return;
    }
    call.chatId = data.chatId;
    call.peer = data.from.id;
    call.peerUser = data.from;
    call.incoming = data;
    showCallDock("Incoming call from " + data.from.display_name, "incoming", "incoming");
  });
  socket.on("call:accepted", handleAccepted);
  socket.on("call:offer", handleOffer);
  socket.on("call:answer", handleAnswer);
  socket.on("call:ice", async data => {
    try{
      if (call.pc && call.pc.remoteDescription) await call.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      else call.pending.push(data.candidate);
    }catch(err){ console.warn(err); }
  });
  socket.on("call:declined", () => { toast("Call declined."); resetCall(false); });
  socket.on("call:end", () => { toast("Call ended."); resetCall(false); });
}
$("callBtn").onclick = startOutgoingCall;
$("accept").onclick = acceptIncomingCall;
$("decline").onclick = () => { if (call.incoming) socket.emit("call:decline", { chatId:call.incoming.chatId, targetId:call.incoming.from.id }); resetCall(false); };
$("endCall").onclick = () => resetCall(true);
$("mute").onclick = () => { call.muted=!call.muted; if (call.local) call.local.getAudioTracks().forEach(t => t.enabled=!call.muted); $("mute").textContent = call.muted ? "Unmute" : "Mute"; };
$("shareScreen").onclick = startScreenShare;
$("callDock").onclick = () => $("remoteAudio").play().catch(()=>{});

boot();
