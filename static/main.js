// Same origin as the page — the server may be started on any --host/--port
// (a hardcoded localhost:5050 broke every request under a custom port).
const API_BASE = window.location.origin;
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

// Save Snapshot is enabled only while a live session (vcat-d or vcat-ai) is active.
function updateSnapshotButtons() {
  const live = !!(aiLivePoll || window.telemetryInterval);
  setBtnEnabled(document.getElementById("save-snapshot-btn"), live);
  refreshConnectAvailability();
}

// One app at a time: while one app's session is live, the OTHER app's Connect
// button is disabled so the user must explicitly Disconnect before switching.
// (When an app is live, its own button is the Disconnect toggle and stays on.)
function refreshConnectAvailability() {
  const dLive = !!window.telemetryInterval;
  const aiLive = !!aiLivePoll;
  const dBtn = document.getElementById("connect-btn");
  const aiBtn = document.getElementById("ai-connect-btn");
  if (dBtn) {
    setBtnEnabled(dBtn, !aiLive);
    if (aiLive) dBtn.title = "Disconnect the vcat-ai session first";
  }
  if (aiBtn) {
    setBtnEnabled(aiBtn, !dLive);
    if (dLive) aiBtn.title = "Disconnect the vcat-d session first";
  }
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
// At startup: if a previous run left behind live-session temp files (crash /
// hard shutdown before a snapshot was taken), offer to recover them to Downloads.
async function checkOrphanSessions() {
  let orphans = [];
  try {
    const res = await fetch(`/api/vcat_monitor/orphan_sessions?session=${session_token}`);
    orphans = (await res.json()).orphans || [];
  } catch (e) { return; }
  if (!orphans.length) return;

  const list = orphans.map(o => `  • ${o.device_id} (${fmtFileSize(o.size)})`).join("\n");
  const recover = confirm(
    `Found ${orphans.length} unsaved session${orphans.length > 1 ? "s" : ""} ` +
    `from a previous run (the server may have exited unexpectedly):\n\n${list}\n\n` +
    `Save ${orphans.length > 1 ? "them" : "it"} to your Downloads folder?`
  );
  for (const o of orphans) {
    try {
      const q = recover ? "" : "&discard=1";
      const res = await fetch(
        `/api/vcat_monitor/recover_orphan?session=${session_token}&file=${encodeURIComponent(o.name)}${q}`,
        { method: "POST" }
      );
      const data = await res.json();
      if (recover && data.status === "recovered") console.log("Recovered session:", data.name);
    } catch (e) { console.error("orphan recover failed:", e); }
  }
  if (recover) alert(`Recovered ${orphans.length} session${orphans.length > 1 ? "s" : ""} to Downloads.`);
}

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
      return true;
    }
    alert(`Save failed: ${data.message || "error"}`);
    return false;
  } catch (err) {
    console.error("Save session failed:", err);
    alert("Save failed.");
    return false;
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
    if (data.status === "ok") loadSavedSession(data.name, data.app);
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

// Tabs opened from a file — a local/saved session or a log pulled off a device.
// Non-empty means the UI has content worth showing even with no device attached,
// so the "no device" overlay stays off and the tabs survive a disconnect.
const openedFileTabs = new Set();

// A file that can't be parsed (wrong CSV, truncated log) used to fail silently and
// leave an empty tab behind. Tell the user and clean the tab up.
function reportFileLoadFailure(tabId, message, fileName) {
  console.error("Failed to load telemetry from file:", fileName, message);
  document.getElementById(`${tabId}-tab-btn`)?.remove();
  document.getElementById(`${tabId}-tab`)?.remove();
  delete chartsByTabId[tabId];
  delete fileTabPayloads[tabId];
  openedFileTabs.delete(tabId);
  if (!document.getElementById("device")?.options.length) showNoDeviceUI(true);
  alert(`Could not open ${fileName || "this file"}:\n\n${message}`);
}

// Load a saved session (host CSV) — no connected device required. The app is
// detected server-side from the file's contents (the filename is only a
// fallback), so a log can be named anything and still open in the right viewer.
function loadSavedSession(name, app) {
  if (!name) return;
  app = app || (name.includes("vcatai") ? "vcat_ai" : "vcat_d");

  ensureAppTab(app);
  showAppTab(app);
  showNoDeviceUI(false);

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

// The device dropped mid-session (e.g. thermal shutdown / unplug). Stop the
// live poll, offer to save a snapshot (server copies the temp file — no device
// needed), then tear down the session UI.
let _disconnectHandled = false;
async function onDeviceDisconnected(app, deviceId) {
  if (_disconnectHandled) return;
  _disconnectHandled = true;
  // Halt both poll loops immediately so nothing re-fires during the dialog.
  if (aiLivePoll) { clearInterval(aiLivePoll); aiLivePoll = null; }
  if (window.telemetryInterval) { clearInterval(window.telemetryInterval); window.telemetryInterval = null; }
  try {
    const save = confirm(
      "The device disconnected (it may have shut down or been unplugged).\n\n" +
      "Save a snapshot of this session before closing it?"
    );
    if (save && deviceId) {
      try {
        const res = await fetch(
          `/api/vcat_monitor/save_session?session=${session_token}&device=${deviceId}`,
          { method: "POST" }
        );
        const data = await res.json();
        alert(data.status === "saved"
          ? `Snapshot saved: ${data.name}`
          : `Save failed: ${data.message || "unknown error"}`);
      } catch (e) {
        console.error("disconnect snapshot save failed:", e);
        alert("Snapshot save failed.");
      }
    }
    // Tell the server to drop the session (removes temp file, clears state).
    if (deviceId) {
      fetch(`/api/vcat_monitor/stop?session=${session_token}&device=${deviceId}`,
            { method: "POST" }).catch(() => {});
    }
    if (app === "vcat_ai") stopAiLive(); else stopVcatdLive();
  } finally {
    _disconnectHandled = false;
  }
}

function setAiConnectState(connected) {
  const btn = document.getElementById("ai-connect-btn");
  if (!btn) return;
  if (connected) {
    btn.src = "/static/btn_disconnect_device.png";
    btn.title = "Disconnect";
    btn.onclick = promptAiDisconnect;
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

  // One app at a time: this button is disabled while vcat-d is live, but guard anyway.
  if (window.telemetryInterval) {
    alert("Disconnect the active vcat-d session before connecting vcat-ai.");
    return;
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
      if (sys.disconnected) { onDeviceDisconnected("vcat_ai", deviceId); return; }
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
          updateMixedCpuChart(lt, workerTel, tabId);   // total + per-core (ADB worker)
          updateProcessorChart(lt, workerTel, tabId);  // total CPU + GPU (ADB worker)
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

// The vcat-ai Disconnect button: confirm + offer snapshot, then tear down.
function promptAiDisconnect() {
  confirmTerminateSession("Disconnect vcat-ai monitoring on this device?");
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

    // ...but keep it disabled if the other app owns the live session.
    refreshConnectAvailability();

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

  // One app at a time: this button is disabled while vcat-ai is live, but guard anyway.
  if (isLive && aiLivePoll) {
    alert("Disconnect the active vcat-ai session before connecting vcat-d.");
    return;
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
    openedFileTabs.add(tabId);
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
    const tabPane = document.getElementById(`${tabId}-tab`);
    if (tabPane) tabPane.remove();

    // Remove associated charts
    if (chartsByTabId[tabId]) {
      delete chartsByTabId[tabId];
    }

    // Last opened file closed with no device attached? Restore the overlay.
    delete fileTabPayloads[tabId];
    openedFileTabs.delete(tabId);
    if (!document.getElementById("device")?.options.length) showNoDeviceUI(true);

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
          if (data.status === "error" || !data.telemetry_data) {
            return reportFileLoadFailure(tabId, data.message || "no telemetry data in file", tabLabel);
          }
          fileTabSources[tabId] = {
            app: "vcat_d", kind: saved ? "saved" : "device", path: filePath, label: tabLabel,
          };
          fileTabPayloads[tabId] = data;
          enableComparePicker(tabId);
          renderFileTelemetry(tabId, "vcat_d", data);
          updateExportButtons(tabId);
        })
        .catch(err => {
          reportFileLoadFailure(tabId, err.message || String(err), tabLabel);
        });
  }
}

// Draw a whole file-backed telemetry pane (test details + every chart) for one
// app. Shared by the single-file views and by each side of a comparison, so a
// compared pane is built from exactly the same code as a standalone one.
function renderFileTelemetry(tabId, app, data) {
  const telemetry = data.telemetry_data;
  if (app === "vcat_ai") {
    renderAiTestDetails(document.getElementById(`${tabId}-ai-test-details`), data.ai_test);
    updateCpuChart(telemetry, tabId);
    updateProcessorChart(telemetry, null, tabId);  // total CPU + GPU from the file
    updateBatteryChart(telemetry, tabId);
    updateFreqChart(telemetry, tabId);
    updateMemoryChart(telemetry, tabId);
    updateAiProcChart(telemetry, tabId);
    updateTempChart(telemetry, tabId);
  } else {
    if (data.test_details) updateTestDetailsUI({ test_details: data.test_details }, tabId);
    updateCpuChart(telemetry, tabId);
    updateBatteryChart(telemetry, tabId);
    updateFreqChart(telemetry, tabId);
    updateMemoryChart(telemetry, tabId);
    updateFrameDropChart(telemetry, tabId);
    injectTempChart(tabId);
    updateTempChart(telemetry, tabId);
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
  confirmTerminateSession("Disconnect vcat-d monitoring on this device?");
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

// Elapsed seconds as h:mm:ss.mmm. Tooltips show the raw value *and* this, because
// the raw seconds are what the CSV holds while the clock form is what you match
// against a test log or a video timestamp.
function formatElapsedClock(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return "";
  const totalMs = Math.round(Math.abs(n) * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const sec = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad = (v, w) => String(v).padStart(w, "0");
  return `${n < 0 ? "-" : ""}${h}:${pad(m, 2)}:${pad(sec, 2)}.${pad(ms, 3)}`;
}

// The x value as logged, without float noise or pointless trailing zeros.
function formatElapsedRaw(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
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


// Live CPU chart: Total + per-core, both from the ADB worker (/proc/stat, 0-100%).
// The log's cpu.usage.total is ignored (it's on a different scale). Worker samples
// (which start at connect) are shifted onto the log's timeline so they align with
// the other charts: offset = latest-log-elapsed − latest-worker-elapsed.
function updateMixedCpuChart(logTel, workerTel, tabId) {
  const canvasId = `${tabId}-cpuChart`;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const wCpu = (workerTel && workerTel.cpu_usage) || [];
  if (!wCpu.length) return;

  const logCpu = (logTel && logTel.cpu_usage) || [];
  const logMax = logCpu.length ? logCpu.at(-1).elapsed_time : wCpu.at(-1).elapsed_time;
  const offset = logMax - wCpu.at(-1).elapsed_time;

  const last = wCpu.at(-1);
  const coreKeys = Object.keys(last).filter(k => k.startsWith("cpu") && k !== "cpu")
    .sort((a, b) => (parseInt(a.slice(3)) || 0) - (parseInt(b.slice(3)) || 0));
  const keys = ["cpu", ...coreKeys].filter(k => k in last);

  const datasets = keys.map((key, i) => ({
    label: key === "cpu" ? "Total CPU (%)" : key,
    data: wCpu.map(p => ({ x: offset + p.elapsed_time, y: p[key] ?? null })),
    borderColor: COLORS[i % COLORS.length],
    backgroundColor: COLORS[i % COLORS.length],
    borderWidth: 2, tension: 0.1, pointRadius: 0,
  }));

  const stepSize = computeStepSize(logMax);

  chartsByTabId[tabId] ||= {};
  let ref = chartsByTabId[tabId].cpuChart;
  if (!ref) {
    ref = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { datasets },
      options: chartOptions("CPU Usage (%)", logMax, stepSize),
    });
  } else {
    ref.data.datasets = datasets;
    ref.options.scales.x.max = logMax + 60;
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
    if (result.disconnected) { onDeviceDisconnected("vcat_d", selectedDevice); return; }
    workerTel = result.telemetry_data || null;
    if (result.test_details) updateTestDetailsUI({ test_details: result.test_details }, tabId);
  } catch (err) {
    console.error('❌ Telemetry fetch failed:', err);
  }

  // Temperature straight from the ADB worker (dumpsys battery + thermalservice), so
  // it shows during a live session regardless of what the app is logging. The chart
  // canvas isn't in the template, so it's injected on the first poll.
  if (workerTel) {
    injectTempChart(tabId);
    updateTempChart(workerTel, tabId);
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
    
  // Axes that are a percentage of a fixed whole get a pinned 0-100 range, so the
  // shape is read against the full scale (and two runs compare directly).
  const isPercentChart = yLabel === "CPU Usage (%)" || yLabel === "Battery Level (%)";
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
        max: isPercentChart ? 100 : undefined,  // CPU % and Battery % are 0-100
      }
    },
    plugins: {
      legend: {
        position: 'bottom',
        labels: { boxWidth: 12, padding: 10 }
      },
      tooltip: {
        callbacks: {
          // e.g. "18641.241 (5:10:41.241)" instead of the bare seconds.
          title: (items) => {
            if (!items || !items.length) return "";
            const item = items[0];
            const x = (item.parsed && typeof item.parsed.x === "number")
              ? item.parsed.x
              : Number(item.label);
            if (!Number.isFinite(x)) return item.label ?? "";
            return `${formatElapsedRaw(x)} (${formatElapsedClock(x)})`;
          }
        }
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
  if (fullPath === null || fullPath === undefined) return "";
  // Coerce: a non-string (the device once started sending playlist as an object)
  // used to throw here and abort the entire file load.
  return String(fullPath).replace(/^.*[\\/]/, "");
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

// User-initiated end of a live session (Disconnect, or a device change). Two
// dialogs: confirm the disconnect, then offer a snapshot, then tear down. Ending
// a session stops the server monitor thread and discards its state — the session
// is no longer valid afterward. Returns true if terminated, false if the user
// cancelled (or the requested save failed, so nothing is lost).
async function confirmTerminateSession(promptText) {
  if (!(aiLivePoll || window.telemetryInterval)) return true; // nothing live
  if (!confirm(promptText || "Disconnect the active monitoring session?")) return false;
  const choice = await askSaveChoice();     // Save / Discard / Cancel
  if (choice === "cancel") return false;    // last chance to abort the disconnect
  if (choice === "save" && !(await saveLiveSession())) return false; // save failed → keep
  stopCurrentLiveSession();
  return true;
}

// 3-choice save prompt shown after the user confirms a disconnect. Resolves to
// "save", "discard", or "cancel" (cancel aborts the whole disconnect).
let _saveChoiceResolve = null;
function askSaveChoice() {
  return new Promise((resolve) => {
    _saveChoiceResolve = resolve;
    document.getElementById("save-choice-modal").style.display = "block";
  });
}
function resolveSaveChoice(choice) {
  document.getElementById("save-choice-modal").style.display = "none";
  const r = _saveChoiceResolve;
  _saveChoiceResolve = null;
  if (r) r(choice);
}

// Stop + tear down whichever live session is active (vcat-ai or vcat-d).
function stopCurrentLiveSession() {
  const deviceId = document.getElementById("device")?.value;
  if (aiLivePoll) {
    handleAiDisconnectClick();
  } else if (window.telemetryInterval) {
    if (deviceId) {
      fetch(`${API_BASE}/api/vcat_monitor/stop?session=${session_token}&device=${deviceId}`, { method: "POST" })
        .catch(() => {});
    }
    stopVcatdLive();
  }
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


let _lastDeviceValue = null;

async function handleDeviceSelection() {
  const deviceSelect = document.getElementById("device");
  const selectedDeviceId = deviceSelect?.value;

  // Changing the device ends any live session (a session is tied to one device).
  // Operate the confirm/save/teardown against the OLD device, then commit or revert.
  if ((aiLivePoll || window.telemetryInterval) && selectedDeviceId !== _lastDeviceValue) {
    deviceSelect.value = _lastDeviceValue;  // teardown targets the still-selected old device
    const ok = await confirmTerminateSession(
      "Changing the device will end the active monitoring session. Continue?"
    );
    if (!ok) return;                        // cancelled / save failed → stay on old device
    deviceSelect.value = selectedDeviceId;  // committed → switch to the new device
  }
  _lastDeviceValue = selectedDeviceId;

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
    grid.appendChild(makeChartWrapper("gpuChart", "Processor Usage (%)"));
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
      normMax: yMax,  // series is normalized against the y max (see alignment below)
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
// Processor Usage chart: total CPU + GPU, both from the ADB worker (GPU is
// device-dependent — Adreno/Qualcomm). Shifted onto the log's timeline like the
// mixed CPU chart so they align with the other charts.
function updateProcessorChart(logTel, workerTel, tabId) {
  const canvasId = `${tabId}-gpuChart`;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  // Live: total CPU + GPU come from the ADB worker. Loaded snapshot: no worker, so
  // read the same series straight from the file (already on the log/test timeline).
  const wSrc = workerTel || logTel;
  const wCpu = (wSrc && wSrc.cpu_usage) || [];
  const gpu = (wSrc && wSrc.gpu_usage) || [];
  if (!wCpu.length && !gpu.length) return;

  const logCpu = (logTel && logTel.cpu_usage) || [];
  const ref = wCpu.length ? wCpu : gpu;
  const logMax = logCpu.length ? logCpu.at(-1).elapsed_time : ref.at(-1).elapsed_time;

  const datasets = [];
  if (wCpu.length) {
    const offset = logMax - wCpu.at(-1).elapsed_time;
    datasets.push({
      label: "Total CPU (%)",
      data: wCpu.map(p => ({ x: offset + p.elapsed_time, y: p.cpu ?? null })),
      borderColor: COLORS[0], backgroundColor: COLORS[0],
      borderWidth: 2, tension: 0.1, pointRadius: 0,
    });
  }
  if (gpu.length) {
    const offset = logMax - gpu.at(-1).elapsed_time;
    datasets.push({
      label: "GPU (%)",
      data: gpu.map(p => ({ x: offset + p.elapsed_time, y: p.gpu ?? null })),
      borderColor: COLORS[1], backgroundColor: COLORS[1],
      borderWidth: 2, tension: 0.1, pointRadius: 0,
    });
  }

  const stepSize = computeStepSize(logMax);

  chartsByTabId[tabId] ||= {};
  let chart = chartsByTabId[tabId].gpuChart;
  if (!chart) {
    chart = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { datasets },
      options: chartOptions("Processor Usage (%)", logMax, stepSize),
    });
  } else {
    chart.data.datasets = datasets;
    chart.options.scales.x.max = logMax + 60;
    chart.options.scales.x.ticks.stepSize = stepSize;
    chart.update();
  }
  chartsByTabId[tabId].gpuChart = chart;
}

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
  openedFileTabs.add(tabId);

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
      if (data.status === "error" || !data.telemetry_data) {
        return reportFileLoadFailure(tabId, data.message || "no telemetry data in file", fileName);
      }
      fileTabSources[tabId] = {
        app: "vcat_ai", kind: saved ? "saved" : "device", path: filePath, label: fileName,
      };
      fileTabPayloads[tabId] = data;
      enableComparePicker(tabId);
      renderFileTelemetry(tabId, "vcat_ai", data);
      updateExportButtons(tabId);
    })
    .catch(err => reportFileLoadFailure(tabId, err.message || String(err), fileName));
}

function closeAiTab(tabId) {
  document.getElementById(`${tabId}-tab-btn`)?.remove();
  document.getElementById(`${tabId}-tab`)?.remove();
  if (chartsByTabId[tabId]) delete chartsByTabId[tabId];
  delete fileTabPayloads[tabId];
  openedFileTabs.delete(tabId);
  if (!document.getElementById("device")?.options.length) showNoDeviceUI(true);
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
  sizeCompareAreas();
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

// ---- Compare two results side by side ----------------------------------------
// A comparison tab lays two files' charts out in a two-column grid, paired by
// metric, so scrolling down walks through CPU vs CPU, Frequency vs Frequency and
// so on. Each side is a normal telemetry pane built under its own tabId prefix
// (`<cmp>-A` / `<cmp>-B`), so every existing update*Chart(telemetry, tabId) and
// chartsByTabId lookup works unchanged; the charts are then re-parented into the
// shared grid the same way Focus mode moves its wrappers.

// What each file-backed tab is showing, so "Compare To" knows what side A is.
const fileTabSources = {};       // tabId -> {app, kind: "saved"|"device", path, label}
const fileTabPayloads = {};      // tabId -> the loaded telemetry payload
const compareStateByTabId = {};  // compare tabId -> {sources[], sides[], data[]}

// Column tag for a run: A, B, C, ...
function sideTag(i) {
  return String.fromCharCode(65 + i);
}

// What the exporters need, for a single-file tab and an N-way comparison alike.
function exportContextFor(tabId) {
  const cmp = compareStateByTabId[tabId];
  if (cmp) {
    return {
      tabId, app: cmp.sources[0].app, sources: cmp.sources,
      sides: cmp.sides, data: cmp.data, comparison: true,
    };
  }
  const src = fileTabSources[tabId];
  const data = fileTabPayloads[tabId];
  if (!src || !data) return null;
  return {
    tabId, app: src.app, sources: [src],
    sides: [tabId], data: [data], comparison: false,
  };
}

// Toolbar buttons in the shared telemetry template resolve their own tab.
function exportFromBtn(btn, kind) {
  const tabId = tabIdFromNode(btn);
  if (!tabId) return;
  if (kind === "pdf") exportTabPdf(tabId);
  else exportTabSpreadsheet(tabId);
}

// Charts sit side by side across the page in the PDF, so past two logs each column
// is too narrow to read anything from. The spreadsheet has no such limit.
const PDF_MAX_COLUMNS = 2;

// Exports need a loaded payload, so they stay off until every column has rendered.
function updateExportButtons(tabId) {
  const pane = paneOf(tabId);
  if (!pane) return;
  const ctx = exportContextFor(tabId);
  const ready = !!ctx && !ctx.data.some(d => !d);
  const columns = ctx ? ctx.sources.length : 0;

  pane.querySelectorAll("[data-export]").forEach(btn => {
    const tooWide = btn.dataset.export === "pdf" && columns > PDF_MAX_COLUMNS;
    btn.disabled = !ready || tooWide;
    if (tooWide) {
      btn.title =
        `PDF holds at most ${PDF_MAX_COLUMNS} logs side by side — with ${columns} the ` +
        `charts are too narrow to read. Save Spreadsheet handles any number.`;
    }
  });
}

function appLabel(app) {
  return app === "vcat_ai" ? "vcat-ai" : "vcat-d";
}

// Where an app's telemetry tabs live: vcat-d and vcat-ai have separate headers.
function tabHost(app) {
  return app === "vcat_ai"
    ? { header: "ai-tab-header", content: "ai-tab-content", btnClass: "ai-tab-btn",
        paneClass: "ai-tab-pane", show: showAiTab, home: "ai-device" }
    : { header: "tab-header", content: "tab-content", btnClass: "tab-button",
        paneClass: "tab-pane", show: showTab, home: "device" };
}

// The Compare To combo is inert until a tab actually has a file behind it (the
// live tab has nothing to compare — take a snapshot first).
function enableComparePicker(tabId) {
  const sel = paneOf(tabId)?.querySelector(".compare-select");
  if (!sel) return;
  sel.disabled = false;
  sel.title = "Compare this result with another file";
}

function sourcesForTab(tabId) {
  const cmp = compareStateByTabId[tabId];
  if (cmp) return cmp.sources;
  const src = fileTabSources[tabId];
  return src ? [src] : [];
}

// Toolbar combo: pick where the other result comes from.
async function handleCompareSelect(select) {
  const choice = select.value;
  select.value = "";  // snap back to the "Compare To…" label
  if (!choice) return;

  const tabId = tabIdFromNode(select);
  const base = tabId ? sourcesForTab(tabId) : [];
  if (!base.length) {
    return alert("Open a saved or on-device log first, then choose Compare To.");
  }

  const next = choice === "device"
    ? await pickDeviceFile(base[0].app)
    : await pickLocalCompareFile();
  if (!next) return;  // cancelled

  // From a comparison this appends another column; from a single log it starts one.
  // Payloads already loaded are handed over so nothing is re-read from disk.
  const cmp = compareStateByTabId[tabId];
  const cached = cmp ? cmp.data.slice() : [fileTabPayloads[tabId] || null];
  const built = await openCompareTab([...base, next], cached);
  // Adding a column grows the same comparison, so retire the tab it grew out of
  // (only once the new one is up, in case the added log fails to load).
  if (built && cmp && built !== tabId) removeCompareTab(tabId);
}

// --- side B pickers ---

let _localComparePick = null;

function pickLocalCompareFile() {
  const input = document.getElementById("compare-file");
  if (!input) return Promise.resolve(null);
  return new Promise(resolve => {
    _localComparePick = resolve;
    input.value = "";  // allow re-picking the same file
    input.click();
  });
}

// Upload the browsed file and hand back a source descriptor (app detected server-side).
async function handleCompareFileInput(input) {
  const resolve = _localComparePick;
  _localComparePick = null;
  const file = input.files && input.files[0];
  input.value = "";
  if (!resolve) return;
  if (!file) return resolve(null);
  try {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/vcat_monitor/upload_session?session=${session_token}`, {
      method: "POST", body: fd,
    });
    const data = await res.json();
    if (data.status !== "ok") {
      alert(`Load failed: ${data.message || "error"}`);
      return resolve(null);
    }
    resolve({ app: data.app, kind: "saved", path: data.name, label: data.name });
  } catch (err) {
    console.error("Compare load failed:", err);
    alert("Load failed.");
    resolve(null);
  }
}

let _deviceComparePick = null;

// Modal list of the device's test-result CSVs for the given app.
async function pickDeviceFile(app) {
  const deviceId = document.getElementById("device")?.value;
  if (!deviceId) {
    alert("No device connected — use “Browse local file…” instead.");
    return null;
  }
  const root = await getAppRoot(deviceId, app);
  if (!root) {
    alert(`No ${appLabel(app)} data folder found on ${deviceId}.`);
    return null;
  }

  let files = [];
  try {
    const path = `${root}/test_results/*.csv`;
    const res = await fetch(
      `/api/device/test_results_files?session=${session_token}&device=${deviceId}&path=${encodeURIComponent(path)}`
    );
    if (res.ok) files = await res.json();  // backend sorts newest-first
  } catch (err) {
    console.error("Compare: device file list failed:", err);
  }
  if (!files.length) {
    alert(`No ${appLabel(app)} test-result files found on ${deviceId}.`);
    return null;
  }

  const modal = document.getElementById("compare-picker-modal");
  const body = document.getElementById("compare-picker-body");
  return new Promise(resolve => {
    const finish = (val) => {
      _deviceComparePick = null;
      modal.style.display = "none";
      resolve(val);
    };
    _deviceComparePick = finish;

    body.innerHTML = "";
    files.forEach(f => {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = f.filename;
      const date = document.createElement("td");
      date.textContent = f.date || "";
      const size = document.createElement("td");
      size.className = "size-col";
      size.textContent = fmtFileSize(f.size);
      tr.append(name, date, size);
      tr.onclick = () => finish({ app, kind: "device", path: f.path, label: f.filename });
      body.appendChild(tr);
    });
    modal.style.display = "block";
  });
}

function closeComparePicker() {
  const finish = _deviceComparePick;
  if (finish) finish(null);
  else document.getElementById("compare-picker-modal").style.display = "none";
}

// --- the comparison tab ---

// Size every visible comparison scroller to the rest of the viewport, so its
// sticky column headers pin and the pairs scroll under them.
function sizeCompareAreas() {
  document.querySelectorAll(".compare-scroll").forEach(el => {
    if (el.offsetParent === null) return;  // hidden tab — skip
    const top = el.getBoundingClientRect().top;
    el.style.height = `${Math.max(300, window.innerHeight - top - 15)}px`;
  });
}

function showCompareTab(host, tabId) {
  host.show(tabId);
  window.scrollTo(0, 0);  // the pairs scroll inside the pane, not with the page
  sizeCompareAreas();
}

function compareTabIdFor(sources) {
  const slug = src => src.label.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24);
  return `cmp-${sources.map(slug).join("-vs-")}`;
}

// Two logs read as "a vs b"; more than that would overflow the tab strip.
function compareTabLabel(sources) {
  if (sources.length === 2) return `⇄ ${sources[0].label} vs ${sources[1].label}`;
  return `⇄ ${sources[0].label} +${sources.length - 1} more`;
}

async function loadTelemetryFor(src) {
  const deviceId = document.getElementById("device")?.value || "";
  const url = src.kind === "saved"
    ? `/api/vcat_monitor/load_saved?session=${session_token}&app=${src.app}` +
      `&name=${encodeURIComponent(src.path)}`
    : `/api/vcat_monitor/telemetry_from_file?session=${session_token}&device=${deviceId}` +
      `&app=${src.app}&telemetry_file_path=${encodeURIComponent(src.path)}`;
  const data = await (await fetch(url)).json();
  if (data.status === "error" || !data.telemetry_data) {
    throw new Error(data.message || "no telemetry data in file");
  }
  return data;
}

function removeCompareTab(tabId) {
  const existed = !!document.getElementById(`${tabId}-tab`);
  const st = compareStateByTabId[tabId];
  (st ? st.sides : []).forEach(sideId => {
    Object.values(chartsByTabId[sideId] || {}).forEach(c => c && c.destroy && c.destroy());
    delete chartsByTabId[sideId];
  });
  delete compareStateByTabId[tabId];
  document.getElementById(`${tabId}-tab-btn`)?.remove();
  document.getElementById(`${tabId}-tab`)?.remove();
  openedFileTabs.delete(tabId);
  if (existed && !document.getElementById("device")?.options.length) showNoDeviceUI(true);
}

// Header row above each column, naming the file that column belongs to.
function compareColumnHead(src, side) {
  const head = document.createElement("div");
  head.className = "cmp-col-head";
  const tag = document.createElement("span");
  tag.className = "cmp-col-tag";
  tag.textContent = side;
  head.append(tag, document.createTextNode(` ${src.label}`));
  head.title = `${src.label} (${src.kind === "device" ? "on device" : "local file"})`;
  return head;
}

function compareToolbar(tabId, sources) {
  const bar = document.createElement("div");
  bar.className = "telemetry-toolbar compare-toolbar";
  const left = document.createElement("div");
  left.className = "compare-title";
  left.textContent = `⇄ ${sources.map(s => s.label).join("  vs  ")}`;
  left.title = left.textContent;
  const right = document.createElement("div");

  const pdf = document.createElement("button");
  pdf.type = "button";
  pdf.className = "cmp-pdf-btn";
  pdf.dataset.export = "pdf";
  pdf.textContent = "⤓ Save PDF";
  pdf.title = "Save this comparison — header plus every chart row — as a PDF";
  pdf.disabled = true;  // enabled once every column has rendered
  pdf.onclick = () => exportTabPdf(tabId);
  right.appendChild(pdf);

  const xls = document.createElement("button");
  xls.type = "button";
  xls.className = "cmp-pdf-btn cmp-xls-btn";
  xls.dataset.export = "xlsx";
  xls.textContent = "⤓ Save Spreadsheet";
  xls.title = "Save per-hour battery and temperature tables (.xlsx) for every log, ready to chart";
  xls.disabled = true;  // enabled once every column has rendered
  xls.onclick = () => exportTabSpreadsheet(tabId);
  right.appendChild(xls);

  const align = document.createElement("label");
  align.className = "cmp-align";
  align.title = "Plot every column on one shared x/y range so magnitudes compare directly";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "cmp-align-box";
  box.checked = true;
  box.onchange = () => {
    const st = compareStateByTabId[tabId];
    if (st) applyCompareAlignment(st.sides, box.checked);
  };
  align.append(box, document.createTextNode(" Align axes"));
  right.appendChild(align);

  const sel = document.createElement("select");
  sel.className = "compare-select";
  sel.title = "Add another log to this comparison";
  sel.onchange = () => handleCompareSelect(sel);
  [["", "⇄ Compare To…"], ["device", "Open file on device…"], ["local", "Browse local file…"]]
    .forEach(([value, text]) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      sel.appendChild(opt);
    });
  right.appendChild(sel);
  bar.append(left, right);
  return bar;
}

// A telemetry pane's markup, minus the bits that make no sense per-side inside a
// comparison (its own view-mode toolbar and Focus containers).
function buildCompareSide(staging, sideId, app) {
  const holder = document.createElement("div");
  holder.className = "cmp-side";
  holder.id = `${sideId}-tab`;
  staging.appendChild(holder);

  if (app === "vcat_ai") {
    setupAiTelemetryCanvas(sideId);
  } else {
    const clone = document.importNode(
      document.getElementById("telemetry-tab-template").content, true);
    clone.querySelectorAll("canvas[data-id]").forEach(c => {
      c.id = `${sideId}-${c.getAttribute("data-id")}`;
    });
    holder.appendChild(clone);
  }
  holder.querySelector(".telemetry-toolbar")?.remove();
  holder.querySelector(".tele-focus")?.remove();
  // Play/Stop act on the *live* device; a comparison is always historical.
  holder.querySelector(".player-controls")?.remove();
}

// Group every column's charts by title: one grid row per metric, one cell per log
// in column order. A log missing a metric gets a placeholder so the row stays aligned.
function interleaveCompareGrid(grid, sideIds) {
  const wrappersOf = sideId => {
    const holder = document.getElementById(`${sideId}-tab`);
    return holder
      ? [...holder.querySelectorAll(":scope > .dashboard-grid > .chart-wrapper")]
      : [];
  };
  const perSide = sideIds.map(wrappersOf);

  const titles = [];
  perSide.flat().forEach(w => {
    const t = wrapperTitle(w);
    if (!titles.includes(t)) titles.push(t);
  });

  titles.forEach(title => {
    perSide.forEach((list, i) => {
      const w = list.find(x => wrapperTitle(x) === title);
      if (w) {
        w.dataset.side = sideIds[i];
        grid.appendChild(w);
      } else {
        const empty = document.createElement("div");
        empty.className = "chart-wrapper cmp-empty";
        empty.textContent = `${title} — not recorded in this log`;
        grid.appendChild(empty);
      }
    });
  });
}

// Both the sticky header bar and the grid need the same track layout so the columns
// stay lined up, including while scrolled sideways.
function applyCompareColumns(elements, count) {
  const columns = `repeat(${count}, minmax(${COMPARE_MIN_COL_PX}px, 1fr))`;
  elements.forEach(el => el && (el.style.gridTemplateColumns = columns));
}

// The Temperature chart plots system-thermal status normalized against its own y
// max, so moving that max means rescaling the series with it.
function rescaleNormalized(dataset, newMax) {
  if (dataset.normMax === undefined || dataset.normMax === newMax) return;
  const factor = newMax / dataset.normMax;
  dataset.data = dataset.data.map(v => (typeof v === "number" ? v * factor : v));
  dataset.normMax = newMax;
}

// Align axes: give both sides of each metric pair one shared x and y range, so the
// two charts are read against the same ruler instead of each auto-fitting its own
// data. Off restores each chart's own scaling — worth having, because a shared axis
// squashes a short run into the timeline of a much longer one.
function applyCompareAlignment(sides, on) {
  const keys = [];
  sides.forEach(s => Object.keys(chartsByTabId[s] || {}).forEach(k => {
    if (!keys.includes(k)) keys.push(k);
  }));

  keys.forEach(key => {
    const pair = sides.map(s => (chartsByTabId[s] || {})[key]).filter(Boolean);
    if (pair.length < 2) return;

    // Remember each chart's own scaling once, so the toggle is reversible.
    pair.forEach(c => {
      c._cmpOwnScale ||= {
        xMax: c.options.scales.x.max,
        yMax: c.options.scales.y.max,
        step: c.options.scales.x.ticks.stepSize,
        norm: c.data.datasets.map(d => d.normMax),
      };
    });

    if (on) {
      const xMax = Math.max(...pair.map(c => c.scales.x.max));
      const yMax = Math.max(...pair.map(c => c.scales.y.max));
      const step = computeStepSize(xMax);
      pair.forEach(c => {
        c.options.scales.x.min = 0;
        c.options.scales.x.max = xMax;
        c.options.scales.x.ticks.stepSize = step;
        if (Number.isFinite(yMax)) {
          c.data.datasets.forEach(d => rescaleNormalized(d, yMax));
          c.options.scales.y.max = yMax;
        }
      });
    } else {
      pair.forEach(c => {
        const own = c._cmpOwnScale;
        c.options.scales.x.max = own.xMax;
        c.options.scales.x.ticks.stepSize = own.step;
        c.options.scales.y.max = own.yMax;
        c.data.datasets.forEach((d, i) => {
          if (own.norm[i] !== undefined) rescaleNormalized(d, own.norm[i]);
        });
      });
    }
    pair.forEach(c => c.update("none"));
  });
}

// `sources` is one descriptor per column (two or more); `cached` supplies already
// loaded payloads positionally so adding a column does not re-read the others.
async function openCompareTab(sources, cached = []) {
  const app = sources[0].app;
  const odd = sources.find(s => s.app !== app);
  if (odd) {
    return alert(
      `Can't compare a ${appLabel(app)} log with a ${appLabel(odd.app)} log — ` +
      `they record different metrics.`);
  }
  const host = tabHost(app);
  const tabId = compareTabIdFor(sources);
  const sides = sources.map((_, i) => `${tabId}-${sideTag(i)}`);

  removeCompareTab(tabId);  // re-opening the same set rebuilds it

  const btn = document.createElement("button");
  btn.id = `${tabId}-tab-btn`;
  btn.className = host.btnClass;
  btn.title = sources.map(s => s.label).join("  vs  ");
  const label = document.createElement("span");
  label.textContent = compareTabLabel(sources);
  btn.appendChild(label);
  const close = document.createElement("span");
  close.textContent = " ✖";
  close.style.marginLeft = "8px";
  close.style.color = "#ccc";
  close.style.cursor = "pointer";
  close.onclick = (e) => {
    e.stopPropagation();
    removeCompareTab(tabId);
    host.show(host.home);
  };
  btn.appendChild(close);
  btn.onclick = () => showCompareTab(host, tabId);
  document.getElementById(host.header).appendChild(btn);

  const pane = document.createElement("div");
  pane.id = `${tabId}-tab`;
  pane.className = `${host.paneClass} compare-pane`;
  pane.style.display = "none";
  pane.appendChild(compareToolbar(tabId, sources));

  // The pairs scroll inside the pane rather than with the page: `html, body {
  // overflow-y: auto }` means a sticky header in the document flow never pins, and
  // an inner scroller also keeps the toolbar and column names in place.
  const scroller = document.createElement("div");
  scroller.className = "compare-scroll";

  // Column headers sit in their own sticky bar rather than in the grid's first
  // row: a sticky grid *item* is confined to its own row and scrolls away with it.
  const heads = document.createElement("div");
  heads.className = "compare-heads";
  sources.forEach((src, i) => heads.appendChild(compareColumnHead(src, sideTag(i))));
  scroller.appendChild(heads);

  const grid = document.createElement("div");
  grid.className = "compare-grid";
  scroller.appendChild(grid);
  // Columns get a floor width so more than about three logs scroll sideways
  // rather than squeezing every chart into an unreadable sliver.
  applyCompareColumns([heads, grid], sources.length);
  pane.appendChild(scroller);

  // Charts are built here first (off-screen but laid out, so canvases get a real
  // size) and then moved into the shared grid.
  const staging = document.createElement("div");
  staging.className = "cmp-staging";
  pane.appendChild(staging);

  document.getElementById(host.content).appendChild(pane);
  openedFileTabs.add(tabId);
  compareStateByTabId[tabId] = { sources, sides, data: sources.map(() => null) };
  showNoDeviceUI(false);
  ensureAppTab(app);   // the app's panel must be the visible one, otherwise the
  showAppTab(app);     // canvases are laid out at zero width and draw nothing
  showCompareTab(host, tabId);

  sides.forEach(sideId => buildCompareSide(staging, sideId, app));

  let loaded;
  try {
    loaded = await Promise.all(
      sources.map((src, i) => cached[i] || loadTelemetryFor(src)));
  } catch (err) {
    removeCompareTab(tabId);
    host.show(host.home);
    alert(`Could not build the comparison:\n\n${err.message || err}`);
    return null;
  }

  compareStateByTabId[tabId].data = loaded;
  sides.forEach((sideId, i) => renderFileTelemetry(sideId, app, loaded[i]));
  interleaveCompareGrid(grid, sides);
  staging.remove();
  sizeCompareAreas();
  sides.forEach(resizeTabCharts);
  applyCompareAlignment(sides, true);

  updateExportButtons(tabId);
  return tabId;
}

// ---- Save a comparison as a PDF ----------------------------------------------
// The pages mirror the on-screen layout: a header identifying both runs, then one
// row per metric with A left and B right. Charts are exported straight from the
// live canvases, so what you compared is exactly what lands in the file (including
// the shared axes when "Align axes" is on).

// Floor width for a comparison column; past ~3 logs the grid scrolls sideways
// instead of squeezing every chart down to an unreadable sliver.
const COMPARE_MIN_COL_PX = 420;

const PDF_DARK = "#1b1b1b";   // matches .chart-wrapper — canvases are transparent
const PDF_INK = "#111111";
const PDF_MUTED = "#666666";

// Chart bitmaps dominate the file size, so they are re-rasterised before embedding:
// capped at PDF_IMG_WIDTH (a canvas on a retina screen has a 2x backing store, which
// otherwise doubles the PDF for no visible gain) and written as JPEG. A cell is
// ~386pt wide, so 900px is still ~170 DPI in print.
const PDF_IMG_WIDTH = 900;
const PDF_JPEG_QUALITY = 0.82;

// Labels can be long once disambiguated, so filenames get a trimmed version.
function exportStem(payloads) {
  const clean = v => String(v || "")
    .replace(/\.csv$/i, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 14)
    .replace(/_+$/, "");
  const stem = comparisonSeriesLabels(payloads).map(clean).join("_vs_");
  return stem.length > 80 ? `${payloads.length}_logs_${stem.slice(0, 60)}` : stem;
}

function pdfFileName(sources, payloads) {
  const kind = sources.length > 1 ? "compare" : "report";
  return `${kind}_${exportStem(payloads)}.pdf`;
}

// Chart.js canvases are transparent with light strokes, so the dark card colour is
// painted in behind them — both to stay legible on a white page and because JPEG
// has no alpha channel.
function pdfChartImage(chart) {
  const src = chart.canvas;
  const scale = Math.min(1, PDF_IMG_WIDTH / (src.width || PDF_IMG_WIDTH));
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const ctx = off.getContext("2d");
  ctx.fillStyle = PDF_DARK;
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  return off.toDataURL("image/jpeg", PDF_JPEG_QUALITY);
}

// Park the tooltip on each chart's final sample before rasterising, so the PDF
// carries the end-of-run numbers (and the elapsed time they belong to) instead of
// leaving them to be read off the axes. Returns false if there is nothing to show.
function pdfActivateFinalTooltip(chart) {
  const elements = chart.data.datasets
    .map((ds, datasetIndex) => ({
      datasetIndex,
      index: ((ds && ds.data) || []).length - 1,
    }))
    .filter(e => e.index >= 0 && chart.isDatasetVisible(e.datasetIndex));
  if (!elements.length) return false;

  // Anchor the caret on the first series' last point; Chart.js keeps the box inside
  // the canvas from there.
  const meta = chart.getDatasetMeta(elements[0].datasetIndex);
  const point = meta && meta.data ? meta.data[elements[0].index] : null;
  chart.tooltip.setActiveElements(elements, {
    x: point ? point.x : chart.chartArea.right,
    y: point ? point.y : chart.chartArea.top,
  });
  chart.update("none");
  return true;
}

function pdfClearTooltip(chart) {
  chart.tooltip.setActiveElements([], { x: 0, y: 0 });
  chart.update("none");
}

function pdfDrawChart(doc, chart, x, y, w, h) {
  doc.setFillColor(PDF_DARK);
  doc.roundedRect(x, y, w, h, 4, 4, "F");
  let activated = false;
  try {
    activated = pdfActivateFinalTooltip(chart);
    doc.addImage(pdfChartImage(chart), "JPEG", x + 4, y + 4, w - 8, h - 8, undefined, "FAST");
  } catch (err) {
    console.error("chart -> image failed:", err);
    doc.setTextColor(PDF_MUTED);
    doc.setFontSize(9);
    doc.text("chart unavailable", x + 10, y + h / 2);
  } finally {
    // Never leave a stuck tooltip on the chart the user is looking at.
    if (activated) {
      try { pdfClearTooltip(chart); } catch (e) { console.error("tooltip reset failed:", e); }
    }
  }
}

function exportTabPdf(tabId) {
  const ctx = exportContextFor(tabId);
  if (!ctx) return;
  if (ctx.sources.length > PDF_MAX_COLUMNS) {
    return alert(
      `A PDF lays the logs out side by side, so it is limited to ${PDF_MAX_COLUMNS}. ` +
      `This comparison has ${ctx.sources.length} — use Save Spreadsheet instead.`);
  }
  const jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
  if (!jsPDFCtor) {
    return alert("PDF export needs the jsPDF library, which failed to load.\n" +
                 "Check the network connection and reload the page.");
  }

  const { sources, sides, data } = ctx;
  // compress: true -> FlateDecode on the page streams (jsPDF writes them raw otherwise).
  const doc = new jsPDFCtor({
    orientation: "landscape", unit: "pt", format: "a4", compress: true,
  });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 28;
  const gap = 14;
  const cols = sides.length;
  const colW = (pageW - margin * 2 - gap * (cols - 1)) / cols;

  // --- cover: what is being compared ---
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(PDF_INK);
  doc.text(cols > 1 ? "VCAT result comparison" : "VCAT result", margin, margin + 6);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(PDF_MUTED);
  doc.text(`Generated ${new Date().toLocaleString()}`, margin, margin + 22);

  // One row per field, one column per run: reads the same as the spreadsheet block
  // and keeps working when there are more than two logs.
  const labelW = 78;
  const fieldColW = (pageW - margin * 2 - labelW - gap * (cols - 1)) / cols;
  let headY = margin + 48;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  sources.forEach((src, i) => {
    const x = margin + labelW + i * (fieldColW + gap);
    doc.setFillColor("#0aa77a");
    doc.roundedRect(x, headY - 11, 16, 14, 3, 3, "F");
    doc.setTextColor("#ffffff");
    doc.text(sideTag(i), x + 5, headY - 1);
    doc.setTextColor(PDF_INK);
    doc.text(doc.splitTextToSize(src.label, fieldColW - 22)[0], x + 22, headY - 1);
  });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  let fieldY = headY + 18;
  runFieldRows(sources, data).forEach(([field, ...values]) => {
    doc.setTextColor(PDF_MUTED);
    doc.text(field, margin, fieldY);
    doc.setTextColor(PDF_INK);
    values.forEach((v, i) => {
      const x = margin + labelW + i * (fieldColW + gap);
      doc.text(doc.splitTextToSize(String(v), fieldColW - 4)[0], x, fieldY);
    });
    fieldY += 12;
  });

  // --- one row per metric, one column per log ---
  const titleByKey = {};
  paneOf(tabId)?.querySelectorAll(".chart-wrapper").forEach(w => {
    const h3 = w.querySelector("h3");
    const canvas = w.querySelector("canvas");
    if (!h3 || !canvas) return;
    const key = canvas.id.replace(/^.*?-(?=[a-z]+Chart$)/, "");
    if (!titleByKey[key]) titleByKey[key] = h3.textContent.trim();
  });

  const keys = [];
  sides.forEach(sd => Object.keys(chartsByTabId[sd] || {}).forEach(k => {
    if (!keys.includes(k)) keys.push(k);
  }));
  const rowsPerPage = 2;
  const titleH = 16;
  const rowH = (pageH - margin * 2 - rowsPerPage * titleH - (rowsPerPage - 1) * gap) / rowsPerPage;

  keys.forEach((key, idx) => {
    if (idx % rowsPerPage === 0) doc.addPage();
    const row = idx % rowsPerPage;
    const top = margin + row * (rowH + titleH + gap);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(PDF_INK);
    doc.text(titleByKey[key] || key, margin, top + 11);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(PDF_MUTED);
    if (cols > 1) {
      sides.forEach((_, i) => {
        doc.text(sideTag(i), margin + (i + 1) * colW + i * gap - 8, top + 11);
      });
    }

    sides.forEach((sideId, i) => {
      const chart = chartsByTabId[sideId]?.[key];
      if (chart) {
        pdfDrawChart(doc, chart, margin + i * (colW + gap), top + titleH, colW, rowH);
      }
    });
  });

  // --- page numbers ---
  const footer = sources.map(sc => sc.label).join("  vs  ");
  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(PDF_MUTED);
    doc.text(doc.splitTextToSize(footer, pageW - margin * 2 - 40)[0], margin, pageH - 12);
    doc.text(`${i} / ${pages}`, pageW - margin - 24, pageH - 12);
  }

  doc.save(pdfFileName(sources, data));
}

// ---- Save a comparison as a spreadsheet ---------------------------------------
// A per-hour table laid out for charting: hour 0..n down column A, one column per
// log. For each whole hour we take the sample nearest that hour mark, which is
// what "battery at hour 3" means for logs sampled every 30s or so.

const HOUR_S = 3600;

// Describes each run, one row per field and one value per log. Used for the block
// above the spreadsheet table and for the PDF cover, so both stay in step.
function runFieldRows(sources, payloads) {
  const labels = comparisonSeriesLabels(payloads);
  const dash = v => (v === undefined || v === null || v === "" ? "—" : v);
  const fps = v => (Number(v) > 0 ? `${Number(v).toFixed(2)} fps` : "—");
  const vids = payloads.map(d => ((d && d.test_details) || {}).currentTestVideo || {});
  const infos = payloads.map(d => (d && d.run_info) || {});
  const spans = payloads.map(d => {
    const b = ((d && d.telemetry_data) || {}).battery || [];
    return b.length ? b[b.length - 1].elapsed_time : 0;
  });
  const row = (field, fn) => [field, ...payloads.map((_, i) => dash(fn(vids[i], infos[i], i)))];
  return [
    row("Codec", (v, info, i) => labels[i]),
    row("Input resolution", v => v.resolution),
    row("Frame rate", v => fps(v.framerate)),
    row("Input file", v => v.fileName),
    row("Decoder", v => v.videoDecoder),
    row("Device", (v, info) => [info.manufacturer, info.model].filter(Boolean).join(" ")),
    row("SoC vendor", (v, info) => info.soc_manufacturer),
    row("SoC", (v, info) => info.soc_model),
    row("Android", (v, info) => info.android_version),
    row("vcat version", (v, info) => info.vcat_version),
    row("Playlist", (v, info) => info.playlist),
    row("Test duration", (v, info, i) => formatElapsedClock(spans[i])),
    row("Execution ID", (v, info) => info.execution_id),
    row("Log file", (v, info, i) => sources[i].label),
    row("Source", (v, info, i) => (sources[i].kind === "device" ? "on device" : "local file")),
  ];
}

// Nearest sample to `target`, or null if the closest one is further away than
// `tolerance` (a gap in the log, rather than a real reading for that hour).
function sampleNearest(series, target, tolerance, valueKey) {
  let best = null;
  let bestGap = Infinity;
  for (const p of series) {
    const gap = Math.abs(p.elapsed_time - target);
    if (gap < bestGap) { bestGap = gap; best = p; }
    else if (p.elapsed_time > target && bestGap < Infinity) break;  // series is ordered
  }
  if (!best || bestGap > tolerance) return null;
  const v = best[valueKey];
  return typeof v === "number" ? v : null;
}

// The longest-running test sets the axis: hours run to the hour that log *ends* in
// (ceil, not floor — flooring dropped the last partial hour, so a 5.9 h run stopped
// at hour 5 and its end-of-test reading was lost). A shorter log's trailing cells
// stay blank so a chart shows no line there instead of a false drop to zero.
function buildHourlyTable(seriesList, valueKey = "level") {
  const spans = seriesList.map(s => (s.length ? s[s.length - 1].elapsed_time : 0));
  const lastHour = Math.ceil(Math.max(0, ...spans) / HOUR_S);
  const rows = [];
  for (let h = 0; h <= lastHour; h++) {
    rows.push([
      h,
      ...seriesList.map(s => sampleNearest(s, h * HOUR_S, HOUR_S / 2, valueKey)),
    ]);
  }
  // A run ending just past the hour (5.01 h) would leave a final row with nothing
  // near enough to report; drop any trailing rows that are blank for every log.
  while (rows.length > 1 && rows[rows.length - 1].slice(1).every(v => v === null)) {
    rows.pop();
  }
  return rows;
}

// The codec is what distinguishes two runs — a log filename says nothing useful in
// a chart legend. Falls back through decoder / resolution / file only if both sides
// would otherwise carry the same label.
function codecLabel(codec) {
  return String(codec || "").replace(/^video\//i, "").toUpperCase();
}

function comparisonSeriesLabels(payloads) {
  const parts = payloads.map(d => {
    const v = ((d && d.test_details) || {}).currentTestVideo || {};
    return {
      codec: codecLabel(v.videoCodec),
      decoder: v.videoDecoder || "",
      resolution: v.resolution || "",
      framerate: Number(v.framerate) > 0 ? `${Number(v.framerate).toFixed(2)} fps` : "",
      file: String(v.fileName || "").replace(/\.[^.]+$/, ""),
    };
  });
  const labels = parts.map(p => p.codec || "unknown");

  // Two runs of the same codec would give identical columns; separate each clashing
  // group by the first field that actually tells its members apart.
  const groups = new Map();
  labels.forEach((l, i) => {
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(i);
  });
  groups.forEach((idxs, label) => {
    if (idxs.length < 2) return;
    const key = ["decoder", "framerate", "resolution", "file"].find(
      k => new Set(idxs.map(i => parts[i][k])).size === idxs.length);
    idxs.forEach(i => {
      labels[i] = key
        ? `${label} ${parts[i][key]}`.trim()
        : `${label} (${sideTag(i)})`;
    });
  });
  return labels;
}

async function exportTabSpreadsheet(tabId) {
  const ctx = exportContextFor(tabId);
  if (!ctx || ctx.data.some(d => !d)) return;

  const { sources, data } = ctx;
  const seriesFor = (key) =>
    data.map(d => ((d.telemetry_data && d.telemetry_data[key]) || []));

  // One sheet per metric, each a chartable per-hour table. A metric no log recorded
  // is skipped rather than written as an empty sheet.
  const metrics = [
    { metric: "Battery Level", unit: "Battery Level (%)", key: "battery", value: "level" },
    { metric: "Temperature", unit: "Battery Temp (°C)", key: "battery_temp", value: "temp" },
  ];
  const sheets = metrics
    .map(m => ({ ...m, series: seriesFor(m.key) }))
    .filter(m => m.series.some(sr => sr.length))
    .map(m => ({
      metric: m.metric,
      unit: m.unit,
      rows: buildHourlyTable(m.series, m.value),
    }));

  if (!sheets.length) {
    return alert("No battery or temperature data in these logs to tabulate.");
  }

  const labels = comparisonSeriesLabels(data);
  const stem = `hourly_${exportStem(data)}`;
  const infoRows = runFieldRows(sources, data);

  try {
    const res = await fetch(
      `/api/vcat_monitor/comparison_workbook?session=${session_token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          series_labels: labels,
          sheets,
          info_rows: infoRows,
          name: stem,
          notes: [
            `One sheet per metric (${sheets.map(sh => sh.metric).join(", ")}), ` +
              "sampled at each whole hour of elapsed test time.",
            "For every hour the reading nearest that hour mark is used " +
              `(no further away than ${HOUR_S / 2 / 60} minutes; blank if the log has no sample that close).`,
            "Hours run to the hour in which the longest-running test stopped, so its " +
              "final reading is included; a shorter run simply ends early (blank cells).",
            "Each column is one log; the block above each table identifies them.",
            "Temperature is the battery temperature in °C — an instantaneous reading at " +
              "the hour mark, not an average over the hour.",
          ],
        }),
      }
    );
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).message || msg; } catch (e) { /* not json */ }
      return alert(`Could not build the spreadsheet:\n\n${msg}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${stem}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("Spreadsheet export failed:", err);
    alert("Spreadsheet export failed.");
  }
}

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

  const deviceSelect = document.getElementById("device");

  // Get session token first
  fetch(`${API_BASE}/api/session_token`)
    .then(res => res.json())
    .then(data => {
      session_token = data.session_token;
      console.log("✅ Session Token:", session_token);

      checkOrphanSessions();  // offer to recover any leftover session from a crash

      // Drop the "Loading devices..." placeholder, bind the change handler once,
      // then populate — and keep polling for hot-plugged / removed devices.
      const firstOption = deviceSelect.options[0];
      if (firstOption && firstOption.disabled) deviceSelect.remove(0);
      deviceSelect.addEventListener("change", handleDeviceSelection);

      return syncDeviceList(true);
    })
    .then(() => {
      if (_deviceListInterval) clearInterval(_deviceListInterval);
      _deviceListInterval = setInterval(() => syncDeviceList(false), 5000);
    })
    .catch(err => {
      console.error("❌ Failed during device/session load:", err);
      showNoDeviceUI(true);
    });
}

// Show/hide the "no device connected" overlay and the main tab UI. Files opened
// from disk keep the UI up even with no device: this runs on the 5s device poll,
// so without that guard a locally-opened session would vanish moments after load.
function showNoDeviceUI(none) {
  const hide = none && openedFileTabs.size === 0;
  const overlay = document.getElementById("no-device-overlay");
  const tabContent = document.getElementById("tab-content");
  const tabHeader = document.getElementById("tab-header");
  if (overlay) overlay.style.display = hide ? "block" : "none";
  if (tabContent) tabContent.style.display = hide ? "none" : "block";
  if (tabHeader) tabHeader.style.display = hide ? "none" : "flex";
}

// Poll the connected-device list (server-side `adb devices`) and reconcile the
// dropdown: add newly connected devices, drop ones that vanished — but never the
// current selection or a device with a live session. When the list goes from empty
// to non-empty, auto-select the first device.
let _deviceListInterval = null;
async function syncDeviceList(initial) {
  let devices;
  try {
    devices = await (await fetch(`${API_BASE}/api/all_connected_devices?session=${session_token}`)).json();
  } catch (e) { return; }
  if (!Array.isArray(devices)) return;

  const sel = document.getElementById("device");
  const incoming = new Set(devices);
  const existing = new Set([...sel.options].map(o => o.value));
  const wasEmpty = existing.size === 0;

  devices.forEach(id => {
    if (!existing.has(id)) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = id;
      sel.appendChild(opt);
      if (!initial) console.log("🔌 Device connected:", id);
    }
  });

  const liveDevice = (aiLivePoll || window.telemetryInterval) ? _lastDeviceValue : null;
  [...sel.options].forEach(o => {
    if (!incoming.has(o.value) && o.value !== sel.value && o.value !== liveDevice) {
      o.remove();
    }
  });

  showNoDeviceUI(sel.options.length === 0);

  if (wasEmpty && sel.options.length > 0) {
    sel.value = sel.options[0].value;
    handleDeviceSelection();
    setTimeout(updateConsoleLog, 500);
  }
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
