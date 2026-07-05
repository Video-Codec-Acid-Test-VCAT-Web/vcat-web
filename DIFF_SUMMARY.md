# Diff Summary

Changes vs. the original repo baseline. Themes: (A) **multi-app support** — vcat_web now
supports both **vcat-d** (`com.roncatech.vcat`) and **vcat-ai** (`com.roncatech.vcat_ai`)
via a far-left app-tab UI, and no longer relies on a fixed on-device data folder;
(B) **extended live telemetry** (GPU/NPU/thermal/frame-stats) collection and export; and
(C) **vcat-ai log-file telemetry viewing** — open a vcat-ai log into its own chart tab,
with vcat-ai-specific data model, AI processing-time series, and a temperature graph on
both apps. (A and B are committed in `4fa2a5b`; C is the current change.)

---

## A. Multi-app support & folder discovery

### Problem addressed
- The on-device data folder was renamed (`vcat` → `vcat-d`) and is now user-selectable
  with no root access, so the old hard-coded `/sdcard/Vcat` and `/sdcard/vcat/test_results`
  paths matched nothing → playlists/logs stopped showing.
- vcat_web only knew about one app; vcat-ai needs first-class support.

### `vcat_adb.py`
- `BROADCAST_COMMANDS`: added
  - `log_http_port_ai` → `com.roncatech.vcat_ai.ADB_LOG_HTTP_INFO`
  - `log_root` → `com.roncatech.vcat.ACTION_LOG_ROOT`
- `_resolve_http_server()`: shared helper — clears logcat, sends the app's
  `ADB_LOG_HTTP_INFO` broadcast, then polls logcat for `HTTP server @ <ip>:<port>`.
  (Clears first + polls because the app logs asynchronously, under different tags for
  vcat-d vs vcat-ai, and both must be disambiguated.)
  - `get_device_ip_and_port()` → vcat-d (refactored to use the helper)
  - `get_ai_device_ip_and_port()` → vcat-ai (separate cache key so ports don't collide)
- `get_device_root_folder()`: resolves the user-chosen vcat-d data folder by broadcasting
  `ACTION_LOG_ROOT` and scraping the `CommandReceiver`-tagged
  `root_folder=<path> (uri=...)` line from logcat. Cached per device.
- `list_installed_packages()`: returns installed packages via `pm list packages`.

### `vcat_telemetry.py`
- **No-cache headers**: `SEND_FILE_MAX_AGE_DEFAULT = 0` + an `after_request` that sets
  `Cache-Control: no-cache, no-store, must-revalidate` (+ Pragma/Expires) so UI changes
  always take effect on reload.
- `VCAT_APP_PROFILES`: single source of truth for the two builds (id/label/package).
- New endpoints:
  - `GET /api/device/vcat_apps` — which VCAT builds are installed (drives the app tabs).
  - `GET /api/device/root_folder` — resolves the vcat-d data folder (see above).
  - `GET /api/device/ai_device_info` — resolves the vcat-ai HTTP server, proxies
    `GET /api/device_info`, and injects the resolved `ip_addr`.
- `test_results_files`: now uses `ls -l` to return **file size**; returns
  `{path, filename, date, size}` and the timestamp regex was generalized to `(\d{10,})`
  so it parses both `logs_<ts>.csv` (vcat-d) and `vcatai_log_<ts>.csv` (vcat-ai).

### `static/index.html`
- **Far-left app rail**: the entire existing UI is wrapped as the **vcat-d** panel; a new
  **vcat-ai** panel added; `#app-rail` gets one tab per installed app.
- **Connect (Go Live)** button moved out of the global top bar into the vcat-d device
  toolbar (top bar now holds only the device dropdown).
- vcat-d **Playlists / Test Results** converted to full-width sub-tabs; Test Results is a
  file-explorer **table** (Name / Date / Size).
- vcat-ai panel: **Device Details** + **AI / Accelerators** cards side-by-side, plus
  **Tests / Test Results** sub-tabs mirroring vcat-d.
- List scroll containers tagged `list-scroll` (JS-sized to fill to ~15px from viewport
  bottom; only the list scrolls, not the page).

### `static/main.js`
- `setupAppTabs()` / `showAppTab()`: detect installed apps (on **device selection**, not
  connect) and render the far-left tabs; vcat-d is the full UI, vcat-ai its own panel.
- `getDeviceRootFolder()` (cached): playlists/test-results paths are now built from the
  resolved root instead of hard-coded; playlist entries show basename only.
- vcat-ai: `loadAiDeviceInfo()` (maps `/api/device_info` incl. `AI_CPU_PART_MAP`,
  `fmtGB`), `loadAiTests()`, `loadAiTestResults()`, `showAiSubTab()`.
- Shared helpers: `renderTestResultRows()`, `openTestResultMenu()` (Open / Download as
  CSV|Excel), `fmtFileSize()`, `showDeviceSubTab()`.
- `sizeScrollAreas()` + resize handler for the fill-to-bottom scroll behavior.

### `static/style.css`
- New styles: `.app-rail` / `.app-rail-btn`, `.ai-pane`, `.subtab-btn` / `.subtab-panel`,
  `.file-table` (packed columns, sticky headers, tight rows), `.ai-detail-row` /
  `.ai-detail-col` / `.ai-detail-box`, `.under-construction`.

---

## B. Extended telemetry (GPU / NPU / thermal / frame-stats)

### `vcat_telemetry_data_models.py`
- New dataclasses `ThermalStatus` and `GpuFrameStatsEntry`; `TelemetryData` gains
  `gpu_usage`, `npu_usage`, `gpu_frame_stats`, `thermal_status`.

### `vcat_telemetry.py`
- Collectors: `get_gpu_stats()` / `get_npu_stats()` (sysfs probes per vendor),
  `get_gpu_frame_stats()` (`dumpsys gfxinfo <pkg> framestats`, per-device vsync cursor),
  `get_thermal_status()` (`dumpsys thermalservice`).
- `telemetry_worker()` collects and appends these each poll; `build_telemetry_response()`
  exposes them; `resetTelemetry()` clears the vsync cursor.
- `get_test_details()` hardened against missing IP / null `currentTestVideo`.

### `vcat_telemetry_writer.py`
- New Excel sheets + headers: **GPU Usage**, **NPU Usage**, **GPU Frame Stats**,
  **Thermal Status**, with matching export rows.

### `vcat_config.py`
- Added `VCAT_PACKAGE` config key (default `com.roncatech.vcat_ai`).

---

## C. vcat-ai log-file telemetry viewing

### Data model (`vcat_telemetry_data_models.py`)
- `TelemetryData` renamed to **`VcatdTelemetryData`** (annotations updated across the
  reader and `vcat_telemetry_writer.py`).
- New **`ProcTimeNs`** entry (`elapsed_time`, `value_ns`) — `FramedropEntry`-style.
- New **`VcataiTelemetryData`** type: common series (battery, cpu freq/usage, memory) +
  `system_thermal_status` + AI series `frameProcTime` / `infTimeNs` / `infCpuTimeNs`
  (each `list[ProcTimeNs]`); no frame-drops. Factory `make_empty_ai_telemetry_data()`.
- `TestConditions.from_dict()` made tolerant of a missing/empty `test_conditions` block
  (vcat-ai logs omit it; was `KeyError: 'runLimit'`).

### Reader (`vcat_telemetry_reader.py`)
- `read_ai_telemetry_data()` — separate loader reusing the shared low-level field parsers
  but expecting vcat-ai columns; parses `transform.frame_proc_time_ns`,
  `transform.inference_time_ns`, `transform.inference_cpu_time` (missing → 0, row-aligned).
- `_read_system_thermal()` parses `system.thermal_status` (0–5); both loaders now populate
  `system_thermal_status`.

### Server (`vcat_telemetry.py`)
- `build_ai_telemetry_response()` — vcat-ai response (common series + AI proc-time series);
  `build_telemetry_response()` extended with `battery_temp` + `system_thermal` (guards a
  non-list `system_thermal_status` from the live path).
- `/api/vcat_monitor/telemetry_from_file?app=vcat_ai` dispatches to the AI reader/builder.

### Frontend (`static/*`)
- vcat-ai panel is now a real tab area (`#ai-tab-header` / `#ai-tab-content`): a **Device**
  tab plus dynamically-opened **log-file chart tabs** (closable), own `.ai-tab-btn` /
  `.ai-tab-pane` classes.
- `openAiLogFile()` opens a log into a chart tab (CPU / Freq / Memory / Battery) built from
  the shared template **minus the frame-drop chart**; wired to the Test Results "Open" via
  a new `opener` param on the shared `renderTestResultRows` / `openTestResultMenu`.
- **AI Processing Time (ms)** chart (`updateAiProcChart`) plots the three proc-time series
  (ns → ms).
- **Temperature** chart (`updateTempChart`) on both apps' log-file views: battery temp (°C)
  + system thermal (0–5) normalized so 0→0 and 5→top of graph. Added via `makeChartWrapper`
  (vcat-ai) / `injectTempChart` (vcat-d file view), leaving the vcat-d live tab untouched.

## ⚠️ Notes before pushing

- **Debug timing values** are currently in place and should likely be reverted:
  - `vcat_config.py`: `DEVICE_POLL_INITIAL` and `DEVICE_POLL_STEADY` set to `2` (were
    10/30), `TELEMETRY_LOOP_POLL_INTERVAL` set to `2` (was 10).
  - `vcat_telemetry.py`: `console_cleanup_loop()` sleep set to `2s` (was 60s).
- **vcat-ai data folder is hard-coded to `/sdcard/vcat-ai`** — vcat-ai does not yet answer
  an `ACTION_LOG_ROOT` broadcast. Once it does, swap `VCAT_AI_ROOT` in `main.js` for
  proper discovery (as done for vcat-d).
- **Package name inconsistency remains**: `is_vcat_running`, `launch_vcat`,
  `get_app_memory`, and the ADB broadcast still hard-code `com.roncatech.vcat`; only
  gfxinfo uses the `VCAT_PACKAGE` config. Route these through the active app profile when
  vcat-ai monitoring is built out.
- **Temperature graph is on the log-file views only** — the vcat-d **live** worker does not
  yet collect battery temp or system thermal, so the live tab has no temperature chart.
- **`transform.inference_cpu_time`** older logs stored tiny values (non-ns); newer logs use
  ns. Missing/unparseable values render as 0.
