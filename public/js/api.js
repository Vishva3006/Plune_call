const tabLogin = document.getElementById("tabLogin");
const tabRegister = document.getElementById("tabRegister");
const authForm = document.getElementById("authForm");
const submitBtn = document.getElementById("submitBtn");
const authError = document.getElementById("authError");
const roomPicker = document.getElementById("roomPicker");
const joinBtn = document.getElementById("joinBtn");

let mode = "login"; // or "register"

function setMode(newMode) {
  mode = newMode;
  tabLogin.classList.toggle("active", mode === "login");
  tabRegister.classList.toggle("active", mode === "register");
  submitBtn.textContent = mode === "login" ? "Log in" : "Create account";
  authError.textContent = "";
}

tabLogin.addEventListener("click", () => setMode("login"));
tabRegister.addEventListener("click", () => setMode("register"));

const logoutBtn = document.getElementById("logoutBtn");
const userGreeting = document.getElementById("userGreeting");

// Validate token with server on load
async function checkExistingAuth() {
  const token = localStorage.getItem("token");
  const username = localStorage.getItem("username");
  if (!token) {
    showAuthForm();
    return;
  }

  const apiBase = window.location.protocol.startsWith("http") ? "" : "http://localhost:3000";

  try {
    const res = await fetch(`${apiBase}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      localStorage.setItem("username", data.username);
      showRoomPicker(data.username);
      return;
    }
  } catch (err) {
    console.warn("Auth validation failed:", err);
  }

  // Token invalid or expired — clear stored credentials
  localStorage.removeItem("token");
  localStorage.removeItem("username");
  showAuthForm();
}

function showAuthForm() {
  authForm.classList.remove("hidden");
  roomPicker.classList.add("hidden");
  document.querySelector(".tabs").style.display = "flex";
}

function showRoomPicker(username) {
  authForm.classList.add("hidden");
  document.querySelector(".tabs").style.display = "none";
  if (userGreeting) userGreeting.textContent = `Logged in as ${username}`;
  roomPicker.classList.remove("hidden");
}

if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    localStorage.removeItem("token");
    localStorage.removeItem("username");
    showAuthForm();
  });
}

checkExistingAuth();

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.textContent = "";
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  const apiBase = window.location.protocol.startsWith("http") ? "" : "http://localhost:3000";

  try {
    const res = await fetch(`${apiBase}/api/${mode === "login" ? "login" : "register"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    let data;
    const contentType = res.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      data = await res.json();
    } else {
      const text = await res.text();
      throw new Error(text || `Server returned HTTP status ${res.status}`);
    }

    if (!res.ok) throw new Error(data.error || "Something went wrong");

    localStorage.setItem("token", data.token);
    localStorage.setItem("username", data.username);

    showRoomPicker(data.username);
  } catch (err) {
    if (err.name === "TypeError" && err.message.toLowerCase().includes("fetch")) {
      authError.textContent = "Unable to connect to server. Please ensure the backend server is running at http://localhost:3000";
    } else {
      authError.textContent = err.message || "An unexpected error occurred";
    }
  }
});

joinBtn.addEventListener("click", () => {
  const roomId = document.getElementById("roomId").value.trim();
  if (!roomId) return;
  window.location.href = `room.html?room=${encodeURIComponent(roomId)}`;
});
