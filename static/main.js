const API_BASE = "http://localhost:5050";
let session_token = null;
let selectedDevice = null;
let currentDeviceInfo = null;


const COLORS = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8',
  '#f58231', '#911eb4', '#46f0f0', '#f032e6',
  '#bcf60c', '#fabebe', '#008080', '#e6beff',
  '#9a6324', '#fffac8', '#800000', '#aaffc3',
  '#808000', '#ffd8b1', '#000075', '#808080'
];


function populateDeviceDropdown() {
    console.log("➡️ Calling populateDeviceDropdown with session_token =", session_token);

    fetch(`${API_BASE}/api/all_connected_devices?session=${session_token}`)
      .then(res => res.json())
      .then(devices => {
        console.log("📦 Device list:", devices);
        const select = document.getElementById("device");
        select.innerHTML = "";

        devices.forEach(device => {
          const opt = document.createElement("option");
          opt.value = device;
          opt.textContent = device;
          select.appendChild(opt);
        });
          
          setTimeout(updateConsoleLog, 500);
      })
      .catch(err => {
        console.error("❌ Failed to fetch devices:", err);
      });

}

// 👇 Fetch session ID first, then load devices
window.addEventListener("DOMContentLoaded", () => {
  fetch(`${API_BASE}/api/session_token`)
    .then(res => res.json())
    .then(data => {
      session_token = data.session_token;
      console.log("✅ Session Token:", session_token);
      populateDeviceDropdown();
    })
    .catch(err => {
      console.error("❌ Failed to get session Token:", err);
    });
});

function fetchDeviceInfo(deviceId) {
  fetch(`${API_BASE}/api/device/info?session=${session_token}&device=${deviceId}`)
    .then(res => res.json())
    .then(data => {
      currentDeviceInfo = data;

      // Capitalize manufacturer + model
      const manufacturer = data.manufacturer.charAt(0).toUpperCase() + data.manufacturer.slice(1);
      const model = data.model;
      const summary = `Device: ${manufacturer} ${model}`;

      const summaryEl = document.getElementById("device-summary");
      if (summaryEl) summaryEl.textContent = summary;
    })
    .catch(err => {
      console.error("❌ Failed to fetch device info:", err);
    });
}


function waitForChartAndStartPolling() {
    if (typeof Chart !== 'undefined') {
    fetchAndUpdateTelemetry(); // First draw
    window.telemetryInterval = setInterval(fetchAndUpdateTelemetry, 30000);
  } else {
    setTimeout(waitForChartAndStartPolling, 100); // Try again in 100ms
  }
}

function handleConnectClick() {
  const button = document.getElementById("connect-btn");

  if (session_token && selectedDevice) {
    // 🔌 Disconnect
    console.log("🔌 Disconnecting from device...");
    selectedDevice = null;

    // Reset UI
    document.getElementById("device-info").innerHTML = "";
    document.getElementById("console-log").textContent = "";
    button.textContent = "Connect";
    return;
  }

  // 🔗 Connect
  const deviceId = document.getElementById("device").value;
  if (!deviceId) return alert("Select a device first.");

  selectedDevice = deviceId;
  button.textContent = "Disconnect";

    if (!window.telemetryInterval) {
      waitForChartAndStartPolling();
    }


  fetchDeviceInfo(deviceId);

    fetch(`${API_BASE}/api/vcat_monitor/start?session=${session_token}&device=${deviceId}`, {
      method: "POST"
    })
      .then(res => {
        if (!res.ok) throw new Error("Failed to start telemetry");
        console.log("🚀 Telemetry started");
          setTimeout(updateConsoleLog, 500);
      })
      .catch(err => {
        console.error("❌ Telemetry start failed:", err);
      });
}

function updateConsoleLog() {
  fetch(`${API_BASE}/api/session_console_log?session=${session_token}`)
    .then(res => res.json())
    .then(data => {
      if (!data || !data.log || data.log.length === 0) return;

      const lastEntry = data.log.at(-1).text.trim();
      const fullLog = data.log.map(entry => entry.text.trim()).join('\n\n');


      // Update preview with just the last line
      document.getElementById("console-preview").textContent = lastEntry;

      // Update full modal view
      document.getElementById("console-full").textContent = fullLog;
    })
    .catch(err => {
      console.error("❌ Failed to fetch console log:", err);
    });
}



function openDeviceModal(event) {
  const modal = document.getElementById("device-modal");
  const modalContent = document.getElementById("device-modal-content");
  const modalBody = document.getElementById("device-modal-body");

  if (!currentDeviceInfo) {
    modalBody.innerHTML = "<em>No device information available.</em>";
  } else {
    const d = currentDeviceInfo;

    const soc = `${d.soc_manufacturer} ${d.soc}`;
    const resolution = `${d.display_resolution.width}×${d.display_resolution.height}`;
    const storage = `Storage (total/free): ${d.storage.total} / ${d.storage.available}`;
    const memory = `Memory (total/free): ${d.memory.total} / ${d.memory.available}`;

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
      .map(([label, count]) => `&nbsp;&nbsp;&nbsp;&nbsp;${count}×${label}`)
      .join("<br>");

    const cpu = `ARMv8:<br>${coreLines}`;

    modalBody.innerHTML = `
      Display: ${resolution}<br>
      ${soc}<br>
      ${cpu}<br>
      ${storage}<br>
      ${memory}
    `;
  }

  // ✅ Use event to find button position
  const rect = event.target.getBoundingClientRect();
  modalContent.style.top = `${rect.bottom + window.scrollY + 8}px`;
  modalContent.style.left = `${rect.left + window.scrollX}px`;

  modal.style.display = "block";

  setTimeout(() => {
    document.addEventListener("click", handleOutsideClick);
  }, 0);
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

function openConsoleModal() {
  const modal = document.getElementById("console-modal");
  const modalContent = document.getElementById("console-modal-content");
  const btn = event.target;

  // Align modal near the main preview box
  const preview = document.getElementById("console-preview");
  const rect = preview.getBoundingClientRect();
  modalContent.style.top = `${rect.top + window.scrollY + 10}px`;
  modalContent.style.left = `${rect.left + window.scrollX}px`;

  modal.style.display = "block";

  setTimeout(() => {
    document.addEventListener("click", handleConsoleOutsideClick);
  }, 0);
}


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

function updateBatteryChart(telemetry) {
  const battery = telemetry.battery || [];
  const labels = battery.map(p => p.elapsed_time);
  const data = battery.map(p => p.battery_level);
  const stepSize = computeStepSize(labels.at(-1) || 0);
  batteryChart = updateChart(
    batteryChart,
    'batteryChart',
    [{ label: 'Battery Level (%)', data, borderWidth: 2 }],
    labels,
    'Battery Level (%)',
    labels.at(-1),
    stepSize
  );
}

function updateCpuChart(telemetry) {
  const cpu = telemetry.cpu_usage || [];
  const labels = cpu.map(p => p.elapsed_time);
  const stepSize = computeStepSize(labels.at(-1) || 0);
  const datasets = [];

  const keys = Object.keys(cpu.at(-1) || {}).filter(k => k.startsWith('cpu'));
  keys.forEach((key, i) => {
    datasets.push({
      label: key === 'cpu' ? 'Total CPU (%)' : key,
      data: cpu.map(p => p[key] ?? null),
      borderColor: COLORS[i % COLORS.length],
      backgroundColor: COLORS[i % COLORS.length],
      borderWidth: 2,
      tension: 0.1,
      pointRadius: 0
    });
  });
  cpuChart = updateChart(cpuChart, 'cpuChart', datasets, labels, 'CPU Usage (%)', labels.at(-1), stepSize);
}

function updateFreqChart(telemetry) {
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
  freqChart = updateChart(freqChart, 'freqChart', datasets, labels, 'CPU Frequency (MHz)', labels.at(-1), stepSize);
}

function updateMemoryChart(telemetry) {
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
  memoryChart = updateChart(memoryChart, 'memoryChart', datasets, labels, 'Memory Usage (MB)', labels.at(-1), stepSize);
}

function updateFrameDropChart(telemetry) {
  const drops = telemetry.frame_drops || [];
  const labels = drops.map(p => p.elapsed_time);
  const values = drops.map(p => p.delta_framedrops);
  const stepSize = computeStepSize(labels.at(-1) || 0);
  frameDropChart = updateChart(
    frameDropChart,
    'frameDropChart',
    [{ label: 'Frame Drops', data: values, borderWidth: 2 }],
    labels,
    'Dropped Frames',
    labels.at(-1),
    stepSize
  );
}

function fetchAndUpdateTelemetry() {
    fetch(`${API_TELEMETRY}?session=${session_token}&device=${selectedDevice}`)
    .then(res => res.json())
    .then(result => {
      const telemetry = result.telemetry_data;
      updateBatteryChart(telemetry);
      updateCpuChart(telemetry);
      updateFreqChart(telemetry);
      updateMemoryChart(telemetry);
      updateFrameDropChart(telemetry);
    })
    .catch(err => console.error('❌ Telemetry fetch failed:', err));
}

function chartOptions(yLabel, latestTime, stepSize) {
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
        ticks: { precision: 0 }
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


