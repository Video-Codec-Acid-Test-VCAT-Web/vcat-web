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



function fetchDeviceInfo(deviceId) {
    return fetch(`${API_BASE}/api/device/info?session=${session_token}&device=${deviceId}`)
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
  } else {
    console.log("⏳ Waiting for Chart.js and canvas...");
    setTimeout(waitForChartAndStartPolling, 100); // Retry every 100ms
  }
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



function handleConnectClick(source) {
  const isLive = source === "Live";
  const filePath = isLive ? null : source;

  const deviceId = document.getElementById("device").value;
  if (!deviceId) return alert("Select a device first.");
  selectedDevice = deviceId;

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


  function setupTelemetryCanvas(tabId) {
    const tabPane = document.getElementById(`${tabId}-tab`);
    if (!tabPane) return;

    // 🛡️ Don't inject template again if already present
    if (tabPane.querySelector("canvas.cpuChart")) {
      console.log(`⚠️ setupTelemetryCanvas already ran for ${tabId}`);
      return;
    }

    const template = document.getElementById("telemetry-tab-template");
    if (!template) {
      console.error("❌ Missing template #telemetry-tab-template");
      return;
    }

    const clone = template.content.cloneNode(true);

    // Optionally add unique IDs to canvases
    clone.querySelectorAll("canvas[class]").forEach(canvas => {
      canvas.id = `${tabId}-${canvas.className}`; // e.g. telemetry123-cpuChart
    });

    tabPane.appendChild(clone);
    console.log(`✅ Injected telemetry layout into ${tabId}`);
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
      renderTelemetryTab("telemetry");
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
    // ✅ Static file-based telemetry
    const url = `/api/vcat_monitor/telemetry_from_file?session=${session_token}&device=${deviceId}&telemetry_file_path=${encodeURIComponent(filePath)}`;

    fetch(url)
        .then(res => res.json())
        .then(data => {
          setupTelemetryCanvas(tabId);
          const telemetry = data.telemetry_data;
          const testDetails = data.test_details;

          if (testDetails) {
            updateTestDetailsUI({ test_details: testDetails },tabId);
          }

          updateCpuChart(telemetry, `${tabId}-cpuChart`, tabId);
          updateBatteryChart(telemetry, `${tabId}-batteryChart`, tabId);
          updateFreqChart(telemetry, `${tabId}-freqChart`, tabId);
          updateMemoryChart(telemetry, `${tabId}-memoryChart`, tabId);
          updateFrameDropChart(telemetry, `${tabId}-frameDropChart`, tabId);
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

function openDeviceModal() {
  if (!currentDeviceInfo) {
    document.getElementById("device-ip").textContent = "Unavailable";
    return;
  }

  const d = currentDeviceInfo;

  document.getElementById("device-ip").textContent = extractIpBase(d.ip_addr);

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

function updateBatteryChart(telemetry, chartId) {
  const battery = telemetry.battery || [];
  const labels = battery.map(p => p.elapsed_time);
  const data = battery.map(p => p.level);
  const stepSize = computeStepSize(labels.at(-1) || 0);
  batteryChart = updateChart(
    batteryChart,
    chartId,
    [{ label: 'Battery Level (%)', data, borderWidth: 2 }],
    labels,
    'Battery Level (%)',
    labels.at(-1),
    stepSize
  );
}

function updateCpuChart(telemetry, chartId, tabId) {
  const cpu = telemetry.cpu_usage || [];
  const labels = cpu.map(p => p.elapsed_time);
  const stepSize = computeStepSize(labels.at(-1) || 0);
  const datasets = [];

  const keys = Object.keys(cpu.at(-1) || {}).filter(k => k.startsWith("cpu"));
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

  // Create chart storage for this tab if needed
  chartsByTabId[tabId] ||= {};
  chartsByTabId[tabId].cpuChart = updateChart(
      chartsByTabId[tabId].cpuChart,
      chartId,
      datasets,
      labels,
      "CPU Usage (%)",
      labels.at(-1),
      stepSize
  );
}


function updateFreqChart(telemetry, chartId) {
  const freq = telemetry.cpu_freq || [];
  const labels = freq.map(p => p.elapsed_time);
  const stepSize = computeStepSize(labels.at(-1) || 0);
  const coreKeys = Object.keys(freq.at(-1)?.frequencies || {});
  const datasets = coreKeys.map((key, i) => {
    return {
      label: key,
      data: freq.map(p => p.frequencies[key]),
      borderColor: COLORS[i % COLORS.length],
      backgroundColor: COLORS[i % COLORS.length],
      borderWidth: 2,
      tension: 0.1,
      pointRadius: 0
    };
  });
  freqChart = updateChart(freqChart, chartId, datasets, labels, 'CPU Frequency (MHz)', labels.at(-1), stepSize);
}

function updateMemoryChart(telemetry, chartId) {
  const system = telemetry.system_memory || [];
  const app = telemetry.app_memory || [];
  const labels = system.map(p => p.elapsed_time);
  const appMap = Object.fromEntries(app.map(a => [a.elapsed_time, a.app_kb]));
  const stepSize = computeStepSize(labels.at(-1) || 0);
  const systemData = system.map(p => p.used_kb / 1024);
  const appData = system.map(p => (appMap[p.elapsed_time] ?? 0) / 1024);

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
  memoryChart = updateChart(memoryChart, chartId, datasets, labels, 'Memory Usage (MB)', labels.at(-1), stepSize);
}

function updateFrameDropChart(telemetry, chartId) {
  const drops = telemetry.frame_drops || [];
  const labels = drops.map(p => p.elapsed_time);
  const values = drops.map(p => p.delta_framedrops);
  const stepSize = computeStepSize(labels.at(-1) || 0);
  frameDropChart = updateChart(
    frameDropChart,
    chartId,
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


function fetchAndUpdateTelemetry() {
    fetch(`${API_TELEMETRY}?session=${session_token}&device=${selectedDevice}`)
    .then(res => res.json())
    .then(result => {

      const telemetry = result.telemetry_data;
      const testDetails = result.test_details;

      const tabId = "telemetry";

      if (testDetails) {
          updateTestDetailsUI({ test_details: testDetails }, tabId);
      }

      updateCpuChart(telemetry, `${tabId}-cpuChart`, tabId);
      updateBatteryChart(telemetry, `${tabId}-batteryChart`, tabId);
      updateFreqChart(telemetry, `${tabId}-freqChart`, tabId);
      updateMemoryChart(telemetry, `${tabId}-memoryChart`, tabId);
      updateFrameDropChart(telemetry, `${tabId}-frameDropChart`, tabId);

    })
    .catch(err => console.error('❌ Telemetry fetch failed:', err));
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
    fetch(`${API_RUN_CONFIG}?session=${session_token}&device=${selectedDevice}`)

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
  const container = document.getElementById("run-config-body");
  container.innerHTML = ''; // Clear previous content

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

function updateTestDetailsUI(data, tabId) {
  const tabRoot = document.getElementById(`${tabId}-tab`);
  if (!tabRoot || !data.test_details) return;

  const details = data.test_details;
  const curVideo = details.currentTestVideo;

  // Top-level test info
  tabRoot.querySelector(".test-state").value = details.testState || "";
  tabRoot.querySelector(".test-start-time").value = details.startTime || "";
  tabRoot.querySelector(".test-playlist").value = details.playlist || "";

  if (curVideo) {
    tabRoot.querySelector(".current-start-time").value = curVideo.startTime || "";
    tabRoot.querySelector(".test-file").value = curVideo.fileName || "";
    tabRoot.querySelector(".test-codec").value = curVideo.videoCodec || "";
    tabRoot.querySelector(".test-decoder").value = curVideo.videoDecoder || "";
    tabRoot.querySelector(".test-resolution").value = curVideo.resolution || "";
    tabRoot.querySelector(".test-mimetype").value = curVideo.mimeType || "";
    tabRoot.querySelector(".test-bitrate").value = curVideo.bitrate || "";
    tabRoot.querySelector(".test-framerate").value =
        (curVideo.framerate !== undefined) ? curVideo.framerate.toFixed(1) : "";
  }
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

function updatePlayerControlsState() {
    const state = document.getElementById("test-state").value;
    const shouldEnable = (state === "Running");

    const controls = [
        "btn-play-pause",
        "btn-video-stats",
        "btn-stop-test",
    ];

    controls.forEach((id) => {
        const btn = document.getElementById(id);
        if (shouldEnable) {
            btn.style.pointerEvents = "auto";
            btn.style.opacity = "1.0";
            btn.style.cursor = "pointer";
        } else {
            btn.style.pointerEvents = "none";
            btn.style.opacity = "0.4";
            btn.style.cursor = "not-allowed";
        }
    });
}


function handleDeviceSelection() {
  const deviceSelect = document.getElementById("device");
  const selectedDeviceId = deviceSelect?.value;

  if (selectedDeviceId && deviceSelect.options.length > 0) {
    updateDeviceTabLabel(selectedDeviceId);

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

function showTab(tabId) {
  const allTabs = document.querySelectorAll(".tab-pane");
  allTabs.forEach(tab => tab.style.display = "none");

  const tab = document.getElementById(`${tabId}-tab`);
  if (tab) tab.style.display = "block";

  // Update active tab button style
  document.querySelectorAll(".tab-button").forEach(btn => btn.classList.remove("active-tab"));
  const activeBtn = document.getElementById(`${tabId}-tab-btn`);
  if (activeBtn) activeBtn.classList.add("active-tab");
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

  document.getElementById("device-ip").textContent = extractIpBase(info.ip_addr);

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


function loadPlaylistFiles() {
  const deviceSelect = document.getElementById("device");
  const selectedDeviceId = deviceSelect?.value;
  if (!selectedDeviceId) return;

    const path = "/sdcard/Vcat/*.xspf";
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
        li.textContent = name;
        ul.appendChild(li);
      });
    })
    .catch(err => {
      console.error("Failed to load playlists:", err);
      const ul = document.getElementById("playlist-list");
      ul.innerHTML = "<li style='color: red;'>Failed to load playlists</li>";
    });
}

function loadTestResults() {
  const deviceSelect = document.getElementById("device");
  const selectedDeviceId = deviceSelect?.value;
  if (!selectedDeviceId) return;

  const path = "/sdcard/vcat/test_results/logs_*.csv";
  const url = `/api/device/test_results_files?session=${session_token}&device=${selectedDeviceId}&path=${encodeURIComponent(path)}`;

  fetch(url)
    .then(res => res.json())
    .then(files => {
      const ul = document.getElementById("test-results-list");
      ul.innerHTML = "";

      files.forEach(file => {
        const li = document.createElement("li");
        li.textContent = file.display_name;
        li.dataset.path = file.path;
        li.style.cursor = "pointer";

        li.onclick = (event) => {
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
            handleConnectClick(file.path);
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
            downloadLogFile(file.path, "text/csv");
          }));

          submenu.appendChild(createMenuItem("Excel", () => {
            downloadLogFile(file.path, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
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
        };

        ul.appendChild(li);
      });

    })
    .catch(err => {
      console.error("Failed to load test results:", err);
      document.getElementById("test-results-list").innerHTML =
        "<li style='color: red;'>Failed to load test results</li>";
    });
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

function downloadLogFile(telemetryFilePath, mimetype) {
  const deviceSelect = document.getElementById("device");
  const selectedDeviceId = deviceSelect?.value;

  if (!session_token || !selectedDeviceId || !telemetryFilePath || !mimetype) {
    alert("Missing required data for download.");
    return;
  }

  const encodedPath = encodeURIComponent(telemetryFilePath);
  const encodedMime = encodeURIComponent(mimetype);

  const url = `/api/vcat_monitor/download_telemetry_file?session=${session_token}&device=${selectedDeviceId}&telemetry_file_path=${encodedPath}&mimetype=${encodedMime}`;

  console.log("📥 Downloading telemetry file:");
  console.log("➡️ URL:", url);

  // Trigger browser download
  window.open(url, "_blank");
}


