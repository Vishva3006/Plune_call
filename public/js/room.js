// ---------- Setup & auth guard ----------
const token = localStorage.getItem("token");
const myUsername = localStorage.getItem("username") || "User";
if (!token) {
  window.location.href = "index.html";
}

const params = new URLSearchParams(window.location.search);
const roomId = params.get("room") || "lobby";

document.getElementById("roomLabel").textContent = `Room: ${roomId}`;
document.getElementById("whoami").textContent = myUsername;
const avatarEl = document.getElementById("userAvatar");
if (avatarEl) avatarEl.textContent = myUsername.charAt(0).toUpperCase();

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
];

const videoGrid = document.getElementById("videoGrid");
const socketUrl = window.location.protocol.startsWith("http") ? undefined : "http://localhost:3000";
const socket = io(socketUrl, { auth: { token } });

let localStream = null;
let cameraTrack = null;
let audioTrack = null;
const peers = new Map(); // socketId -> RTCPeerConnection
const usernames = new Map(); // socketId -> username
const pendingCandidates = new Map(); // socketId -> RTCIceCandidateInit[]

let isMicMuted = false;
let isCamOff = false;
let unreadMessages = 0;

// ---------- Toast helper ----------
function showToast(message) {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = "toast-msg";
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 2600);
}

// ---------- Copy Room Link ----------
const copyLinkBtn = document.getElementById("copyLinkBtn");
if (copyLinkBtn) {
  copyLinkBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      showToast("Room link copied to clipboard!");
    }).catch(() => {
      showToast("Failed to copy link.");
    });
  });
}

// ---------- Local Media Initialization ----------
async function initLocalMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  cameraTrack = localStream.getVideoTracks()[0];
  audioTrack = localStream.getAudioTracks()[0];
  
  addVideoTile("local", localStream, `${myUsername} (you)`, true, true);
  socket.emit("join-room", roomId);
}

function addVideoTile(id, stream, label, muted = false, isLocal = false) {
  let tile = document.getElementById(`tile-${id}`);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = `video-tile ${isLocal ? "mirror" : ""}`;
    tile.id = `tile-${id}`;
    tile.innerHTML = `
      <video autoplay playsinline ${muted ? "muted" : ""}></video>
      <div class="tile-info">
        <span class="status-icon"></span>
        <span class="label"></span>
      </div>
    `;
    videoGrid.appendChild(tile);
  }
  tile.querySelector("video").srcObject = stream;
  tile.querySelector(".label").textContent = label;
}

function removeVideoTile(id) {
  document.getElementById(`tile-${id}`)?.remove();
}

// ---------- WebRTC peer connection helpers ----------
function createPeerConnection(socketId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("signal", { to: socketId, data: { candidate: event.candidate } });
    }
  };

  pc.ontrack = (event) => {
    const label = usernames.get(socketId) || "Participant";
    addVideoTile(socketId, event.streams[0], label);
  };

  pc.onconnectionstatechange = () => {
    if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
      removeVideoTile(socketId);
      peers.delete(socketId);
    }
  };

  peers.set(socketId, pc);
  return pc;
}

async function callUser(socketId) {
  try {
    const pc = createPeerConnection(socketId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("signal", { to: socketId, data: { type: "offer", sdp: offer } });
  } catch (err) {
    console.error("Failed to start peer connection", err);
  }
}

async function handleSignal({ from, username, data }) {
  try {
    usernames.set(from, username);
    let pc = peers.get(from);

    if (data.type === "offer") {
      if (!pc) pc = createPeerConnection(from);
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const queued = pendingCandidates.get(from) || [];
      for (const candidate of queued) await pc.addIceCandidate(new RTCIceCandidate(candidate));
      pendingCandidates.delete(from);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("signal", { to: from, data: { type: "answer", sdp: answer } });
    } else if (data.type === "answer") {
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const queued = pendingCandidates.get(from) || [];
        for (const candidate of queued) await pc.addIceCandidate(new RTCIceCandidate(candidate));
        pendingCandidates.delete(from);
      }
    } else if (data.candidate) {
      if (pc?.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } else {
        const candidates = pendingCandidates.get(from) || [];
        candidates.push(data.candidate);
        pendingCandidates.set(from, candidates);
      }
    }
  } catch (err) {
    console.warn("Failed to handle signaling message", err);
  }
}

// ---------- Socket.io signaling events ----------
socket.on("existing-users", (users) => {
  users.forEach(({ socketId, username }) => {
    usernames.set(socketId, username);
    callUser(socketId);
  });
});

socket.on("user-joined", ({ socketId, username }) => {
  usernames.set(socketId, username);
  showToast(`${username} joined the call`);
});

socket.on("signal", handleSignal);

socket.on("room-error", ({ message }) => {
  alert(message);
  window.location.href = "index.html";
});

socket.on("connect_error", (err) => {
  localStorage.removeItem("token");
  localStorage.removeItem("username");
  alert(`Unable to connect to the room: ${err.message}`);
  window.location.href = "index.html";
});

socket.on("user-left", ({ socketId, username }) => {
  if (username) showToast(`${username} left the call`);
  peers.get(socketId)?.close();
  peers.delete(socketId);
  usernames.delete(socketId);
  pendingCandidates.delete(socketId);
  removeVideoTile(socketId);
});

// ---------- Controls: mic / camera / screen / leave ----------
const micBtn = document.getElementById("micBtn");
const camBtn = document.getElementById("camBtn");
const screenBtn = document.getElementById("screenBtn");
const leaveBtn = document.getElementById("leaveBtn");

micBtn.addEventListener("click", () => {
  if (!audioTrack) return;
  isMicMuted = !isMicMuted;
  audioTrack.enabled = !isMicMuted;
  micBtn.classList.toggle("off", isMicMuted);
  const icon = micBtn.querySelector("span.status-icon");
  const localInfoIcon = document.querySelector("#tile-local .status-icon");
  if (localInfoIcon) localInfoIcon.classList.toggle("muted", isMicMuted);
});

camBtn.addEventListener("click", () => {
  if (!cameraTrack) return;
  isCamOff = !isCamOff;
  cameraTrack.enabled = !isCamOff;
  camBtn.classList.toggle("off", isCamOff);
});

leaveBtn.addEventListener("click", () => {
  peers.forEach((pc) => pc.close());
  socket.disconnect();
  localStream?.getTracks().forEach((t) => t.stop());
  window.location.href = "index.html";
});

// ---------- Screen sharing ----------
let screenStream = null;

screenBtn.addEventListener("click", async () => {
  if (screenStream) return stopScreenShare();
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const screenTrack = screenStream.getVideoTracks()[0];

    peers.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) sender.replaceTrack(screenTrack);
    });

    addVideoTile("local", screenStream, `${myUsername} (you) — screen`, true, false);
    screenBtn.classList.add("active");
    screenTrack.onended = stopScreenShare;
  } catch (err) {
    console.warn("Screen share cancelled or failed", err);
  }
});

function stopScreenShare() {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;

  peers.forEach((pc) => {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
    if (sender) sender.replaceTrack(cameraTrack);
  });

  addVideoTile("local", localStream, `${myUsername} (you)`, true, true);
  screenBtn.classList.remove("active");
}

// ---------- Sidebar Navigation Management ----------
const chatPanel = document.getElementById("chatPanel");
const whiteboardPanel = document.getElementById("whiteboardPanel");
const filePanel = document.getElementById("filePanel");

const chatToggleBtn = document.getElementById("chatToggleBtn");
const whiteboardBtn = document.getElementById("whiteboardBtn");
const fileToggleBtn = document.getElementById("fileToggleBtn");

function closeAllPanels() {
  chatPanel.classList.add("hidden");
  whiteboardPanel.classList.add("hidden");
  filePanel.classList.add("hidden");
  chatToggleBtn.classList.remove("active");
  whiteboardBtn.classList.remove("active");
  fileToggleBtn.classList.remove("active");
}

chatToggleBtn.addEventListener("click", () => {
  const isHidden = chatPanel.classList.contains("hidden");
  closeAllPanels();
  if (isHidden) {
    chatPanel.classList.remove("hidden");
    chatToggleBtn.classList.add("active");
    unreadMessages = 0;
    document.getElementById("unreadBadge").classList.add("hidden");
  }
});

whiteboardBtn.addEventListener("click", () => {
  const isHidden = whiteboardPanel.classList.contains("hidden");
  closeAllPanels();
  if (isHidden) {
    whiteboardPanel.classList.remove("hidden");
    whiteboardBtn.classList.add("active");
  }
});

fileToggleBtn.addEventListener("click", () => {
  const isHidden = filePanel.classList.contains("hidden");
  closeAllPanels();
  if (isHidden) {
    filePanel.classList.remove("hidden");
    fileToggleBtn.classList.add("active");
  }
});

document.getElementById("closeChatBtn")?.addEventListener("click", closeAllPanels);
document.getElementById("closeWbBtn")?.addEventListener("click", closeAllPanels);
document.getElementById("closeFileBtn")?.addEventListener("click", closeAllPanels);

// ---------- In-Call Text Chat ----------
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatMessages = document.getElementById("chatMessages");

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit("chat-message", { text });
  chatInput.value = "";
});

socket.on("chat-message", ({ sender, text, time }) => {
  const isMine = sender === myUsername;
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${isMine ? "mine" : ""}`;
  bubble.innerHTML = `
    ${!isMine ? `<div class="chat-sender">${sender}</div>` : ""}
    <div class="chat-text">${escapeHtml(text)}</div>
    <div class="chat-time">${time}</div>
  `;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (chatPanel.classList.contains("hidden")) {
    unreadMessages++;
    const badge = document.getElementById("unreadBadge");
    badge.textContent = unreadMessages;
    badge.classList.remove("hidden");
  }
});

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// ---------- Whiteboard ----------
const canvas = document.getElementById("whiteboard");
const ctx = canvas.getContext("2d");
const wbColor = document.getElementById("wbColor");
const wbWidth = document.getElementById("wbWidth");
const wbClear = document.getElementById("wbClear");

let drawing = false;
let lastPoint = null;

// Swatch selection
document.querySelectorAll(".swatch-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    document.querySelectorAll(".swatch-btn").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    const color = btn.getAttribute("data-color");
    wbColor.value = color;
  });
});

function canvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function drawLine(x0, y0, x1, y1, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

canvas.addEventListener("mousedown", (e) => {
  drawing = true;
  lastPoint = canvasPoint(e);
});

canvas.addEventListener("mousemove", (e) => {
  if (!drawing) return;
  const point = canvasPoint(e);
  const color = wbColor.value;
  const width = Number(wbWidth.value);
  drawLine(lastPoint.x, lastPoint.y, point.x, point.y, color, width);
  socket.emit("whiteboard-draw", { x0: lastPoint.x, y0: lastPoint.y, x1: point.x, y1: point.y, color, width });
  lastPoint = point;
});

["mouseup", "mouseleave"].forEach((evt) =>
  canvas.addEventListener(evt, () => (drawing = false))
);

wbClear.addEventListener("click", () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  socket.emit("whiteboard-clear");
});

socket.on("whiteboard-draw", ({ x0, y0, x1, y1, color, width }) => {
  drawLine(x0, y0, x1, y1, color, width);
});

socket.on("whiteboard-clear", () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
});

// ---------- File Sharing ----------
const fileInput = document.getElementById("fileInput");
const fileList = document.getElementById("fileList");

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    alert("File size limit is 8 MB.");
    fileInput.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    socket.emit("file-share", {
      fileName: file.name,
      fileType: file.type,
      fileData: reader.result,
    });
    addFileListItem(file.name, reader.result, "you");
    showToast(`Shared file: ${file.name}`);
  };
  reader.readAsDataURL(file);
  fileInput.value = "";
});

socket.on("file-share", ({ fileName, fileData, fromUsername }) => {
  addFileListItem(fileName, fileData, fromUsername);
  showToast(`New file shared by ${fromUsername}`);
});

socket.on("file-share-error", ({ message }) => {
  alert(message);
});

function addFileListItem(fileName, dataUrl, from) {
  const div = document.createElement("div");
  div.className = "file-item";
  div.innerHTML = `
    <div class="file-item-info">
      <a class="file-item-name" href="${dataUrl}" download="${escapeHtml(fileName)}">${escapeHtml(fileName)}</a>
      <span class="file-item-meta">Shared by ${escapeHtml(from)}</span>
    </div>
    <a href="${dataUrl}" download="${escapeHtml(fileName)}" class="btn-icon" style="width: 32px; height: 32px;" title="Download">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
    </a>
  `;
  fileList.prepend(div);
}

// ---------- Start ----------
initLocalMedia().catch((err) => {
  alert("Camera/microphone access is required to join the call.");
  console.error(err);
  socket.disconnect();
  window.location.href = "index.html";
});
