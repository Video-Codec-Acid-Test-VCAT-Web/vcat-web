const API_BASE = "http://localhost:5050";
let session_token = null;
let selectedDevice = null;
let currentDeviceInfo = null;

const chartsByTabId = {};



const COLORS = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8',
  '#f58231', '#911eb4', '#46f0f0', '#f032e6',
  '#bcf60c', '#fabebe', '#008080', '#e6beff',
  '#9a6324', '#fffac8', '#800000', '#aaffc3',
  '#808000', '#ffd8b1', '#000075', '#808080'
];



function fetchDeviceInfo(deviceId, refresh = false) {
    const r = refresh ? "&refresh=1" : "";
    return fetch(`${API_BASE}/api/device/info?session=${session_token}&device=${deviceId}${r}`)
      .then(res => res.json())
      .catch(err => {
        console.error("❌ Failed to fetch device info:", err);
        return null;
      });
  }


function waitForChartAndStartPolling() {
  const canvas = document.getElementById("telemetry-cpuChart");
  const canvasReady = canvas && canvas.getContext;

  if (typeof Chart !== 'undefined' && canvasReady) {
    console.log("✅ Chart.js and canvas ready — starting polling");
    fetchAndUpdateTelemetry(); // Initial draw
    window.telemetryInterval = setInterval(fetchAndUpdateTelemetry, 30000);
    updateSnapshotButtons();
  } else {
    console.log("⏳ Waiting for Chart.js and canvas...");
    setTimeout(waitForChartAndStartPolling, 100); // Retry every 100ms
  }
}



function setBtnEnabled(btn, enabled) {
  if (!btn) return;
  btn.style.pointerEvents = enabled ? "auto" : "none";
  btn.style.opacity = enabled ? "1.0" : "0.4";
  btn.style.cursor = enabled ? "pointer" : "not-allowed";
}

// Save Snapshot + Reset Telemetry are enabled only while a live session
// (vcat-d or vcat-ai) is active.
function updateSnapshotButtons() {
  const live = !!(aiLivePoll || window.telemetryInterval);
  setBtnEnabled(document.getElementById("save-snapshot-btn"), live);
  setBtnEnabled(document.getElementById("reset-telemetry-btn"), live);
}

async function isVcatRunning(deviceId, app = "vcat_d") {
  try {
    const res = await fetch(
      `/api/device/vcat_running?session=${session_token}&device=${deviceId}&app=${app}`
    );
    if (!res.ok) return false;
    return !!(await res.json()).running;
  } catch (err) {
    console.error("vcat_running check failed:", err);
    return false;
  }
}

// vcat-d toolbar: Launch is enabled only when the app is NOT running; Connect /
// Run Config / Console are enabled only when it IS running.
async function updateVcatdToolbar(deviceId) {
  if (!deviceId) return;
  const running = await isVcatRunning(deviceId);
  setBtnEnabled(document.getElementById("launch-btn"), !running);
  setBtnEnabled(document.getElementById("connect-btn"), running);
  setBtnEnabled(document.getElementById("run-config-btn"), running);
  setBtnEnabled(document.getElementById("console-btn"), running);
}

async function handleLaunchClick() {
  const deviceId = document.getElementById("device")?.value;
  if (!deviceId) return;

  setBtnEnabled(document.getElementById("launch-btn"), false); // guard against double-click
  try {
    await fetch(`/api/device/launch_vcat?session=${session_token}&device=${deviceId}`);
  } catch (err) {
    console.error("Launch failed:", err);
  }

  // The app takes a moment to come up — poll until it reports running.
  for (let i = 0; i < 12; i++) {
    if (await isVcatRunning(deviceId)) break;
    await new Promise(r => setTimeout(r, 800));
  }
  updateVcatdToolbar(deviceId);

  // App is up now — refresh device info so the newly-available IP shows.
  const info = await fetchDeviceInfo(deviceId, true);
  if (info) populateDeviceInfo(info);
  updateConsoleLog();
}

// vcat-ai toolbar: same enable/disable rule as vcat-d, but only Launch is wired.
// Connect / Run Config / Console reflect running state yet do nothing on click.
async function updateAiToolbar(deviceId) {
  if (!deviceId) return;
  const running = await isVcatRunning(deviceId, "vcat_ai");
  setBtnEnabled(document.getElementById("ai-launch-btn"), !running);
  setBtnEnabled(document.getElementById("ai-connect-btn"), running);
  setBtnEnabled(document.getElementById("ai-run-config-btn"), running);
  setBtnEnabled(document.getElementById("ai-console-btn"), running);
}

async function handleAiLaunchClick() {
  const deviceId = document.getElementById("device")?.value;
  if (!deviceId) return;

  setBtnEnabled(document.getElementById("ai-launch-btn"), false);
  try {
    await fetch(`/api/device/launch_vcat?session=${session_token}&device=${deviceId}&app=vcat_ai`);
  } catch (err) {
    console.error("vcat-ai launch failed:", err);
  }

  for (let i = 0; i < 12; i++) {
    if (await isVcatRunning(deviceId, "vcat_ai")) break;
    await new Promise(r => setTimeout(r, 800));
  }
  updateAiToolbar(deviceId);

  // App is up now — refresh vcat-ai device details (IP etc. now available).
  loadAiDeviceInfo(deviceId);
}

// ---- vcat-ai live monitoring ----
// System telemetry (per-core CPU/freq/mem/battery) comes from the ADB worker;
// AI processing time + temperature + test info come from the active log file.
let aiLivePoll = null;
const AI_LIVE_TAB = "ai-live";

// Newest log file (the one being written) in an app's test_results folder.
async function getActiveLog(deviceId, appId) {
  const root = await getAppRoot(deviceId, appId);
  if (!root) return null;
  try {
    const path = `${root}/test_results/*.csv`;
    const res = await fetch(
      `/api/device/test_results_files?session=${session_token}&device=${deviceId}&path=${encodeURIComponent(path)}`
    );
    if (!res.ok) return null;
    const files = await res.json(); // backend sorts newest-first
    return files.length ? files[0].path : null;
  } catch (err) {
    console.error("getActiveLog failed:", err);
    return null;
  }
}

// Snapshot the currently-live session to a host CSV (with per-core CPU columns).
// Non-destructive — the live session keeps running.
async function saveLiveSession() {
  const deviceId = document.getElementById("device")?.value;
  if (!deviceId) return alert("No device selected.");
  const app = aiLivePoll ? "vcat_ai" : (window.telemetryInterval ? "vcat_d" : null);
  if (!app) return alert("No live session to save — connect (Go Live) first.");

  const activeLog = await getActiveLog(deviceId, app);
  if (!activeLog) return alert("No active log file found to save.");

  try {
    const res = await fetch(
      `/api/vcat_monitor/save_session?session=${session_token}&device=${deviceId}&telemetry_file_path=${encodeURIComponent(activeLog)}`,
      { method: "POST" }
    );
    const data = await res.json();
    if (data.status === "saved") {
      alert(`Saved session: ${data.name}`);
    } else {
      alert(`Save failed: ${data.message || "error"}`);
    }
  } catch (err) {
    console.error("Save session failed:", err);
    alert("Save failed.");
  }
}

// Browse to a session CSV, upload it to the server, then open it (no device needed).
async function handleLoadFile(input) {
  const file = input.files && input.files[0];
  input.value = ""; // allow re-picking the same file
  if (!file) return;
  try {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/vcat_monitor/upload_session?session=${session_token}`, {
      method: "POST",
      body: fd,
    });
    const data = await res.json();
    if (data.status === "ok") loadSavedSession(data.name);
    else alert(`Load failed: ${data.message || "error"}`);
  } catch (err) {
    console.error("Load failed:", err);
    alert("Load failed.");
  }
}

// Add an app-rail tab if it's missing (so Load works with no device connected).
function ensureAppTab(appId) {
  const rail = document.getElementById("app-rail");
  if (!rail || document.getElementById(`app-rail-btn-${appId}`)) return;
  const btn = document.createElement("button");
  btn.className = "app-rail-btn";
  btn.id = `app-rail-btn-${appId}`;
  const icon = APP_RAIL_ICONS[appId];
  if (icon) {
    btn.title = icon.hover;
    const img = document.createElement("img");
    img.src = icon.logo; img.alt = appId;
    btn.appendChild(img);
  } else {
    btn.textContent = appId;
  }
  btn.onclick = () => showAppTab(appId);
  rail.appendChild(btn);
}

// Load a saved session (host CSV) — no connected device required. Infers the
// app from the filename, reveals the UI, and opens the matching viewer.
function loadSavedSession(name) {
  if (!name) return;
  const app = name.includes("vcatai") ? "vcat_ai" : "vcat_d";

  const overlay = document.getElementById("no-device-overlay");
  if (overlay) overlay.style.display = "none";
  const tc = document.getElementById("tab-content"); if (tc) tc.style.display = "block";
  const th = document.getElementById("tab-header"); if (th) th.style.display = "flex";

  ensureAppTab(app);
  showAppTab(app);

  if (app === "vcat_ai") openAiLogFile(name, true);
  else handleConnectClick(name, true);
}

// Tear down the vcat-ai live UI (poll loop + tab + connect button).
function stopAiLive() {
  if (aiLivePoll) { clearInterval(aiLivePoll); aiLivePoll = null; }
  document.getElementById(`${AI_LIVE_TAB}-tab-btn`)?.remove();
  document.getElementById(`${AI_LIVE_TAB}-tab`)?.remove();
  if (chartsByTabId[AI_LIVE_TAB]) delete chartsByTabId[AI_LIVE_TAB];
  setAiConnectState(false);
}

// Tear down the vcat-d live UI (poll loop + live tab + connect button).
function stopVcatdLive() {
  if (window.telemetryInterval) { clearInterval(window.telemetryInterval); window.telemetryInterval = null; }
  document.getElementById("telemetry-tab-btn")?.remove();
  document.getElementById("telemetry-tab")?.remove();
  if (chartsByTabId["telemetry"]) delete chartsByTabId["telemetry"];
  const btn = document.getElementById("connect-btn");
  if (btn) {
    btn.src = "/static/btn_connect_device.png";
    btn.title = "Connect (Go Live)";
    btn.onclick = () => handleConnectClick("Live");
  }
  updateSnapshotButtons();
}

function setAiConnectState(connected) {
  const btn = document.getElementById("ai-connect-btn");
  if (!btn) return;
  if (connected) {
    btn.src = "/static/btn_disconnect_device.png";
    btn.title = "Disconnect";
    btn.onclick = handleAiDisconnectClick;
  } else {
    btn.src = "/static/btn_connect_device.png";
    btn.title = "Connect (Go Live)";
    btn.onclick = handleAiConnectClick;
  }
  updateSnapshotButtons();
}

async function handleAiConnectClick() {
  const deviceId = document.getElementById("device")?.value;
  if (!deviceId) return;

  // Mutual exclusion: if vcat-d is live, confirm, then tear down its live UI.
  if (window.telemetryInterval) {
    if (!confirm("vcat-d is connected. Disconnect it and connect vcat-ai?")) return;
    stopVcatdLive();
  }

  try {
    await fetch(
      `/api/vcat_monitor/start?session=${session_token}&device=${deviceId}&app=vcat_ai`,
      { method: "POST" }
    );
  } catch (err) {
    console.error("vcat-ai connect failed:", err);
    return;
  }

  // Live tab in the vcat-ai panel (charts minus frame drops, plus AI/temp).
  const tabId = AI_LIVE_TAB;
  if (!document.getElementById(`${tabId}-tab-btn`)) {
    const header = document.getElementById("ai-tab-header");
    const btn = document.createElement("button");
    btn.id = `${tabId}-tab-btn`;
    btn.className = "ai-tab-btn";
    btn.textContent = "Live Session";
    btn.onclick = () => showAiTab(tabId);
    header.appendChild(btn);

    const pane = document.createElement("div");
    pane.id = `${tabId}-tab`;
    pane.className = "ai-tab-pane";
    pane.style.display = "none";
    document.getElementById("ai-tab-content").appendChild(pane);
    setupAiTelemetryCanvas(tabId);
  }
  showAiTab(tabId);

  const poll = async () => {
    // Worker telemetry: per-core CPU (ADB) — the app can't self-report it.
    let workerTel = null;
    try {
      const sys = await (await fetch(`${API_TELEMETRY}?session=${session_token}&device=${deviceId}`)).json();
      workerTel = sys.telemetry_data || null;
    } catch (err) { /* keep polling */ }

    // Log file: total CPU + CPU freq, memory, battery, temperature, AI proc
    // time, and test info (full history, so timelines match).
    const activeLog = await getActiveLog(deviceId, "vcat_ai");
    if (activeLog) {
      try {
        const lg = await (await fetch(
          `/api/vcat_monitor/telemetry_from_file?session=${session_token}&device=${deviceId}&app=vcat_ai&telemetry_file_path=${encodeURIComponent(activeLog)}`
        )).json();
        const lt = lg.telemetry_data;
        if (lt) {
          updateMixedCpuChart(lt, workerTel, tabId); // total (log) + per-core (worker)
          updateFreqChart(lt, tabId);
          updateMemoryChart(lt, tabId);
          updateBatteryChart(lt, tabId);
          updateTempChart(lt, tabId);
          updateAiProcChart(lt, tabId);
        }
        renderAiTestDetails(document.getElementById(`${tabId}-ai-test-details`), lg.ai_test);
      } catch (err) { /* keep polling */ }
    }
  };

  poll();
  if (aiLivePoll) clearInterval(aiLivePoll);
  aiLivePoll = setInterval(poll, 5000);

  setAiConnectState(true);
  updateAiToolbar(deviceId);
}

async function handleAiDisconnectClick() {
  const deviceId = document.getElementById("device")?.value;
  if (aiLivePoll) { clearInterval(aiLivePoll); aiLivePoll = null; }

  try {
    await fetch(`/api/vcat_monitor/stop?session=${session_token}&device=${deviceId}`, { method: "POST" });
  } catch (err) { /* ignore */ }

  document.getElementById(`${AI_LIVE_TAB}-tab-btn`)?.remove();
  document.getElementById(`${AI_LIVE_TAB}-tab`)?.remove();
  if (chartsByTabId[AI_LIVE_TAB]) delete chartsByTabId[AI_LIVE_TAB];
  showAiTab("ai-device");

  setAiConnectState(false);
  updateAiToolbar(deviceId);
}

async function setDeviceConnectionState() {
  const deviceId = selectedDevice;
  const sessionId = session_token;
  const btn = document.getElementById("connect-btn");

  if (!deviceId || !sessionId) {
    console.warn("Missing session or device ID");
    btn.disabled = true;
    btn.style.opacity = "0.5";
    btn.style.cursor = "not-allowed";
    return;
  }

  try {
    const res = await fetch(`/api/vcat_monitor/connected?session=${sessionId}&device=${deviceId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    if (data.monitored) {
      // Device is connected
      btn.src = "/static/btn_disconnect_device.png";
      btn.title = "Disconnect";
      btn.alt = "Disconnect";
      btn.onclick = handleDisconnectClick;
    } else {
      // Device is disconnected
      btn.src = "/static/btn_connect_device.png";
      btn.title = "Connect";
      btn.alt = "Connect";
      btn.onclick = handleConnectClick;
    }

    // Re-enable button in all valid cases
    btn.disabled = false;
    btn.style.opacity = "1.0";
    btn.style.cursor = "pointer";

  } catch (err) {
    console.error("Failed to check connection state:", err);
    btn.disabled = true;
    btn.style.opacity = "0.5";
    btn.style.cursor = "not-allowed";
    btn.title = "Unavailable";
  }
}



function handleConnectClick(source, saved = false) {
  const isLive = source === "Live";
  const filePath = isLive ? null : source;

  const deviceId = document.getElementById("device").value;
  if (!deviceId && !saved) return alert("Select a device first.");
  selectedDevice = deviceId;

  // Mutual exclusion: going live on vcat-d while vcat-ai is live → confirm + tear down.
  if (isLive && aiLivePoll) {
    if (!confirm("vcat-ai is connected. Disconnect it and connect vcat-d?")) return;
    stopAiLive();
  }

  // Safe tab ID generation
  let tabId, tabLabel;
  if (isLive) {
    tabId = "telemetry";
    tabLabel = "Live Session";
  } else {
    const fileName = filePath.split("/").pop();
    tabLabel = fileName;
    tabId = "telemetry-" + fileName.replace(/[^a-zA-Z0-9_-]/g, "-");
  }

  // Create tab button if needed
  if (!document.getElementById(`${tabId}-tab-btn`)) {
    const tabHeader = document.getElementById("tab-header");

    const tabButton = document.createElement("button");
    tabButton.id = `${tabId}-tab-btn`;
    tabButton.className = "tab-button";
    tabButton.onclick = () => showTab(tabId);

    // Label wrapper
    const labelSpan = document.createElement("span");
    labelSpan.textContent = tabLabel;
    tabButton.appendChild(labelSpan);

  // Add close button for non-live tabs
    if (!isLive) {
      const closeBtn = document.createElement("span");
      closeBtn.textContent = " ✖";
      closeBtn.style.marginLeft = "8px";
      closeBtn.style.color = "#ccc";
      closeBtn.style.cursor = "pointer";

      closeBtn.onclick = (e) => {
        e.stopPropagation(); // prevent tab switching
        closeTelemetryTab(tabId);
      };

      tabButton.appendChild(closeBtn);
    }

    tabHeader.appendChild(tabButton);

    // Create tab pane if needed
    if (!document.getElementById(`${tabId}-tab`)) {
      const tabContent = document.getElementById("tab-content");

      const tabPane = document.createElement("div");
      tabPane.id = `${tabId}-tab`;
      tabPane.className = "tab-pane";
      tabPane.style.display = "none";

      tabContent.appendChild(tabPane);

      // ✅ Inject cloned template layout
      setupTelemetryCanvas(tabId);
    }
  }

  function closeTelemetryTab(tabId) {
    console.log("🗑 Closing tab:", tabId);

    // Remove tab button
    const tabButton = document.getElementById(`${tabId}-tab-btn`);
    if (tabButton) tabButton.remove();

    // Remove tab content pane
    const tabPane = document.getElementById(tabId);
    if (tabPane) tabPane.remove();

    // Remove associated charts
    if (chartsByTabId[tabId]) {
      delete chartsByTabId[tabId];
    }

    // Fallback to device tab if live is closed or none selected
    showTab("device");
  }


  function setupTelemetryCanvas(tabId) {
    const template = document.getElementById("telemetry-tab-template");
    const clone = document.importNode(template.content, true);

    // Assign tab-specific canvas IDs
    const canvases = clone.querySelectorAll("canvas[data-id]");
    canvases.forEach(canvas => {
      const type = canvas.getAttribute("data-id");
      canvas.id = `${tabId}-${type}`;
    });

    const tabPane = document.getElementById(`${tabId}-tab`);
    tabPane.appendChild(clone);
  }


  // Create tab content pane if needed
  if (!document.getElementById(`${tabId}-tab`)) {
    const tabContent = document.getElementById("tab-content");
    const tabPane = document.createElement("div");
    tabPane.id = `${tabId}-tab`;
    tabPane.className = "tab-pane";
    tabPane.style.display = "none";
    tabContent.appendChild(tabPane);
  }

  showTab(tabId);

  if (isLive) {
    // ✅ Live telemetry setup
    if (!window.telemetryInterval) {
      setTimeout(() => {
        waitForChartAndStartPolling();  // ← now canvas is in DOM
      }, 100);
    }

    fetchDeviceInfo(deviceId);

    fetch(`${API_BASE}/api/vcat_monitor/start?session=${session_token}&device=${deviceId}`, {
      method: "POST"
    })
        .then(res => {
          if (!res.ok) throw new Error("Failed to start telemetry");
          console.log("🚀 Telemetry started");
          setTimeout(updateConsoleLog, 500);
          setDeviceConnectionState();
        })
        .catch(err => {
          console.error("❌ Telemetry start failed:", err);
          const button = document.getElementById("connect-btn");
          button.disabled = true;
          button.style.opacity = "0.5";
          button.style.cursor = "not-allowed";
        });
  } else {
    // ✅ Static file-based telemetry (device log, or a saved host-side session — no device needed)
    const url = saved
      ? `/api/vcat_monitor/load_saved?session=${session_token}&name=${encodeURIComponent(filePath)}`
      : `/api/vcat_monitor/telemetry_from_file?session=${session_token}&device=${deviceId}&app=vcat_d&telemetry_file_path=${encodeURIComponent(filePath)}`;

    fetch(url)
        .then(res => res.json())
        .then(data => {
          const telemetry = data.telemetry_data;
          const testDetails = data.test_details;

          if (testDetails) {
            updateTestDetailsUI({ test_details: testDetails },tabId);
          }

          updateCpuChart(telemetry, `${tabId}`, tabId);
          updateBatteryChart(telemetry, `${tabId}`, tabId);
          updateFreqChart(telemetry, `${tabId}`, tabId);
          updateMemoryChart(telemetry, `${tabId}`, tabId);
          updateFrameDropChart(telemetry, `${tabId}`, tabId);
          injectTempChart(tabId);
          updateTempChart(telemetry, tabId);
        })
        .catch(err => {
          console.error("❌ Failed to load telemetry from file:", err);
        });
  }
}

function renderTelemetryTab(tabId) {
  const template = document.getElementById("telemetry-tab-template");
  const clone = template.content.cloneNode(true);

  // Fix up all canvas and input IDs to be prefixed with tabId
  clone.querySelectorAll("[id]").forEach(el => {
    el.id = `${tabId}-${el.id}`;
  });

  clone.querySelectorAll("[class]").forEach(el => {
    el.classList.forEach(cls => {
      if (cls.startsWith("cpuChart") || cls.endsWith("Chart") || cls.startsWith("test-") || cls.startsWith("btn-")) {
        el.id = `${tabId}-${cls}`;
      }
    });
  });

  const tabPane = document.createElement("div");
  tabPane.id = `${tabId}-tab`;
  tabPane.className = "tab-pane";
  tabPane.appendChild(clone);

  document.getElementById("tab-content").appendChild(tabPane);
}


function handleDisconnectClick() {
  const deviceId = document.getElementById("device").value;
  if (!deviceId) return alert("Select a device first.");

  fetch(`${API_BASE}/api/vcat_monitor/stop?session=${session_token}&device=${deviceId}`, {
    method: "POST"
  })
    .then(res => {
      if (!res.ok) throw new Error("Failed to stop telemetry");
      console.log("🛑 Telemetry stopped");

      // Stop polling loop if needed
      if (window.telemetryInterval) {
        clearInterval(window.telemetryInterval);
        window.telemetryInterval = null;
      }
      updateSnapshotButtons();

      // Update UI to reflect disconnected state
      setDeviceConnectionState();
      resetTelemetry();
    })
    .catch(err => {
      console.error("❌ Telemetry stop failed:", err);
      const button = document.getElementById("connect-btn");
      button.disabled = true;
      button.style.opacity = "0.5";
      button.style.cursor = "not-allowed";
    });
}


function updateConsoleLog() {
  fetch(`${API_BASE}/api/session_console_log?session=${session_token}`)
    .then(res => res.json())
    .then(data => {
      if (!data || !data.log || data.log.length === 0) return;

      const lastEntry = data.log.at(-1).text.trim();
      const fullLog = data.log.map(entry => entry.text.trim()).join('\n\n');

        // Update floating console
        const modalConsole = document.getElementById("console-full");
        if (modalConsole) modalConsole.textContent = fullLog;

        // ✅ Also update embedded console (in device modal)
        const embeddedConsole = document.getElementById("device-console-body");
        if (embeddedConsole) embeddedConsole.textContent = fullLog;
    })
    .catch(err => {
      console.error("❌ Failed to fetch console log:", err);
    });
}


function extractIpBase(raw) {
  if (!raw || typeof raw !== "string") return "—";
  return raw.replace(/^https?:\/\//, "").split(":")[0] || "—";
}

// Like extractIpBase but keeps the port (important: both apps bind 0.0.0.0,
// so the port is what distinguishes vcat-d from vcat-ai).
function formatIpAddr(raw) {
  if (!raw || typeof raw !== "string") return "—";
  return raw.replace(/^https?:\/\//, "") || "—";
}

function openDeviceModal() {
  if (!currentDeviceInfo) {
    document.getElementById("device-ip").textContent = "Unavailable";
    return;
  }

  const d = currentDeviceInfo;

  document.getElementById("device-ip").textContent = formatIpAddr(d.ip_addr);

  document.getElementById("device-display").textContent = `${d.display_resolution.width}×${d.display_resolution.height}`;
  document.getElementById("device-soc").textContent = `${d.soc_manufacturer} ${d.soc}`;
  document.getElementById("device-storage").textContent = `${d.storage.total} / ${d.storage.available}`;
  document.getElementById("device-memory").textContent = `${d.memory.total} / ${d.memory.available}`;

  const coreCounts = {};
  Object.values(d.cpu.cores).forEach(core => {
    const match = core.match(/Cortex-[A-Z0-9]+/);
    const freqMatch = core.match(/(\d+)\s*MHz/);
    if (match && freqMatch) {
      const label = `${(parseInt(freqMatch[1]) / 1000).toFixed(1)} GHz ${match[0]}`;
      coreCounts[label] = (coreCounts[label] || 0) + 1;
    }
  });

  const coreLines = Object.entries(coreCounts)
    .map(([label, count]) => `${count}×${label}`)
    .join(", ");

  document.getElementById("device-cpu").textContent = `ARMv8: ${coreLines}`;

  loadPlaylistFiles(d.device_id);

  document.getElementById("device-modal").style.display = "block";
}


function closeDeviceModal() {
  document.getElementById("device-modal").style.display = "none";
}

function handleOutsideClick(event) {
  const modal = document.getElementById("device-modal-content");
  if (!modal.contains(event.target)) {
    closeDeviceModal();
  }
}

function closeDeviceModal() {
  document.getElementById("device-modal").style.display = "none";
  document.removeEventListener("click", handleOutsideClick);
}

function openConsoleModal(event) {
  const modal = document.getElementById("console-modal");
  if (!modal) {
    console.error("❌ console-modal not found");
    return;
  }

    // Toggle: if visible, hide it
    if (modal.style.display === "block") {
      closeConsoleModal();
      return;
    }

  const btn = document.getElementById("console-btn");
  const rect = btn?.getBoundingClientRect();

    // Get center of the screen
      const screenCenterX = window.innerWidth / 2;

    // Align left edge to center
    const modalWidth = 600; // Set same as your CSS
    modal.style.top = "200px";
    modal.style.left = `${screenCenterX}px`;

    modal.style.display = "block";

    setTimeout(() => {
        document.addEventListener("click", handleConsoleOutsideClick);
    }, 0);
}


(function makeConsoleDraggable() {
  const modal = document.getElementById("console-modal");
  const header = document.getElementById("console-modal-header");
  let offsetX = 0, offsetY = 0, isDragging = false;

  header.addEventListener("mousedown", (e) => {
    isDragging = true;
    offsetX = e.clientX - modal.offsetLeft;
    offsetY = e.clientY - modal.offsetTop;
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (e) => {
    if (isDragging) {
      modal.style.left = `${e.clientX - offsetX}px`;
      modal.style.top = `${e.clientY - offsetY}px`;
    }
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
    document.body.style.userSelect = "";
  });
})();



function handleConsoleOutsideClick(event) {
  const modal = document.getElementById("console-modal-content");
  if (!modal.contains(event.target)) {
    closeConsoleModal();
  }
}

function closeConsoleModal() {
  document.getElementById("console-modal").style.display = "none";
  document.removeEventListener("click", handleConsoleOutsideClick);
}

function computeStepSize(latestTime) {
  if (latestTime > 24 * 3600) return 4 * 3600;
  if (latestTime > 12 * 3600) return 2 * 3600;
  if (latestTime > 6 * 3600) return 3600;
  return 300;
}

let batteryChart, cpuChart, freqChart, memoryChart, frameDropChart;
let coreLabels = {};

const API_TELEMETRY = '/api/vcat_monitor/telemetry';

function updateChart(chartRef, canvasId, datasets, labels, yLabel, latestTime, stepSize) {
  if (!chartRef) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    chartRef = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: chartOptions(yLabel, latestTime, stepSize)
    });
  } else {
    chartRef.data.labels = labels;
    chartRef.data.datasets = datasets;
    chartRef.options.scales.x.max = latestTime + 60;
    chartRef.options.scales.x.ticks.stepSize = stepSize;
    chartRef.update();
  }
  return chartRef;
}

function updateBatteryChart(telemetry, tabId) {
  const battery = telemetry.battery || [];
  if (!battery.length) return;

  const labels = battery.map(p => p.elapsed_time);
  const data = battery.map(p => p.level);
  const stepSize = computeStepSize(labels.at(-1) || 0);

  const canvasId = `${tabId}-batteryChart`;
  const chartCanvas = document.getElementById(canvasId);
  if (!chartCanvas) {
    console.warn(`⚠️ Battery chart canvas not found: ${canvasId}`);
    return;
  }

  chartsByTabId[tabId] ||= {};
  chartsByTabId[tabId].batteryChart = updateChart(
      chartsByTabId[tabId].batteryChart,
      canvasId,
      [{ label: 'Battery Level (%)', data, borderWidth: 2 }],
      labels,
      'Battery Level (%)',
      labels.at(-1),
      stepSize
  );
}


// Live CPU chart: Total CPU from the log (full test history) + per-core from the
// ADB worker (starts at connect). Per-core samples are shifted onto the log's
// timeline (offset = latest-log-elapsed − latest-worker-elapsed) so they align.
function updateMixedCpuChart(logTel, workerTel, tabId) {
  const canvasId = `${tabId}-cpuChart`;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const logCpu = (logTel && logTel.cpu_usage) || [];
  const wCpu = (workerTel && workerTel.cpu_usage) || [];
  if (!logCpu.length && !wCpu.length) return;

  const datasets = [];

  if (logCpu.length) {
    datasets.push({
      label: "Total CPU (%)",
      data: logCpu.map(p => ({ x: p.elapsed_time, y: p.cpu ?? null })),
      borderColor: COLORS[0], backgroundColor: COLORS[0],
      borderWidth: 2, tension: 0.1, pointRadius: 0,
    });
  }

  const lastW = wCpu.at(-1);
  if (lastW) {
    const logMax = logCpu.length ? logCpu.at(-1).elapsed_time : 0;
    const offset = logMax - wCpu.at(-1).elapsed_time; // align newest samples
    const coreKeys = Object.keys(lastW).filter(k => k.startsWith("cpu") && k !== "cpu");
    coreKeys.forEach((key, i) => {
      datasets.push({
        label: key,
        data: wCpu.map(p => ({ x: offset + p.elapsed_time, y: p[key] ?? null })),
        borderColor: COLORS[(i + 1) % COLORS.length],
        backgroundColor: COLORS[(i + 1) % COLORS.length],
        borderWidth: 2, tension: 0.1, pointRadius: 0,
      });
    });
  }

  const latestTime = logCpu.length ? logCpu.at(-1).elapsed_time : 0;
  const stepSize = computeStepSize(latestTime);

  chartsByTabId[tabId] ||= {};
  let ref = chartsByTabId[tabId].cpuChart;
  if (!ref) {
    ref = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { datasets },
      options: chartOptions("CPU Usage (%)", latestTime, stepSize),
    });
  } else {
    ref.data.datasets = datasets;
    ref.options.scales.x.max = latestTime + 60;
    ref.options.scales.x.ticks.stepSize = stepSize;
    ref.update();
  }
  chartsByTabId[tabId].cpuChart = ref;
}

function updateCpuChart(telemetry, tabId) {
  const cpu = telemetry.cpu_usage || [];
  const labels = cpu.map(p => p.elapsed_time);
  const stepSize = computeStepSize(labels.at(-1) || 0);
  const datasets = [];

  const last = cpu.at(-1);
  if (!last) return; // no data

  const keys = Object.keys(last).filter(k => k.startsWith("cpu"));
  keys.forEach((key, i) => {
    datasets.push({
      label: key === "cpu" ? "Total CPU (%)" : key,
      data: cpu.map(p => p[key] ?? null),
      borderColor: COLORS[i % COLORS.length],
      backgroundColor: COLORS[i % COLORS.length],
      borderWidth: 2,
      tension: 0.1,
      pointRadius: 0
    });
  });

  const canvasId = `${tabId}-cpuChart`;
  const chartCanvas = document.getElementById(canvasId);
  if (!chartCanvas) {
    console.warn(`⚠️ CPU chart canvas not found: ${canvasId}`);
    return;
  }

  chartsByTabId[tabId] ||= {};
  chartsByTabId[tabId].cpuChart = updateChart(
      chartsByTabId[tabId].cpuChart,
      canvasId,  // 🔁 pass ID string, not element
      datasets,
      labels,
      "CPU Usage (%)",
      labels.at(-1),
      stepSize
  );
}




function updateFreqChart(telemetry, tabId) {
  const freq = telemetry.cpu_freq || [];
  if (!freq.length) return;

  const labels = freq.map(p => p.elapsed_time);
  const stepSize = computeStepSize(labels.at(-1) || 0);
  const coreKeys = Object.keys(freq.at(-1)?.frequencies || {});

  const datasets = coreKeys.map((key, i) => ({
    label: key,
    data: freq.map(p => p.frequencies[key]),
    borderColor: COLORS[i % COLORS.length],
    backgroundColor: COLORS[i % COLORS.length],
    borderWidth: 2,
    tension: 0.1,
    pointRadius: 0
  }));

  const canvasId = `${tabId}-freqChart`;
  const chartCanvas = document.getElementById(canvasId);
  if (!chartCanvas) {
    console.warn(`⚠️ Freq chart canvas not found: ${canvasId}`);
    return;
  }

  chartsByTabId[tabId] ||= {};
  chartsByTabId[tabId].freqChart = updateChart(
      chartsByTabId[tabId].freqChart,
      canvasId,
      datasets,
      labels,
      'CPU Frequency (MHz)',
      labels.at(-1),
      stepSize
  );
}


function updateMemoryChart(telemetry, tabId) {
  const system = telemetry.system_memory || [];
  const app = telemetry.app_memory || [];
  if (!system.length) return;

  const labels = system.map(p => p.elapsed_time);
  const appMap = Object.fromEntries(app.map(a => [a.elapsed_time, a.app_kb]));
  const stepSize = computeStepSize(labels.at(-1) || 0);
  const systemData = system.map(p => p.used_kb / 1024);
  const appData = app.map(p => p.used_kb / 1024);

  const datasets = [
    {
      label: 'System Used (MB)',
      data: systemData,
      borderColor: '#0074D9',
      backgroundColor: '#0074D9',
      borderWidth: 2,
      tension: 0.1,
      pointRadius: 0
    },
    {
      label: 'App Used (MB)',
      data: appData,
      borderColor: '#FF4136',
      backgroundColor: '#FF4136',
      borderWidth: 2,
      tension: 0.1,
      pointRadius: 0
    }
  ];

  const canvasId = `${tabId}-memoryChart`;
  const chartCanvas = document.getElementById(canvasId);
  if (!chartCanvas) {
    console.warn(`⚠️ Memory chart canvas not found: ${canvasId}`);
    return;
  }

  chartsByTabId[tabId] ||= {};
  chartsByTabId[tabId].memoryChart = updateChart(
      chartsByTabId[tabId].memoryChart,
      canvasId,
      datasets,
      labels,
      'Memory Usage (MB)',
      labels.at(-1),
      stepSize
  );
}


function updateFrameDropChart(telemetry, tabId) {
  const drops = telemetry.frame_drops || [];
  if (!drops.length) return;

  const labels = drops.map(p => p.elapsed_time);
  const values = drops.map(p => p.delta_framedrops);
  const stepSize = computeStepSize(labels.at(-1) || 0);

  const canvasId = `${tabId}-frameDropChart`;
  const chartCanvas = document.getElementById(canvasId);
  if (!chartCanvas) {
    console.warn(`⚠️ Frame drop chart canvas not found: ${canvasId}`);
    return;
  }

  chartsByTabId[tabId] ||= {};
  chartsByTabId[tabId].frameDropChart = updateChart(
      chartsByTabId[tabId].frameDropChart,
      canvasId,
      [{ label: 'Frame Drops', data: values, borderWidth: 2 }],
      labels,
      'Dropped Frames',
      labels.at(-1),
      stepSize
  );
}

// Optional: Format ISO 8601 string to human-readable (e.g., "04/24/25 16:16:41")
function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    year: "2-digit", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
}


async function fetchAndUpdateTelemetry() {
  const tabId = "telemetry";

  // Worker telemetry: per-core CPU (ADB) + test details.
  let workerTel = null;
  try {
    const result = await (await fetch(
      `${API_TELEMETRY}?session=${session_token}&device=${selectedDevice}`
    )).json();
    workerTel = result.telemetry_data || null;
    if (result.test_details) updateTestDetailsUI({ test_details: result.test_details }, tabId);
  } catch (err) {
    console.error('❌ Telemetry fetch failed:', err);
  }

  // Log file: total CPU + CPU freq, memory, battery, frame drops (full history).
  try {
    const activeLog = await getActiveLog(selectedDevice, "vcat_d");
    if (activeLog) {
      const lg = await (await fetch(
        `/api/vcat_monitor/telemetry_from_file?session=${session_token}&device=${selectedDevice}&app=vcat_d&telemetry_file_path=${encodeURIComponent(activeLog)}`
      )).json();
      const lt = lg.telemetry_data;
      if (lt) {
        updateMixedCpuChart(lt, workerTel, tabId); // total (log) + per-core (worker)
        updateFreqChart(lt, tabId);
        updateMemoryChart(lt, tabId);
        updateBatteryChart(lt, tabId);
        updateFrameDropChart(lt, tabId);
      }
    }
  } catch (err) {
    console.error('❌ Log read failed:', err);
  }
}

function chartOptions(yLabel, latestTime, stepSize) {
  const isCpuChart = yLabel === "CPU Usage (%)";

  return {
    responsive: true,
    animation: false,
    scales: {
      x: {
        type: 'linear',
        min: 0,
        max: latestTime + 60,
        title: { display: true, text: 'Elapsed Time (s)' },
        ticks: { stepSize: stepSize }
      },
      y: {
        beginAtZero: true,
        min: 0,
        max: isCpuChart ? 100 : undefined, // ✅ only set max for CPU chart
        title: { display: true, text: yLabel }
      }
    },
    plugins: {
      legend: { display: true }
    }
  };
}


function chartOptions(yLabel, latestTime, stepSize) {
    
  const isCpuChart = yLabel === "CPU Usage (%)";
  return {
    responsive: true,
    animation: false,
    elements: { point: { radius: 0 } },
    interaction: { mode: 'index', intersect: false },
    layout: { padding: 0 },
    scales: {
      x: {
        type: 'linear',
        min: 0,
        suggestedMax: latestTime + 60, // ✅ allows x-axis to expand but not scroll
        title: { display: true, text: 'Elapsed Time (hh:mm)' },
        ticks: {
          stepSize,
          callback: (value) => {
            const h = Math.floor(value / 3600);
            const m = Math.floor((value % 3600) / 60);
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          }
        }
      },
      y: {
        beginAtZero: true,
        title: { display: true, text: yLabel },
        ticks: { precision: 0 },
        max: isCpuChart ? 100 : undefined, // ✅ only set max for CPU chart
      }
    },
    plugins: {
      legend: {
        position: 'bottom',
        labels: { boxWidth: 12, padding: 10 }
      },
      zoom: false // ✅ completely disable zoom plugin
    }
  };
}

const API_RUN_CONFIG = '/api/device/run_config';
// Modal control for Run Config
function openRunConfigModal() {

  const deviceSelect = document.getElementById("device");
  const selectedDeviceId = deviceSelect?.value;
  if (!selectedDeviceId) return;

    fetch(`${API_RUN_CONFIG}?session=${session_token}&device=${selectedDeviceId}`)

    .then(res => res.json())
    .then(config => {
      const modal = document.getElementById("run-config-modal");
      const modalBody = document.getElementById("run-config-body");

      renderRunConfigUI(config);

      // Position the modal below the gear icon (if exists)

      const btn = document.getElementById("run-config-btn");
      const rect = btn?.getBoundingClientRect();
      const modalContent = document.getElementById("run-config-modal-content");

      if (rect && modalContent) {
        modalContent.style.top = `${rect.bottom + window.scrollY + 10}px`;
        modalContent.style.left = `${rect.left + window.scrollX}px`;
      }

      modal.style.display = "block";
      setTimeout(() => {
        document.addEventListener("click", handleRunConfigOutsideClick);
      }, 0);
    })
    .catch(err => {
      console.error("❌ Failed to fetch run config:", err);
    });
}

function renderRunConfigUI(config) {
  const container = document.getElementById("run-config-modal-content");
  if (!container) {
    console.error("❌ Missing modal container");
    return;
  }

  container.innerHTML = '';

  const section = document.createElement("div");
  section.innerHTML = `
    <h2 style="margin-top: 0;">Run Configuration</h2>

    <label>Screen Brightness: <span id="brightness-value">${config.screenBrightness}</span>%</label>
    <input type="range" min="0" max="100" value="${config.screenBrightness}" disabled
           oninput="document.getElementById('brightness-value').innerText = this.value" />

    <label style="margin-top: 12px;">Threads:</label>
    <select id="threads-select" disabled>
      ${[1, 2, 3, 4].map(i => `<option ${i === config.threads ? 'selected' : ''}>${i}</option>`).join('')}
    </select>

    <fieldset style="margin-top: 12px;" disabled>
      <legend>Run Mode:</legend>
      ${["ONCE", "BATTERY", "TIME"].map(mode => `
        <label>
          <input type="radio" name="runMode" value="${mode}" ${config.runMode === mode ? 'checked' : ''} disabled>
          ${mode}
        </label>
      `).join('<br>')}
    </fieldset>

    <label style="margin-top: 12px;">Run Limit:</label>
    <input type="number" min="1" value="${config.runLimit}" style="width: 60px;" disabled />

    <label style="margin-top: 12px;">
      <input type="checkbox" ${config.showVlcControls ? 'checked' : ''} disabled>
      Show VLC Controls
    </label>

    <h3 style="margin-top: 20px;">Decoder Configuration</h3>
    <table style="width: 100%; border-collapse: collapse; margin-top: 8px;">
      <thead><tr><th style="text-align:left;">MIME Type</th><th style="text-align:left;">Decoder</th></tr></thead>
      <tbody>
        ${Object.entries(config.decoderCfg.decoderConfig).map(([mime, decoder]) => `
          <tr><td>${mime}</td><td>${decoder}</td></tr>
        `).join('')}
      </tbody>
    </table>
  `;
  container.appendChild(section);
}



function closeRunConfigModal() {
  document.getElementById("run-config-modal").style.display = "none";
  document.removeEventListener("click", handleRunConfigOutsideClick);
}

function handleRunConfigOutsideClick(event) {
  const modal = document.getElementById("run-config-modal-content");
  if (!modal.contains(event.target)) {
    closeRunConfigModal();
  }
}

/**
 * Strip off everything up to the last slash/backslash
 * @param {string} fullPath
 * @returns {string} just the file name (or empty string)
 */
function getFileName(fullPath) {
  return (fullPath || "").replace(/^.*[\\/]/, "");
}

function updateTestDetailsUI(data, tabId) {
  const tabRoot = document.getElementById(`${tabId}-tab`);
  if (!tabRoot || !data.test_details) return;

  const details = data.test_details;
  const curVideo = details.currentTestVideo;

  playlistFileName = getFileName(details.playlist || "")

  // Top-level test info
  tabRoot.querySelector(".test-state").value = details.testState || "";
  tabRoot.querySelector(".test-start-time").value = details.startTime || "";
  tabRoot.querySelector(".test-playlist").value = playlistFileName;

  if (curVideo) {
    curVideoFileName = getFileName(curVideo.fileName || "");
    tabRoot.querySelector(".current-start-time").value = curVideo.startTime || "";
    tabRoot.querySelector(".test-file").value = curVideoFileName;
    tabRoot.querySelector(".test-codec").value = curVideo.videoCodec || "";
    tabRoot.querySelector(".test-decoder").value = curVideo.videoDecoder || "";
    tabRoot.querySelector(".test-resolution").value = curVideo.resolution || "";
    tabRoot.querySelector(".test-mimetype").value = curVideo.mimeType || "";
    tabRoot.querySelector(".test-bitrate").value = curVideo.bitrate || "";
    tabRoot.querySelector(".test-framerate").value =
        (curVideo.framerate !== undefined) ? curVideo.framerate.toFixed(1) : "";
  }

  updatePlayerControlsState(tabId);
}

function sendControlCommand(cmd) {
  const url = `${API_BASE}/api/device/${cmd}?session=${session_token}&device=${selectedDevice}`;
  fetch(url, { method: 'POST' })
    .then(res => {
      if (!res.ok) throw new Error(`${cmd} failed`);
      console.log(`✅ ${cmd} sent successfully`);
    })
    .catch(err => {
      console.error(`❌ ${cmd} error:`, err);
    });
}

function openResetModal() {
  document.getElementById("reset-modal").style.display = "block";
}

function closeResetModal() {
  document.getElementById("reset-modal").style.display = "none";
}

function confirmResetTelemetry() {
  resetTelemetry();
  closeResetModal();
}

function resetTestStatus() {
  // Top-level test info
  document.getElementById("test-state").value = "";
  document.getElementById("test-start-time").value = "";
  document.getElementById("test-playlist").value = "";

  // Current Test Video section
  document.getElementById("current-start-time").value = "";
  document.getElementById("test-file").value = "";
  document.getElementById("test-codec").value = "";
  document.getElementById("test-decoder").value = "";
  document.getElementById("test-resolution").value = "";
  document.getElementById("test-mimetype").value = "";
  document.getElementById("test-bitrate").value = "";
  document.getElementById("test-framerate").value = "";

  updatePlayerControlsState();  // 👈 Keep player controls in sync
}


function resetTelemetry() {
    if (!session_token || !selectedDevice) {
    console.error("❌ Session or device not selected!");
    return;
    }
    
    resetTestStatus();
    updatePlayerControlsState();

    // Clear existing chart data immediately
    if (batteryChart) {
      batteryChart.data.labels = [];
      batteryChart.data.datasets.forEach(ds => ds.data = []);
      batteryChart.update();
    }
    if (cpuChart) {
      cpuChart.data.labels = [];
      cpuChart.data.datasets.forEach(ds => ds.data = []);
      cpuChart.update();
    }
    if (freqChart) {
      freqChart.data.labels = [];
      freqChart.data.datasets.forEach(ds => ds.data = []);
      freqChart.update();
    }
    if (memoryChart) {
      memoryChart.data.labels = [];
      memoryChart.data.datasets.forEach(ds => ds.data = []);
      memoryChart.update();
    }
    if (frameDropChart) {
      frameDropChart.data.labels = [];
      frameDropChart.data.datasets.forEach(ds => ds.data = []);
      frameDropChart.update();
    }

    fetch(`/api/vcat_monitor/reset?session=${session_token}&device=${selectedDevice}`, { method: "POST" })
    .then(res => {
      if (res.ok) {
        console.log("✅ Telemetry reset successfully");
        // maybe reload telemetry graphs? Up to you
      } else {
        console.error("❌ Telemetry reset failed");
      }
    })
    .catch(err => {
      console.error("❌ Error resetting telemetry:", err);
    });
}

function openWirelessModal() {
  document.getElementById("wireless-modal").style.display = "block";
}

function closeWirelessModal() {
  document.getElementById("wireless-modal").style.display = "none";
}

function confirmWirelessAdb() {
  closeWirelessModal();

  if (!session_token || !selectedDevice) {
    alert("No device selected.");
    return;
  }

  fetch(`/api/wireless_adb?session=${session_token}&device=${selectedDevice}`)
    .then(res => res.json())
    .then(data => {
      alert(data.message || data.error);
      setTimeout(() => location.reload(), 1000);  // Give 1s for clarity
    })
    .catch(err => {
      console.error("❌ Wireless ADB setup failed:", err);
      alert("Wireless ADB setup failed.");
    });
}

function updatePlayerControlsState(tabId) {
    const tabRoot = document.getElementById(`${tabId}-tab`);
    if (!tabRoot) return;

    const state = tabRoot.querySelector(".test-state").value;
    const enabled = (state === "Running");

    ["btn-play-pause","btn-video-stats","btn-stop-test"].forEach(cls => {
      const btn = tabRoot.querySelector(`.${cls}`);
      if (!btn) return;
      btn.style.pointerEvents = enabled ? "auto" : "none";
      btn.style.opacity       = enabled ? "1.0"  : "0.4";
      btn.style.cursor        = enabled ? "pointer" : "not-allowed";
    });
}


function handleDeviceSelection() {
  const deviceSelect = document.getElementById("device");
  const selectedDeviceId = deviceSelect?.value;

  if (selectedDeviceId && deviceSelect.options.length > 0) {
    updateDeviceTabLabel(selectedDeviceId);

    // Detect installed VCAT apps and build the far-left app rail on selection
    // (independent of going live).
    setupAppTabs(selectedDeviceId);

    // Enable/disable the vcat-d toolbar (Launch vs Connect/Run Config/Console)
    // based on whether the app is currently running.
    updateVcatdToolbar(selectedDeviceId);

    fetchDeviceInfo(selectedDeviceId).then(info => {
      if (info) {
        populateDeviceInfo(info);
        showTab("device");
      }
    });
  }
}



function pingDevice() {
    const deviceSelect = document.getElementById("device");
    const selectedDeviceId = deviceSelect.value;
    const url = `${API_BASE}/api/device/ping?session=${session_token}&device=${selectedDeviceId}`;

    fetch(url)
        .then(res => res.json())
        .then(data => {
            // Optionally show a toast or notification
            console.log("Ping completed:", data.message);
            setTimeout(updateConsoleLog, 500);  // Refresh console shortly after ping finishes
        })
        .catch(err => {
            console.error("Ping request failed:", err);
            setTimeout(updateConsoleLog, 500);
        });
}

// Main JS logic for VCAT tabbed interface

// Far-left app rail: on connect, detect which VCAT builds are installed on the
// device and render one tab per installed app. vcat-d hosts the full monitor UI;
// vcat-ai is a placeholder for now. An app that isn't installed gets no tab.
// Logo + hover text for each app-rail tab.
const APP_RAIL_ICONS = {
  vcat_d: { logo: "/static/vcat_d_logo.png", hover: "vcat-d" },
  vcat_ai: { logo: "/static/vcat_ai_logo.png", hover: "vcat-ai" },
};

async function setupAppTabs(deviceId) {
  const rail = document.getElementById("app-rail");
  if (!rail) return;

  let apps = [];
  try {
    const res = await fetch(
      `/api/device/vcat_apps?session=${session_token}&device=${deviceId}`
    );
    if (res.ok) apps = await res.json();
  } catch (err) {
    console.error("Failed to detect VCAT apps:", err);
  }

  rail.innerHTML = "";
  document.querySelectorAll(".app-panel").forEach(p => (p.style.display = "none"));

  if (!apps.length) {
    // No known VCAT app detected — fall back to the vcat-d panel.
    const fallback = document.getElementById("app-panel-vcat_d");
    if (fallback) fallback.style.display = "block";
    return;
  }

  apps.forEach(app => {
    const btn = document.createElement("button");
    btn.className = "app-rail-btn";
    btn.id = `app-rail-btn-${app.id}`;

    const icon = APP_RAIL_ICONS[app.id];
    if (icon) {
      btn.title = icon.hover;
      const img = document.createElement("img");
      img.src = icon.logo;
      img.alt = app.label;
      btn.appendChild(img);
    } else {
      btn.textContent = app.label;
      btn.title = app.label;
    }

    btn.onclick = () => showAppTab(app.id);
    rail.appendChild(btn);
  });

  showAppTab(apps[0].id);
}

function showAppTab(appId) {
  document.querySelectorAll(".app-panel").forEach(p => (p.style.display = "none"));
  const panel = document.getElementById(`app-panel-${appId}`);
  if (panel) panel.style.display = "block";

  document.querySelectorAll(".app-rail-btn").forEach(b => b.classList.remove("active"));
  const activeBtn = document.getElementById(`app-rail-btn-${appId}`);
  if (activeBtn) activeBtn.classList.add("active");

  if (appId === "vcat_ai") {
    const dev = document.getElementById("device")?.value;
    loadAiDeviceInfo(dev);
    loadAiTests(dev);
    loadAiTestResults(dev);
    updateAiToolbar(dev);
    showAiSubTab("tests");
  }

  sizeScrollAreas();
}

// Filesystem-scan folder discovery, keyed by device id. Finds each installed
// app's data folder by its log files — no app needs to be running (non-live).
const scannedFoldersCache = {};
const scanPromiseCache = {};

async function getScannedFolders(deviceId) {
  if (scannedFoldersCache[deviceId]) return scannedFoldersCache[deviceId];

  // Dedupe concurrent scans (device selection kicks off several loaders at once).
  if (!scanPromiseCache[deviceId]) {
    scanPromiseCache[deviceId] = (async () => {
      try {
        const res = await fetch(
          `/api/device/scan_folders?session=${session_token}&device=${deviceId}`
        );
        return res.ok ? await res.json() : {};
      } catch (err) {
        console.error("Folder scan failed:", err);
        return {};
      }
    })();
  }

  const folders = await scanPromiseCache[deviceId];
  if (Object.keys(folders).length) {
    scannedFoldersCache[deviceId] = folders; // cache only a successful scan
  } else {
    delete scanPromiseCache[deviceId]; // allow a retry later (e.g. after a test runs)
  }
  return folders;
}

async function getAppRoot(deviceId, appId) {
  const folders = await getScannedFolders(deviceId);
  return folders && folders[appId] ? folders[appId].root : null;
}

function showAiSubTab(name) {
  ["tests", "test-results"].forEach(key => {
    const pane = document.getElementById(`ai-${key}-subtab`);
    if (pane) pane.style.display = key === name ? "block" : "none";
    const btn = document.getElementById(`ai-${key}-subtab-btn`);
    if (btn) btn.classList.toggle("active", key === name);
  });
  sizeScrollAreas();
}

async function loadAiTests(deviceId) {
  if (!deviceId) return;
  const ul = document.getElementById("ai-tests-list");
  const root = await getAppRoot(deviceId, "vcat_ai");
  if (!root) {
    ul.innerHTML = "<li style='color:#aaa;'>No vcat-ai data found on device</li>";
    return;
  }
  const path = `${root}/tests/*`;
  try {
    const res = await fetch(
      `/api/device/files?session=${session_token}&device=${deviceId}&path=${encodeURIComponent(path)}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const files = await res.json();
    ul.innerHTML = "";
    files.forEach(name => {
      const li = document.createElement("li");
      li.textContent = name.split("/").pop();
      ul.appendChild(li);
    });
  } catch (err) {
    console.error("Failed to load vcat-ai tests:", err);
    ul.innerHTML = "<li style='color: red;'>Failed to load tests</li>";
  }
}

async function loadAiTestResults(deviceId) {
  if (!deviceId) return;
  const body = document.getElementById("ai-test-results-body");
  const root = await getAppRoot(deviceId, "vcat_ai");
  if (!root) {
    body.innerHTML =
      "<tr><td colspan='3' style='color:#aaa;'>No vcat-ai data found on device</td></tr>";
    return;
  }
  const path = `${root}/test_results/*.csv`;
  try {
    const res = await fetch(
      `/api/device/test_results_files?session=${session_token}&device=${deviceId}&path=${encodeURIComponent(path)}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderTestResultRows(body, await res.json(), openAiLogFile);
  } catch (err) {
    console.error("Failed to load vcat-ai test results:", err);
    body.innerHTML =
      "<tr><td colspan='3' style='color: red;'>Failed to load test results</td></tr>";
  }
}

// --- vcat-ai telemetry tabs (Device + opened log-file chart views) ---

function showAiTab(tabId) {
  document.querySelectorAll("#ai-tab-content .ai-tab-pane")
    .forEach(p => (p.style.display = "none"));
  const pane = document.getElementById(`${tabId}-tab`);
  if (pane) pane.style.display = "block";

  document.querySelectorAll("#ai-tab-header .ai-tab-btn")
    .forEach(b => b.classList.remove("active"));
  const btn = document.getElementById(`${tabId}-tab-btn`);
  if (btn) btn.classList.add("active");

  sizeScrollAreas();
}

// Clone the telemetry chart template minus the frame-drop chart (vcat-ai has none).
function setupAiTelemetryCanvas(tabId) {
  const template = document.getElementById("telemetry-tab-template");
  const clone = document.importNode(template.content, true);

  const fd = clone.querySelector('canvas[data-id="frameDropChart"]');
  if (fd && fd.closest(".chart-wrapper")) fd.closest(".chart-wrapper").remove();

  // Add the vcat-ai-only "AI Processing Time" + "Temperature" charts.
  const grid = clone.querySelector(".dashboard-grid");
  if (grid) {
    grid.appendChild(makeChartWrapper("aiProcChart", "AI Processing Time (ms)"));
    grid.appendChild(makeChartWrapper("tempChart", "Temperature"));
  }

  // vcat-ai test details are a rich nested structure, not vcat-d's fixed fields —
  // replace them with a scrollable container, and drop the (live-only) player controls.
  const detailsTop = clone.querySelector(".test-details-top");
  if (detailsTop) {
    detailsTop.innerHTML = "";
    const h3 = document.createElement("h3");
    h3.textContent = "Test Details";
    const box = document.createElement("div");
    box.className = "ai-test-details";
    box.id = `${tabId}-ai-test-details`;
    detailsTop.append(h3, box);
  }
  const pc = clone.querySelector(".player-controls");
  if (pc) pc.remove();

  clone.querySelectorAll("canvas[data-id]").forEach(canvas => {
    canvas.id = `${tabId}-${canvas.getAttribute("data-id")}`;
  });

  document.getElementById(`${tabId}-tab`).appendChild(clone);
}

// Recursively render a nested test-details object into readable rows.
function buildAiTestNode(key, value) {
  const row = document.createElement("div");
  row.className = "ai-test-row";
  const strong = document.createElement("strong");

  if (value !== null && typeof value === "object") {
    strong.textContent = `${key}:`;
    row.appendChild(strong);
    const children = document.createElement("div");
    children.className = "ai-test-children";
    Object.entries(value).forEach(([k, v]) => children.appendChild(buildAiTestNode(k, v)));
    row.appendChild(children);
  } else {
    strong.textContent = `${key}: `;
    row.append(strong, document.createTextNode(String(value)));
  }
  return row;
}

function renderAiTestDetails(container, testObj) {
  if (!container) return;
  container.innerHTML = "";
  if (!testObj || typeof testObj !== "object" || !Object.keys(testObj).length) {
    container.textContent = "No test details.";
    return;
  }
  Object.entries(testObj).forEach(([k, v]) => container.appendChild(buildAiTestNode(k, v)));
}

// Build a chart-wrapper containing a canvas with the given data-id (prefixed
// per-tab later by the caller's data-id loop).
function makeChartWrapper(dataId, title) {
  const wrapper = document.createElement("div");
  wrapper.className = "chart-wrapper";
  const h3 = document.createElement("h3");
  h3.textContent = title;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("data-id", dataId);
  wrapper.append(h3, canvas);
  return wrapper;
}

// Add a Temperature chart canvas to an already-rendered tab pane (vcat-d file view).
function injectTempChart(tabId) {
  const pane = document.getElementById(`${tabId}-tab`);
  if (!pane || document.getElementById(`${tabId}-tempChart`)) return;
  const grid = pane.querySelector(".dashboard-grid");
  if (!grid) return;
  const wrapper = makeChartWrapper("tempChart", "Temperature");
  wrapper.querySelector("canvas").id = `${tabId}-tempChart`;
  wrapper.querySelector("canvas").removeAttribute("data-id");
  grid.appendChild(wrapper);
}

// Temperature chart: battery temp (°C) + system thermal status (0-5), where the
// system status is normalized so 0 -> 0 and 5 -> top of the graph.
function updateTempChart(telemetry, tabId) {
  const batt = telemetry.battery_temp || [];
  const sys = telemetry.system_thermal || [];
  if (!batt.length && !sys.length) return;

  const labels = (batt.length ? batt : sys).map(p => p.elapsed_time);
  const battData = batt.map(p => p.temp);

  const battMax = battData.length ? Math.max(...battData) : 0;
  const yMax = battMax > 0 ? Math.ceil(battMax) : 5; // system 5 hits the top
  const sysData = sys.map(p => (p.status / 5) * yMax);

  const canvasId = `${tabId}-tempChart`;
  const canvas = document.getElementById(canvasId);
  if (!canvas) {
    console.warn(`⚠️ Temp chart canvas not found: ${canvasId}`);
    return;
  }

  const datasets = [];
  if (battData.length) {
    datasets.push({
      label: "Battery Temp (°C)", data: battData,
      borderColor: COLORS[0], backgroundColor: COLORS[0],
      borderWidth: 2, tension: 0.1, pointRadius: 0,
    });
  }
  if (sysData.length) {
    datasets.push({
      label: "System Thermal (0–5, norm)", data: sysData,
      borderColor: COLORS[1], backgroundColor: COLORS[1],
      borderWidth: 2, tension: 0.1, pointRadius: 0,
    });
  }

  const latestTime = labels.at(-1) || 0;
  const stepSize = computeStepSize(latestTime);

  chartsByTabId[tabId] ||= {};
  let ref = chartsByTabId[tabId].tempChart;
  if (!ref) {
    const opts = chartOptions("Temperature (°C)", latestTime, stepSize);
    opts.scales.y = { ...opts.scales.y, beginAtZero: true, min: 0, max: yMax };
    ref = new Chart(canvas.getContext("2d"), {
      type: "line", data: { labels, datasets }, options: opts,
    });
  } else {
    ref.data.labels = labels;
    ref.data.datasets = datasets;
    ref.options.scales.x.max = latestTime + 60;
    ref.options.scales.x.ticks.stepSize = stepSize;
    ref.options.scales.y.max = yMax;
    ref.update();
  }
  chartsByTabId[tabId].tempChart = ref;
}

// AI Processing Time chart: frame-proc / inference / inference-cpu, ns -> ms.
function updateAiProcChart(telemetry, tabId) {
  const series = [
    { key: "frameProcTime", label: "Frame Proc" },
    { key: "infTimeNs", label: "Inference" },
    { key: "infCpuTimeNs", label: "Inference CPU" },
  ];

  const base = telemetry[series[0].key] || [];
  if (!base.length) return;

  const labels = base.map(p => p.elapsed_time);
  const stepSize = computeStepSize(labels.at(-1) || 0);

  const datasets = series.map((s, i) => ({
    label: s.label,
    data: (telemetry[s.key] || []).map(p => p.value_ns / 1e6),
    borderColor: COLORS[i % COLORS.length],
    backgroundColor: COLORS[i % COLORS.length],
    borderWidth: 2,
    tension: 0.1,
    pointRadius: 0,
  }));

  const canvasId = `${tabId}-aiProcChart`;
  if (!document.getElementById(canvasId)) {
    console.warn(`⚠️ AI proc chart canvas not found: ${canvasId}`);
    return;
  }

  chartsByTabId[tabId] ||= {};
  chartsByTabId[tabId].aiProcChart = updateChart(
    chartsByTabId[tabId].aiProcChart,
    canvasId,
    datasets,
    labels,
    "AI Processing Time (ms)",
    labels.at(-1),
    stepSize
  );
}

// Open a vcat-ai log file into its own chart tab (CPU / Freq / Memory / Battery).
function openAiLogFile(filePath, saved = false) {
  const deviceId = document.getElementById("device")?.value;
  const fileName = filePath.split("/").pop();
  const tabId = "ai-" + fileName.replace(/[^a-zA-Z0-9_-]/g, "-");

  if (!document.getElementById(`${tabId}-tab-btn`)) {
    const header = document.getElementById("ai-tab-header");
    const btn = document.createElement("button");
    btn.id = `${tabId}-tab-btn`;
    btn.className = "ai-tab-btn";
    btn.onclick = () => showAiTab(tabId);

    const label = document.createElement("span");
    label.textContent = fileName;
    btn.appendChild(label);

    const close = document.createElement("span");
    close.textContent = " ✖";
    close.style.marginLeft = "8px";
    close.style.cursor = "pointer";
    close.style.color = "#ccc";
    close.onclick = (e) => { e.stopPropagation(); closeAiTab(tabId); };
    btn.appendChild(close);
    header.appendChild(btn);

    const pane = document.createElement("div");
    pane.id = `${tabId}-tab`;
    pane.className = "ai-tab-pane";
    pane.style.display = "none";
    document.getElementById("ai-tab-content").appendChild(pane);
    setupAiTelemetryCanvas(tabId);
  }

  showAiTab(tabId);

  const url = saved
    ? `/api/vcat_monitor/load_saved?session=${session_token}&name=${encodeURIComponent(filePath)}`
    : `/api/vcat_monitor/telemetry_from_file?session=${session_token}&device=${deviceId}&app=vcat_ai&telemetry_file_path=${encodeURIComponent(filePath)}`;
  fetch(url)
    .then(res => res.json())
    .then(data => {
      const telemetry = data.telemetry_data;
      renderAiTestDetails(document.getElementById(`${tabId}-ai-test-details`), data.ai_test);
      updateCpuChart(telemetry, tabId);
      updateBatteryChart(telemetry, tabId);
      updateFreqChart(telemetry, tabId);
      updateMemoryChart(telemetry, tabId);
      updateAiProcChart(telemetry, tabId);
      updateTempChart(telemetry, tabId);
    })
    .catch(err => console.error("Failed to load vcat-ai telemetry:", err));
}

function closeAiTab(tabId) {
  document.getElementById(`${tabId}-tab-btn`)?.remove();
  document.getElementById(`${tabId}-tab`)?.remove();
  if (chartsByTabId[tabId]) delete chartsByTabId[tabId];
  showAiTab("ai-device");
}

// ARM CPU part id (decimal) -> core name; mirrors the server-side CPU_PART_MAP.
const AI_CPU_PART_MAP = {
  0xd03: "Cortex-A53", 0xd04: "Cortex-A35", 0xd05: "Cortex-A55",
  0xd07: "Cortex-A57", 0xd08: "Cortex-A72", 0xd09: "Cortex-A73",
  0xd0a: "Cortex-A75", 0xd0b: "Cortex-A76", 0xd0c: "Neoverse-N1",
  0xd40: "Cortex-A78", 0xd41: "Cortex-A78AE", 0xd44: "Cortex-X1",
  0xd47: "Cortex-A710", 0xd48: "Cortex-X2", 0xd49: "Cortex-A510",
  0xd4a: "Cortex-A715", 0xd4b: "Cortex-X3", 0xd4c: "Cortex-A520",
  0xd4d: "Cortex-A720", 0xd4e: "Cortex-X4",
};

function fmtGB(bytes) {
  return typeof bytes === "number" ? (bytes / 1e9).toFixed(1) + " GB" : "—";
}

// Populate the vcat-ai "Device Details" from the app's /api/device_info
// (resolved via the vcat_ai broadcast + HTTP proxy on the server).
async function loadAiDeviceInfo(deviceId) {
  if (!deviceId) return;
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  try {
    const res = await fetch(
      `/api/device/ai_device_info?session=${session_token}&device=${deviceId}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();

    set("ai-device-ip", formatIpAddr(info.ip_addr));

    const dr = info.displayResolution || {};
    set("ai-device-display", dr.width && dr.height ? `${dr.width}×${dr.height}` : "—");

    set("ai-device-soc", [info.socManufacturer, info.soc].filter(Boolean).join(" ") || "—");

    const cpu = info.cpu || {};
    const groups = {};
    (cpu.cores || []).forEach(c => {
      const name = AI_CPU_PART_MAP[c.cpu_part] || `Unknown(0x${(c.cpu_part || 0).toString(16)})`;
      const label = `${(c.maxMHz / 1000).toFixed(1)} GHz ${name}`;
      groups[label] = (groups[label] || 0) + 1;
    });
    const coreLines = Object.entries(groups).map(([l, n]) => `${n}×${l}`).join(", ");
    set("ai-device-cpu", `${cpu.armArchitecture || "CPU"}: ${coreLines}`);

    const st = info.storageInfo || {};
    set("ai-device-storage", `${fmtGB(st.total)} / ${fmtGB(st.available)}`);

    const mem = info.memoryInfo || {};
    set("ai-device-memory", `${fmtGB(mem.total)} / ${fmtGB(mem.available)}`);

    // AI-specific fields — only vcat-ai reports these.
    const nnapi = info.nnapiInfo || {};
    set("ai-nnapi-level", nnapi.runtimeFeatureLevel ?? info.nnapiFeatureLevel ?? "—");
    const devices = (nnapi.devices || []).map(d => `${d.name} (${d.deviceType})`);
    set("ai-nnapi-devices", devices.length ? devices.join(", ") : "—");

    const qnn = info.qnnInfo;
    if (qnn) {
      set(
        "ai-qnn",
        `API ${qnn.apiVersion}, lib ${qnn.libraryLoaded ? "loaded" : "not loaded"}, ` +
          `HTP fp16 ${qnn.htpFp16Available ? "yes" : "no"}, ` +
          `HTP quant ${qnn.htpQuantizedAvailable ? "yes" : "no"}`
      );
    } else {
      set("ai-qnn", "—");
    }
  } catch (err) {
    console.error("Failed to load vcat-ai device info:", err);
    set("ai-device-ip", "Unavailable");
  }
}

// Size each visible list-scroll area so its bottom sits ~15px above the
// viewport bottom; only the list scrolls internally (the page does not).
function sizeScrollAreas() {
  document.querySelectorAll(".list-scroll").forEach(el => {
    if (el.offsetParent === null) return; // hidden — skip
    const top = el.getBoundingClientRect().top;
    const h = window.innerHeight - top - 15;
    el.style.height = `${Math.max(h, 80)}px`;
  });
}

window.addEventListener("resize", sizeScrollAreas);

// ---- Telemetry view modes: Grid <-> Focus, per telemetry tab ----
// Grid: all charts equal (current). Focus: one large "stage" chart + the rest
// as a scrollable filmstrip on the left. State is kept per tab.
const viewStateByTabId = {};

function paneOf(tabId) {
  return document.getElementById(`${tabId}-tab`);
}

function tabIdFromNode(node) {
  const pane = node.closest(".tab-pane, .ai-tab-pane");
  return pane ? pane.id.replace(/-tab$/, "") : null;
}

function wrapperTitle(w) {
  const h = w.querySelector("h3");
  return h ? h.textContent.trim() : "";
}

function resizeTabCharts(tabId) {
  const charts = chartsByTabId[tabId];
  if (!charts) return;
  requestAnimationFrame(() => {
    Object.values(charts).forEach(c => {
      if (c && typeof c.resize === "function") c.resize();
    });
  });
}

function sizeFocusAreas(tabId) {
  const st = viewStateByTabId[tabId];
  if (!st || st.mode !== "focus") return;
  const pane = paneOf(tabId);
  const focus = pane && pane.querySelector(".tele-focus");
  if (!focus || focus.offsetParent === null) return;
  const top = focus.getBoundingClientRect().top;
  focus.style.height = `${Math.max(300, window.innerHeight - top - 15)}px`;
}

function setViewModeFromBtn(btn, mode) {
  const tabId = tabIdFromNode(btn);
  if (tabId) setViewMode(tabId, mode);
}

function setViewMode(tabId, mode) {
  const pane = paneOf(tabId);
  if (!pane) return;
  const grid = pane.querySelector(".dashboard-grid");
  const focus = pane.querySelector(".tele-focus");
  if (!grid || !focus) return;

  const st = (viewStateByTabId[tabId] ||= { mode: "grid", focusedTitle: null, wrappers: null });
  // Capture canonical wrapper order once (all charts exist by first toggle).
  if (!st.wrappers) st.wrappers = [...grid.querySelectorAll(":scope > .chart-wrapper")];

  pane.querySelectorAll(".mode-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.mode === mode));

  if (mode === "focus") {
    st.mode = "focus";
    layoutFocus(tabId);
    grid.style.display = "none";
    focus.style.display = "flex";
    sizeFocusAreas(tabId);
    resizeTabCharts(tabId);
  } else {
    st.mode = "grid";
    st.wrappers.forEach(w => {
      w.classList.remove("thumb");
      w.onclick = null;
      grid.appendChild(w); // back to canonical order
    });
    focus.style.display = "none";
    grid.style.display = "grid";
    resizeTabCharts(tabId);
  }
}

// Place the focused wrapper in the stage; the rest (canonical order) in the filmstrip.
function layoutFocus(tabId) {
  const st = viewStateByTabId[tabId];
  const pane = paneOf(tabId);
  if (!st || !pane) return;
  const filmstrip = pane.querySelector(".tele-filmstrip");
  const stage = pane.querySelector(".tele-stage");

  let focused = st.focusedTitle && st.wrappers.find(w => wrapperTitle(w) === st.focusedTitle);
  if (!focused) focused = st.wrappers.find(w => wrapperTitle(w).startsWith("CPU Usage"));
  if (!focused) focused = st.wrappers[0];
  st.focusedTitle = wrapperTitle(focused);

  filmstrip.innerHTML = "";
  stage.innerHTML = "";
  st.wrappers.forEach(w => {
    if (w === focused) {
      w.classList.remove("thumb");
      w.onclick = null;
      stage.appendChild(w);
    } else {
      w.classList.add("thumb");
      w.onclick = () => {
        st.focusedTitle = wrapperTitle(w);
        layoutFocus(tabId);
        sizeFocusAreas(tabId);
        resizeTabCharts(tabId);
      };
      filmstrip.appendChild(w);
    }
  });
}

function cycleFocus(tabId, dir) {
  const st = viewStateByTabId[tabId];
  if (!st || st.mode !== "focus" || !st.wrappers || !st.wrappers.length) return;
  const titles = st.wrappers.map(wrapperTitle);
  let idx = titles.indexOf(st.focusedTitle);
  if (idx < 0) idx = 0;
  idx = (idx + dir + titles.length) % titles.length;
  st.focusedTitle = titles[idx];
  layoutFocus(tabId);
  sizeFocusAreas(tabId);
  resizeTabCharts(tabId);
}

function currentVisibleFocusTab() {
  for (const [tabId, st] of Object.entries(viewStateByTabId)) {
    if (st.mode === "focus") {
      const pane = paneOf(tabId);
      if (pane && pane.offsetParent !== null) return tabId;
    }
  }
  return null;
}

// Keyboard: Up/Down cycles the focused chart in the visible focus-mode tab.
document.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  const tabId = currentVisibleFocusTab();
  if (!tabId) return;
  e.preventDefault();
  cycleFocus(tabId, e.key === "ArrowDown" ? 1 : -1);
});

window.addEventListener("resize", () => {
  const tabId = currentVisibleFocusTab();
  if (tabId) { sizeFocusAreas(tabId); resizeTabCharts(tabId); }
});

// Toggle the Playlists / Test Results sub-tabs in the vcat-d Device tab.
function showDeviceSubTab(name) {
  const tabs = { playlists: "playlists-subtab", "test-results": "test-results-subtab" };
  Object.entries(tabs).forEach(([key, paneId]) => {
    const pane = document.getElementById(paneId);
    if (pane) pane.style.display = key === name ? "block" : "none";
    const btn = document.getElementById(`${key}-subtab-btn`);
    if (btn) btn.classList.toggle("active", key === name);
  });
  sizeScrollAreas();
}

function showTab(tabId) {
  const allTabs = document.querySelectorAll(".tab-pane");
  allTabs.forEach(tab => tab.style.display = "none");

  const tab = document.getElementById(`${tabId}-tab`);
  if (tab) tab.style.display = "block";

  // Update active tab button style
  document.querySelectorAll(".tab-button").forEach(btn => btn.classList.remove("active-tab"));
  const activeBtn = document.getElementById(`${tabId}-tab-btn`);
  if (activeBtn) activeBtn.classList.add("active-tab");

  sizeScrollAreas();
}


function updateDeviceTabLabel(deviceName) {
  const btn = document.getElementById("device-tab-btn");
  if (btn) btn.textContent = deviceName || "Device";
}

function populateDeviceInfo(info) {
  if (!info) {
    document.getElementById("device-ip").textContent = "Unavailable";
    return;
  }

  document.getElementById("device-ip").textContent = formatIpAddr(info.ip_addr);

  document.getElementById("device-display").textContent =
    `${info.display_resolution.width}×${info.display_resolution.height}`;

  document.getElementById("device-soc").textContent =
    `${info.soc_manufacturer} ${info.soc}`;

  document.getElementById("device-storage").textContent =
    `${info.storage.total} / ${info.storage.available}`;

  document.getElementById("device-memory").textContent =
    `${info.memory.total} / ${info.memory.available}`;

  const coreCounts = {};
  Object.values(info.cpu.cores).forEach(core => {
    const match = core.match(/Cortex-[A-Z0-9]+/);
    const freqMatch = core.match(/(\\d+)\\s*MHz/);
    if (match && freqMatch) {
      const label = `${(parseInt(freqMatch[1]) / 1000).toFixed(1)} GHz ${match[0]}`;
      coreCounts[label] = (coreCounts[label] || 0) + 1;
    }
  });

  const coreLines = Object.entries(coreCounts)
    .map(([label, count]) => `${count}×${label}`)
    .join(", ");

  document.getElementById("device-cpu").textContent = `ARMv8: ${coreLines}`;

  loadPlaylistFiles(info.device_id);
  loadTestResults(info.device_id)
  updateConsoleLog();

}

function populateDeviceDropdown() {
  console.log("➡️ Calling populateDeviceDropdown");

  // Elements needed for visual fallback
  const deviceSelect = document.getElementById("device");
  const noDeviceOverlay = document.getElementById("no-device-overlay");
  const tabContent = document.getElementById("tab-content");
  const tabHeader = document.getElementById("tab-header");

  // Get session token first
  fetch(`${API_BASE}/api/session_token`)
    .then(res => res.json())
    .then(data => {
      session_token = data.session_token;
      console.log("✅ Session Token:", session_token);

      return fetch(`${API_BASE}/api/all_connected_devices?session=${session_token}`);
    })
    .then(res => res.json())
    .then(devices => {
      console.log("📦 Device list:", devices);
      deviceSelect.innerHTML = "";

      // Remove any default placeholder option
      const firstOption = deviceSelect.options[0];
      if (firstOption && firstOption.disabled) {
        deviceSelect.remove(0);
      }

      // Populate dropdown if devices are present
      if (devices.length > 0) {
        noDeviceOverlay.style.display = "none";
        tabContent.style.display = "block";
        tabHeader.style.display = "flex";

        devices.forEach(deviceId => {
          const opt = document.createElement("option");
          opt.value = deviceId;
          opt.textContent = deviceId;
          deviceSelect.appendChild(opt);
        });

        // Bind handler once
        deviceSelect.addEventListener("change", handleDeviceSelection);

        // Auto-select first device
        deviceSelect.value = devices[0];
        handleDeviceSelection();

        setTimeout(updateConsoleLog, 500);
      } else {
        console.warn("🚫 No connected devices found.");
        noDeviceOverlay.style.display = "block";
        tabContent.style.display = "none";
        tabHeader.style.display = "none";
      }
    })
    .catch(err => {
      console.error("❌ Failed during device/session load:", err);
      noDeviceOverlay.style.display = "block";
      tabContent.style.display = "none";
      tabHeader.style.display = "none";
    });
}


window.addEventListener("DOMContentLoaded", populateDeviceDropdown);


// Cache of resolved on-device VCAT root folders, keyed by device id.
// The folder is user-selected (no fixed name), so we ask the app via
// /api/device/root_folder rather than assuming a path.
const deviceRootFolderCache = {};

async function getDeviceRootFolder(deviceId) {
  if (deviceRootFolderCache[deviceId]) return deviceRootFolderCache[deviceId];

  const url = `/api/device/root_folder?session=${session_token}&device=${deviceId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to resolve root folder (${res.status})`);

  const data = await res.json();
  const root = (data.root_folder || "").replace(/\/+$/, "");
  if (!root) throw new Error("Empty root folder");

  deviceRootFolderCache[deviceId] = root;
  return root;
}

async function loadPlaylistFiles() {
  const deviceSelect = document.getElementById("device");
  const selectedDeviceId = deviceSelect?.value;
  if (!selectedDeviceId) return;

  const ul = document.getElementById("playlist-list");
  const root = await getAppRoot(selectedDeviceId, "vcat_d");
  if (!root) {
    ul.innerHTML = "<li style='color:#aaa;'>No vcat-d data found on device</li>";
    return;
  }

    const path = `${root}/playlist/*.xspf`;
    const url = `/api/device/files?session=${session_token}&device=${selectedDeviceId}&path=${encodeURIComponent(path)}`;

  fetch(url)
    .then(res => {
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }
      return res.json();
    })
    .then(files => {
      const ul = document.getElementById("playlist-list");
      ul.innerHTML = "";

      files.forEach(name => {
        const li = document.createElement("li");
        li.textContent = name.split("/").pop();
        ul.appendChild(li);
      });
    })
    .catch(err => {
      console.error("Failed to load playlists:", err);
      const ul = document.getElementById("playlist-list");
      ul.innerHTML = "<li style='color: red;'>Failed to load playlists</li>";
    });
}

async function loadTestResults() {
  const deviceSelect = document.getElementById("device");
  const selectedDeviceId = deviceSelect?.value;
  if (!selectedDeviceId) return;

  const body = document.getElementById("test-results-body");
  const root = await getAppRoot(selectedDeviceId, "vcat_d");
  if (!root) {
    if (body) {
      body.innerHTML =
        "<tr><td colspan='3' style='color:#aaa;'>No vcat-d data found on device</td></tr>";
    }
    return;
  }

  const path = `${root}/test_results/*.csv`;
  const url = `/api/device/test_results_files?session=${session_token}&device=${selectedDeviceId}&path=${encodeURIComponent(path)}`;

  fetch(url)
    .then(res => res.json())
    .then(files => {
      renderTestResultRows(document.getElementById("test-results-body"), files);
    })
    .catch(err => {
      console.error("Failed to load test results:", err);
      const body = document.getElementById("test-results-body");
      if (body) {
        body.innerHTML =
          "<tr><td colspan='3' style='color: red;'>Failed to load test results</td></tr>";
      }
    });
}

function fmtFileSize(b) {
  if (typeof b !== "number") return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// Render Test Results rows (Name / Date / Size) into a <tbody>, shared by
// vcat-d and vcat-ai. Row click opens the Open/Download context menu.
function renderTestResultRows(body, files, opener) {
  if (!body) return;
  body.innerHTML = "";
  files.forEach(file => {
    const tr = document.createElement("tr");
    tr.dataset.path = file.path;

    const nameTd = document.createElement("td");
    nameTd.textContent = file.filename;
    const dateTd = document.createElement("td");
    dateTd.textContent = file.date || "";
    const sizeTd = document.createElement("td");
    sizeTd.className = "size-col";
    sizeTd.textContent = fmtFileSize(file.size);

    tr.append(nameTd, dateTd, sizeTd);
    tr.onclick = (event) => openTestResultMenu(event, file.path, opener);
    body.appendChild(tr);
  });
}

// Context menu (Open / Download as CSV|Excel) for a test-result row.
// `opener(filePath)` handles "Open" (vcat-d live-file view or vcat-ai chart tab).
function openTestResultMenu(event, filePath, opener) {
  const existingMenu = document.getElementById("context-menu");
  if (existingMenu) existingMenu.remove();

  const menu = document.createElement("div");
  menu.id = "context-menu";
  menu.style.position = "fixed";
  menu.style.background = "#fff";
  menu.style.border = "1px solid #ccc";
  menu.style.boxShadow = "0 2px 6px rgba(0,0,0,0.15)";
  menu.style.padding = "5px 0";
  menu.style.minWidth = "150px";
  menu.style.zIndex = 9999;
  menu.style.top = `${event.clientY}px`;
  menu.style.left = `${event.clientX}px`;

  const createMenuItem = (label, onClick) => {
    const item = document.createElement("div");
    item.textContent = label;
    item.style.padding = "6px 12px";
    item.style.cursor = "pointer";
    item.style.color = "#000";
    item.style.background = "#fff";
    item.onmouseenter = () => item.style.background = "#eee";
    item.onmouseleave = () => item.style.background = "#fff";
    item.onclick = () => {
      onClick();
      menu.remove();
    };
    return item;
  };

  // Open
  menu.appendChild(createMenuItem("Open", () => {
    (opener || handleConnectClick)(filePath);
  }));

  // Download as submenu container
  const downloadAs = document.createElement("div");
  downloadAs.textContent = "Download as ▸";
  downloadAs.style.position = "relative";
  downloadAs.style.padding = "6px 12px";
  downloadAs.style.cursor = "pointer";
  downloadAs.style.color = "#000";
  downloadAs.style.background = "#fff";
  downloadAs.onmouseenter = () => submenu.style.display = "block";
  downloadAs.onmouseleave = () => submenu.style.display = "none";

  // Submenu
  const submenu = document.createElement("div");
  submenu.style.display = "none";
  submenu.style.position = "absolute";
  submenu.style.left = "100%";
  submenu.style.top = "0";
  submenu.style.background = "#fff";
  submenu.style.border = "1px solid #ccc";
  submenu.style.boxShadow = "0 2px 6px rgba(0,0,0,0.15)";
  submenu.style.minWidth = "100px";

  submenu.appendChild(createMenuItem("CSV", () => {
    downloadLogFile(filePath, "text/csv");
  }));

  submenu.appendChild(createMenuItem("Excel", () => {
    downloadLogFile(filePath, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }));

  downloadAs.appendChild(submenu);
  menu.appendChild(downloadAs);

  document.body.appendChild(menu);

  // Cleanup
  const removeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("click", removeMenu);
    }
  };
  setTimeout(() => document.addEventListener("click", removeMenu), 0);
}

async function pickExportPath() {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: "telemetry_export.xlsx",
      types: [{
        description: 'Excel Files',
        accept: {
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx']
        }
      }]
    });
    return handle.name || (await handle.getFile()).name; // You can adjust this as needed
  } catch (err) {
    console.warn("User canceled file picker:", err);
    return null;
  }
}

async function downloadLogFile(telemetryFilePath, mimetype) {
  const deviceSelect = document.getElementById("device");
  const selectedDeviceId = deviceSelect?.value;

  const params = new URLSearchParams({
    session: session_token,
    device: selectedDeviceId,
    telemetry_file_path: telemetryFilePath,
    mimetype: mimetype
  });

  try {
    const res = await fetch(`/api/vcat_monitor/download_telemetry_file?${params.toString()}`, {
      method: 'GET'
    });

    if (!res.ok) {
      alert("Export failed.");
      return;
    }

    const blob = await res.blob();

    // Use telemetryFilePath basename + extension based on MIME
    const baseName = telemetryFilePath?.split('/').pop()?.split('.').shift() || "telemetry_export";
    const ext = mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ? ".xlsx"
        : ".csv";
    const filename = baseName + ext;

    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);

    alert("Export successful!");
  } catch (err) {
    console.error("Download error:", err);
    alert("Export failed.");
  }
}
