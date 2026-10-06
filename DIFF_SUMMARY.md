# Diff Summary

Changes vs. the original repo baseline. Themes: (A) **multi-app support** — vcat_web now
supports both **vcat-d** (`com.roncatech.vcat`) and **vcat-ai** (`com.roncatech.vcat_ai`)
via a far-left app-tab UI, and no longer relies on a fixed on-device data folder;
(B) **extended live telemetry** (GPU/NPU/thermal/frame-stats) collection and export; and
(C) **vcat-ai log-file telemetry viewing** — open a vcat-ai log into its own chart tab,
with vcat-ai-specific data model, AI processing-time series, and a temperature graph on
both apps; and (D) **non-live UX** — filesystem folder scan (view logs without the app
running), Launch controls + app-running gating, device-info refresh after launch,
scrollable vcat-ai Test Details, Grid/Focus view modes, and logo/background theming; and
(E) **vcat-ai live monitoring** — hybrid ADB-worker + log-file live session, mutually
exclusive with vcat-d; and (F) **live charts read from the log file** for both apps
(frame-drops API removed; mixed CPU chart = log total + polled per-core); and
(G) **save/load session snapshots** — snapshot a live session to a CSV (with per-core CPU)
and reopen any session CSV without a device; and (H/I/J) **resilience & session control** —
device-disconnect/crash recovery, a Connect/Disconnect-only model, and a snapshot CPU/GPU
round-trip fix; and (K) **usable with no device attached** — open local files, same-origin
API, content-based app detection; and (L) **unit consistency** — memory in KB, battery in
percent; and (M) **log-format compatibility** with vcat-d ≥ 3006 (object `playlist`,
`execution_id`); and (N) **result comparison** — N logs side by side, one row per metric;
and (O) **exports** — PDF report and per-hour `.xlsx` from any view; and
(R) **device-folder discovery fix** — the `/sdcard` scan now works on any folder name; and
(S) **per-cluster CPU frequency** — large and small cores on separate graphs; and
(T) **richer spreadsheet** — stacked sheets (System Health), CPU-cluster and frame-drop
sheets, and one verbatim sheet per source log; and (U) **runs labelled by decoder** rather
than codec family; and (V) **audioClock** in Test Details; and (W) **dropped_to_keyframe**
on the frame-drops graph; and (X) **device identity pinned** in the comparison header; and
(Y) **live-session UX** — ramped polling and Disconnect on the live tab; and
(Z) **standalone HTML export** — N logs in one self-contained interactive file.
(A/B → `4fa2a5b`; C → `237b96a`; D → `61898ff`; E → `038ea4a`; F → `233d5d3`;
G → `72f3786` (+ `1acbfdb`); H → `5ff0c88`/`36cfcd3`; I → `072d296`; J → `d4a15aa`;
K–Q → `3be5654`/`025ab30`/`13a6dca`; R–Z are the current change.)

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

## D. Non-live UX, folder scan, launch controls, view modes

### Folder discovery via filesystem scan (no app running needed)
- `vcat_adb.scan_vcat_data_folders()` + `GET /api/device/scan_folders`: locate each
  app's folder by finding a `test_results` subdir with its log files
  (`vcatd_log_*` / `logs_*` → vcat-d, `vcatai_log_*` → vcat-ai) via `find`, always also
  probing the defaults `/sdcard/vcat-d` and `/sdcard/vcat-ai`. **Log viewing no longer
  requires the app to be running.**
- Frontend `getScannedFolders()` / `getAppRoot()` (cached, deduped) replace the broadcast
  (`getDeviceRootFolder`) and the hard-coded `VCAT_AI_ROOT` for all four listings.
- vcat-d test-results glob changed to `*.csv` so the new `vcatd_log_*.csv` names list
  (timestamp still parsed via `(\d{10,})`).

### Launch controls + app-running gating
- `is_vcat_running` / `launch_vcat` + endpoints now take `?app=` (→ package via
  `_package_for_app`). vcat-d & vcat-ai toolbars each have a **Launch** button
  (`btn_launch_vcat.png`): Launch enabled only when the app is stopped; Connect / Run
  Config / Console enabled only when running (`updateVcatdToolbar` / `updateAiToolbar`,
  `handleLaunchClick` / `handleAiLaunchClick` poll until up).
- vcat-ai **Console** button wired (`openConsoleModal`); Connect / Run Config still pending
  vcat-ai HTTP-API decisions (live monitoring).

### Device info after launch
- `get_device_info(..., refresh=)` + `/api/device/info?refresh=1`: bypasses caches so the
  IP (reported by the app's broadcast→logcat, only available once running) refreshes after
  launch. IP now sourced from the broadcast when running, `wlan0` fallback otherwise.
- IP display keeps the **port** (`formatIpAddr`) — both apps bind `0.0.0.0`, so the port is
  the distinguisher.

### vcat-ai Test Details
- `SessionInfo.test` carries the raw log-header `test` object; `build_ai_telemetry_response`
  emits it as `ai_test`. Frontend `renderAiTestDetails()` renders the nested tree in a
  **scrollable** `.ai-test-details` panel (`TestConditions.from_dict` already tolerant).

### Grid / Focus view modes (per telemetry tab)
- Toggle in the telemetry toolbar. **Focus** = one large "stage" chart + a scrollable
  left filmstrip of thumbnails (name on hover); click to promote, ↑/↓ to cycle.
  Re-parents chart wrappers (Chart.js instances survive + `resize()`), per-tab state in
  `viewStateByTabId`. Focused Test Details fills the stage height (`:has()` CSS).

### Cosmetic
- App-rail tabs are now logo buttons: `VCAT_Logo_tnsp.png` → `vcat_d_logo.png`,
  `vcat_ai_logo.png`, transparent so the (transparent-PNG) logos aren't lost; active tab =
  border highlight. Page background uses `background.png` instead of the orange gradient.

## E. vcat-ai live monitoring

The two apps can't run together, so connecting one stops the other. vcat-ai has no
live-metrics HTTP endpoint, so its live data is a hybrid: **ADB (worker)** for what the
app can't self-report (per-core CPU, + freq/mem/battery), and the **active log file** for
AI processing-time + temperature + test info.

### Backend (app-aware monitor)
- `VcatdTelemetryData.app` tags the live session; `resetTelemetry(..., app=)` uses the
  app's IP source and skips the frame-drop reset for vcat-ai.
- `/api/vcat_monitor/start?app=vcat_ai`: **mutual exclusion** — stops any different-app
  session on the device and `am force-stop`s the other package; launches the right package
  via `_package_for_app`; refreshes device info.
- `telemetry_worker` branches on `app`: vcat-ai skips the HTTP test-status call and
  frame-drops and reads app-memory from `com.roncatech.vcat_ai`.
- `/api/vcat_monitor/connected` reports the session's `app`.

### Frontend
- vcat-ai **Connect** → confirm-and-tear-down vcat-d if live → `start?app=vcat_ai` →
  **Live Session** tab in the vcat-ai panel, polling every 5s:
  worker telemetry → CPU (per-core) / Freq / Memory / Battery; active log
  (`telemetry_from_file?app=vcat_ai`, newest `vcatai_log_*.csv`) → Temperature / AI
  Processing Time / Test Details. **Disconnect** stops the poll + monitor and closes the
  tab. Symmetric guard when connecting vcat-d while vcat-ai is live
  (`stopAiLive` / `stopVcatdLive`).

### Fix
- Reader now reads `transform.inference_cpu_time_ns` (the column gained an `_ns` suffix;
  older `transform.inference_cpu_time` kept as fallback) — Inference CPU was reading 0.

## F. Live charts read from the log file (both apps)

The `/api/telemetry/framedrops` API model is removed — live per-frame/system data now
comes from the log (the app's source of truth), matching the file-open views.

### Backend
- Removed `get_frame_drops()` (+ dead `get_framedrop_stats()`), the worker's frame-drop
  collection, and `resetTelemetry`'s `/api/telemetry/reset_framedrops` call.

### Frontend
- Both live loops now render **CPU freq, memory, battery, frame drops (vcat-d) /
  temperature + AI proc time + test info (vcat-ai)** from the active log file (full test
  history, so all timelines match). The worker poll just keeps the session alive
  (reserved for GPU/NPU).
- **Mixed CPU chart** (`updateMixedCpuChart`): Total CPU from the log (full history) +
  per-core from the ADB worker (starts at connect), with per-core shifted onto the log's
  timeline (`offset = latest-log-elapsed − latest-worker-elapsed`) so they align. Used by
  both live tabs; file-open views keep `updateCpuChart`.
- `getActiveAiLog` generalized to `getActiveLog(deviceId, appId)`.

## G. Save / load session snapshots

Snapshot a live session to a CSV (the app log + per-core CPU columns the app can't log),
and reopen any session CSV later — no device required.

### Backend
- `save_live_session()` + `POST /api/vcat_monitor/save_session`: pulls the active log and
  injects `cpu.usage.<core>` columns from the live per-core ADB series (nearest sample per
  log row, aligned by elapsed; pre-connect rows left blank). Non-destructive — the session
  keeps running. Saves to `~/Downloads/<log>_snap_<ts>.csv`.
- `POST /api/vcat_monitor/upload_session`: store a browsed CSV so it can be opened.
- `GET /api/vcat_monitor/load_saved` (**no device**): read a host CSV, infer app from the
  filename, return telemetry. `telemetry_from_file` also gained `saved=1`.
- The reader's `cpu.usage.<n>` support round-trips these per-core columns back to `cpu<n>`.

### Frontend
- Top-level image buttons next to **Device** (peers, boxless): **Save Snapshot**
  (`btn_save_snapshot.png`) and **Load Snapshot** (`btn_load_snapshot.png`).
- **Load** = browse to a CSV → upload → `loadSavedSession()` reveals the UI (no device
  needed), `ensureAppTab()` adds the rail tab, and opens the matching app viewer with
  per-core CPU shown. Save/open paths (`handleConnectClick`, `openAiLogFile`) are now
  device-optional / `saved`-aware.
- `updateSnapshotButtons()` enables **Save** only while a live session is active; **Load**
  is always enabled. (Session termination is covered in section I.)

## H. Device-disconnect & crash resilience

A DUT can drop mid-session (thermal shutdown, unplug) or the server itself can die.
Both cases now preserve the in-progress session data instead of losing it.

### Device disconnect (server)
- `_disconnected_devices: set` tracks devices that dropped mid-session.
- The telemetry worker checks `vcat_adb.is_valid_device(...)` per device before polling;
  on failure it logs once, adds the device to `_disconnected_devices`, and skips it. When
  **all** monitored devices are disconnected the worker breaks (stops the thread).
- `GET /api/vcat_monitor/telemetry` now returns `disconnected: true` for such devices.
- `POST /api/vcat_monitor/save_session` is device-optional: if a live temp file exists it
  copies that (works after the device is gone), deriving the snapshot name from stored
  session state; the old log-pull path remains as a fallback. `/stop` also clears
  `_disconnected_devices`.

### Device disconnect (frontend)
- Both live polls (vcat-d `fetchAndUpdateTelemetry`, vcat-ai poll) detect `disconnected`
  and call `onDeviceDisconnected(app, deviceId)` — halts both poll loops, offers to save a
  snapshot (server-side temp copy), then `/stop`s and tears down the app's live UI. Guarded
  by `_disconnectHandled` so it fires once.

### Crash / orphan recovery
- A clean `/stop` deletes its temp file, so any surviving `vcatweb_session_*.csv` in the
  temp dir is an orphan from an unexpected exit.
- `GET /api/vcat_monitor/orphan_sessions` lists orphans not owned by an active session
  (name, device_id, size, mtime). `POST /api/vcat_monitor/recover_orphan?file=…` copies the
  orphan to `~/Downloads/recovered_<device>_<ts>.csv` and deletes it, or `&discard=1` just
  deletes it. Both guard against path traversal (basename must match the prefix).
- Frontend `checkOrphanSessions()` runs once at startup (after the session token): if
  orphans exist it prompts to recover them all to Downloads (or discard).

## I. Session-control model (Connect / Disconnect only)

Consolidated a confused Connect/Disconnect/Reset scheme. **Reset Telemetry did the same
thing as Disconnect** (both stop the server worker, discard state, and invalidate the
session) — it was just Disconnect with a save prompt — so it was removed. One live session
per device, one app at a time.

- **Reset button + modal removed** (`btn_reset_telemetry`, `#reset-modal`, and
  `openResetModal`/`confirmReset`/`closeResetModal`). `resetTelemetry()` is now unused.
- **Disconnect = confirm → offer snapshot → terminate** via `confirmTerminateSession()`.
  First a native confirm ("Disconnect …?"), then a 3-button styled modal
  (`#save-choice-modal`, `askSaveChoice()`/`resolveSaveChoice()`): **Save / Discard /
  Cancel** — Cancel is the last chance to abort the disconnect; a failed Save keeps the
  session so nothing is lost. Wired to both app Disconnect buttons (`handleDisconnectClick`,
  `promptAiDisconnect`); the actual teardown is still `stopCurrentLiveSession()`.
- **Hot-plug device polling**: `syncDeviceList()` polls `/api/all_connected_devices` every
  5 s (`_deviceListInterval`) and reconciles the dropdown — adds newly connected devices,
  removes vanished ones (never the current selection or a live-session device), and
  auto-selects the first when the list goes from empty to non-empty. `populateDeviceDropdown`
  now does the initial `syncDeviceList(true)` then starts the interval; `showNoDeviceUI()`
  toggles the overlay.
- **Changing the device while live** runs the same confirm/save/terminate against the
  *old* device, then commits the switch; Cancel (or a failed save) reverts the dropdown to
  the previous device (`handleDeviceSelection`, `_lastDeviceValue`).
- **One app at a time by disabling**, not silent switching: while one app is live the other
  app's **Connect** is disabled (`refreshConnectAvailability()`, called from
  `updateSnapshotButtons()` and `setDeviceConnectionState()`). The old
  "disconnect-the-other-and-switch" confirms were replaced by a guard alert.

## J. Snapshot CPU/GPU round-trip fix

Loading a saved vcat-ai snapshot showed **zeroed CPU and Processor charts**. Four bugs in
the round-trip:

1. **Per-core CPU columns were frozen out.** `_worker_extra_columns` derived core keys from
   `usage_pct`, which is empty on the first `/proc/stat` read (no delta yet); the column set
   is fixed at session start, so `cpu.usage.<core>` was never written. Now derived from
   `raw_stats` (populated on the first read).
2. **The snapshot kept the app's `cpu.usage.total`** (a different scale) instead of the ADB
   total the live view uses. `_merge_extra` now overwrites `cpu.usage.total` with the ADB
   `cpu` series and adds the per-core columns in one merge.
3. **The reader ignored `gpu.usage`.** `vcat_telemetry_reader._read_gpu_usage()` now parses
   it into `telemetry.gpu_usage`; `gpu_usage` added to `VcataiTelemetryData` +
   `build_ai_telemetry_response`.
4. **The load path never drew the Processor chart** and the worker-charts bailed with no
   `workerTel`. `openAiLogFile` now calls `updateProcessorChart(telemetry, null, tabId)`,
   and `updateProcessorChart` falls back to the file's own `cpu_usage`/`gpu_usage`
   (already on the log timeline, so offset = 0).

Snapshots taken *before* this fix still lack per-core CPU and carry the old
`cpu.usage.total`; GPU now round-trips for them, but full CPU requires a fresh capture.

## K. Open local files without a device

vcat_web was effectively unusable with nothing attached: the load path existed but was
unreachable/unstable.

### `static/main.js`
- **`API_BASE = window.location.origin`** (was a hard-coded `http://localhost:5050`), so
  `--host`/`--port` actually work. Under a custom port every request went cross-origin to a
  dead address — no session token, no devices, nothing.
- **`openedFileTabs`** (a `Set` of tabs opened from a file) + `showNoDeviceUI()` now only
  hides the UI when that set is empty. The 5 s `syncDeviceList()` poll called
  `showNoDeviceUI(true)` whenever `adb devices` was empty, which hid `#tab-header` /
  `#tab-content` — a locally-opened log vanished seconds after loading.
- `reportFileLoadFailure(tabId, message, fileName)`: a load that fails now alerts with the
  reason and removes the empty tab. Both file paths previously `console.error`'d and left a
  blank tab (this is what surfaced the `playlist`-object bug in § M).
- `closeTelemetryTab()` looked up `getElementById(tabId)` instead of `` `${tabId}-tab` ``, so
  closing a tab leaked its pane into the DOM.
- App type comes from the server (§ below) rather than `name.includes("vcatai")`.

### `vcat_telemetry.py`
- `_uploads_dir()`: browsed files stage in a temp dir. `upload_session` previously wrote into
  `~/Downloads`, so opening `~/Desktop/logs.csv` silently overwrote an unrelated
  `~/Downloads/logs.csv`.
- `_resolve_saved_file(name)`: resolves by name across the uploads dir then the saved-sessions
  dir (still `basename`-guarded).
- `_detect_app_from_file(path, fallback_name)`: vcat-d vs vcat-ai from the CSV column header
  (`_AI_ONLY_COLUMNS` — the `transform.*` series only vcat-ai logs carry), capped at
  `_HEADER_SCAN_LINES`. Filename is only a fallback, so a log can be named anything.
  Used by `load_saved`, `upload_session` (returns the detected `app`) and
  `telemetry_from_file`.

### `static/index.html`
- The no-device overlay now offers **Open Local File…** instead of only
  "connect a device and try again".

---

## L. Unit consistency: memory in KB, battery in %

Two fields meant different things depending on whether the data came from the ADB worker or
from a log, and both were mislabelled in the UI.

- **Memory.** `/proc/meminfo` and `dumpsys meminfo` report **KB**, but the app logs
  `test.memory.system` / `test.memory.vcat` in **bytes** (and the reader passed the raw
  string through). `MemoryEntry.used_kb` is KB, so `vcat_telemetry_reader._bytes_to_kb()`
  converts (and parses to `int`) on the way in. The chart's `/1024` → MB is now right for
  loaded logs too; it was showing KB labelled MB (`8,000,000 MB`).
- **Battery.** The app logs `battery.level` as a **0–1 fraction**; `dumpsys battery` gives
  **0–100**. `_fraction_to_percent()` scales the logged value, and `chartOptions` pins any
  percentage axis (`isPercentChart`: CPU *and* Battery) to 0–100.
- `vcat_telemetry_writer`: the Memory sheet header listed **four** columns
  (`Total KB, Used KB, App KB`) for the three actually written, so system memory landed under
  "Total KB" and app memory under "Used KB". Now `Elapsed Time (s), System Used KB,
  App Used KB`. (`Total` had no source — the worker discards the total.)
- Removed a dead `appMap` built from `a.app_kb`, a field the API never emits.

---

## M. Log-format compatibility (vcat-d ≥ 3006)

Loading a log from a newer vcat-d failed outright with
`(fullPath || "").replace is not a function`.

- **Cause.** `session_info.playlist` changed from a string to an object
  (`{"id": …, "name": "av2-1080p30.xspf"}`). It reached the browser as an object and
  `getFileName()` threw on the first line of the render, aborting the whole load.
- `vcat_telemetry_data_models.playlist_ref(value)` → `(name, id)` for **either** shape, with
  `playlist_name()` on top. Keyed on the **shape, not `header_version`** — a pre-release
  build was already emitting the object under 3004, so version-gating would have missed it.
- `SessionInfo` gained `playlist_id` and `execution_id` (both `""` for older logs).
  `execution_id` is a root-level key, so `parse_json_header()` now returns it as a 5-tuple
  and `SessionInfo.from_dict(d, execution_id="")` takes it. Both flow into
  `session_info.to_dict()`, so the Excel SUMMARY sheet records which execution it came from.
- The **live** path (`fetch_test_details`) goes through the same helper — the device's
  `/test_details` response carries the same new shape.
- `getFileName()` coerces with `String()` instead of assuming a string, so the next
  device-side change degrades to a wrong-looking label rather than killing the load.

Verified across old (string playlist), pre-release (object under 3004), synthetic 3006/3010,
missing/null playlist, and id-only playlist. No version ceiling anywhere (the only check is
`header_version < 2`).

---

## N. Result comparison (N logs side by side)

A new comparison tab renders 2+ logs' charts in one grid, **one row per metric**, so
scrolling walks CPU vs CPU, Frequency vs Frequency, …

### Structure
- `compareStateByTabId[tabId] = {sources[], sides[], data[]}`; each side is a normal
  telemetry pane built under its own tabId prefix (`<cmp>-A`, `-B`, `-C`, …), so every
  existing `update*Chart(telemetry, tabId)` and `chartsByTabId` lookup works unchanged.
- `renderFileTelemetry(tabId, app, data)` was extracted from the two file-load paths and is
  now shared by them *and* by each comparison column — a compared pane is built by exactly
  the same code as a standalone one.
- `buildCompareSide()` clones the telemetry template into `.cmp-staging` (absolute, 0×0,
  `overflow:hidden`) so canvases get a real width before being moved;
  `interleaveCompareGrid()` then groups the wrappers by `<h3>` title into the shared grid
  (placeholder cell if a log lacks a metric). Per-side toolbars, Focus containers and
  player controls are stripped (Play/Stop act on the live device).
- **Compare To…** picks another log (device-file modal or local browse). On a single-log tab
  it starts a comparison; on a comparison tab it **appends a column**, handing over the
  already-loaded payloads so only the new log is read, and retires the tab it grew out of.
- Cross-app pairs are refused (vcat-d vs vcat-ai record different metrics).

### Layout
- `applyCompareColumns()` sets `repeat(N, minmax(COMPARE_MIN_COL_PX, 1fr))` (420 px) on both
  the grid and the sticky header bar, so beyond ~3 logs it **scrolls horizontally** with the
  columns and their headers staying aligned.
- The pane scrolls internally (`.compare-scroll`, sized by `sizeCompareAreas()`): a global
  `html, body { overflow-y: auto }` means a sticky header in the document flow never pins.
  Column headers live in their own sticky bar because a sticky *grid item* is confined to its
  own row.
- **Align axes** (default on): `applyCompareAlignment(sides, on)` gives every column of a
  metric one shared x/y range; off restores each chart's own scaling (`_cmpOwnScale`).
  `rescaleNormalized()` handles the Temperature chart, whose thermal series is normalized
  against its own y max and so must be rescaled with the axis, not just widened.

---

## O. Exports: PDF and spreadsheet

Both are available on a **single-log** panel and on a comparison, driven by one
`exportContextFor(tabId)` that returns `{sources, sides, data}` for either.

### PDF (`jsPDF` UMD, same CDN as Chart.js)
- Cover page: a matrix — field labels down the left, one column per run (codec, input
  resolution/frame rate, decoder, device, SoC vendor/name, Android, vcat version, playlist,
  duration, execution id, log file) from the shared `runFieldRows()`.
- Then one row per metric, one column per log, exported from the live canvases (so the
  shared axes are whatever is on screen). `pdfActivateFinalTooltip()` parks each chart's
  tooltip on its **last sample** before rasterising, so end-of-run values are readable
  without the axes; it's restored in a `finally` so no tooltip is left stuck on screen.
- **Size**: was ~22 MB. Three causes, all fixed — `compress: true` (jsPDF wrote page streams
  raw), a re-rasterise capped at `PDF_IMG_WIDTH` 900 px (a retina canvas has a 2× backing
  store), and JPEG at `PDF_JPEG_QUALITY` 0.82 instead of PNG for dense line art. Now
  ~230–310 KB with the charts still crisp.
- **`PDF_MAX_COLUMNS = 2`**: past two logs the columns are too narrow to read, so the button
  disables itself (with an explanatory tooltip) and `exportTabPdf()` refuses. Use the
  spreadsheet for more.

### Spreadsheet (`.xlsx`, openpyxl — already a dependency)
- `POST /api/vcat_monitor/comparison_workbook` → `write_comparison_workbook()`. The client
  resamples and posts the small tables, so nothing is re-read and it works for
  device-sourced and local logs alike. No device required.
- **One sheet per metric** — `Battery Level` and `Temperature` (battery °C) — each with the
  `runFieldRows()` block in the cells **above** the table, then `Hour` in column A, one
  column per log, and a ready-made line chart (`_write_metric_sheet()`). A metric no log
  recorded is skipped rather than written empty. A final `About` sheet records the rules.
  Temperature is the reading *at* the hour mark, not an hourly average.
- `buildHourlyTable()`: for each whole hour the reading **nearest that hour mark** within
  ±30 min (`sampleNearest`), else blank. Hours run to `ceil(longest span)` so the
  longest-running test sets the axis and its final reading is included — `floor` truncated a
  5.9 h run to hour 5 and dropped its end state. Trailing rows blank for *every* log are
  dropped. A shorter log's cells stay **blank, not 0**, which would plot as a drop to zero.
- `comparisonSeriesLabels()`: columns are identified by **codec** (`video/av02` → `AV02`),
  not filename. Clashing codecs are separated by the first field that tells them apart
  (decoder → frame rate → resolution → input file), else `(A)`/`(B)`. `exportStem()` keeps
  filenames sane for any number of logs.

---

## Q. Live temperature from ADB

The Temperature graph existed only on the log-file views and on vcat-ai live (which reads
it from the log) — a **vcat-d live** session had no temperature at all, because the worker
collected neither battery temp nor the thermal status.

### `vcat_adb.py`
- `get_battery_status(device_id)` → `(level %, temperature °C)` from **one** `dumpsys
  battery` (temperature is reported in tenths of a degree). `get_battery_level()` is kept
  as a thin wrapper.

### `vcat_telemetry.py`
- `parse_thermal_dumpsys(out, elapsed)` → `(per-zone ThermalStatus | None, overall 0–5
  status | None)`, split out of `get_thermal_status()` so it can be tested without a
  device. One `dumpsys thermalservice` call now yields both; the `Thermal Status:` line is
  matched wherever it appears, and the parser takes the **Current temperatures from HAL**
  block rather than the `Cached temperatures` block printed above it.
- `telemetry_worker()` fills `BatteryEntry.battery_temp` and appends
  `SystemThermalStatus` entries, so `build_telemetry_response` emits the same
  `battery_temp` / `system_thermal` series the file views use.
- The live Battery sheet row is now `[elapsed, level, None, None, temp]` — it was
  `[elapsed, level]` against a five-column header, so temperature would have landed in the
  charge-counter column.

### `static/main.js`
- `fetchAndUpdateTelemetry()` injects the Temperature chart on the first poll
  (`injectTempChart` is idempotent — the canvas isn't in the template) and draws it from
  the **worker** payload, not the log, so it appears regardless of what the app is logging.

Charted series are battery °C plus the normalized 0–5 status, matching the log-file view so
the comparison grid still pairs the two by title.

---

## P. Smaller fixes

- **Tooltip elapsed time**: hover text shows the raw x value *and* a clock form —
  `18641.241 (5:10:41.241)` — via `formatElapsedRaw()` / `formatElapsedClock()` and a
  `plugins.tooltip.callbacks.title` on `chartOptions()`. Resolves x from `parsed.x` with an
  `item.label` fallback, since some charts use `labels` + numeric arrays and others `{x, y}`.
- **Test Details clipping**: `.test-video-row input` / `.test-details-top input` had no width
  rule, so they used the browser default (~20 chars ≈ 129 px) inside a 461 px fieldset —
  long decoder/file/timestamp strings were cut. Now `flex: 1 1 auto; min-width: 0`, giving
  335 px in the single view and ~600 px in a comparison column.
- `run_info` added to both response builders (device, SoC vendor/name, Android, vcat version,
  playlist + id, execution id) — the metadata source for both exports.

## R. Device data-folder discovery (`/sdcard` scan)

### Problem addressed
A device whose vcat-d folder was named `vcat` (the pre-rename name) showed up in the UI
with no telemetry files at all, while vcat-ai on the same device worked.

### Root cause
`/sdcard` is a symlink to `/storage/self/primary`, and toybox `find` does not follow a
symlink given as the **starting path**. So `find /sdcard -maxdepth 6 -type d -name
test_results` returned nothing on-device, and `scan_vcat_data_folders()` fell back to its
hard-coded defaults — which listed `/sdcard/vcat-d` and `/sdcard/vcat-ai` but not
`/sdcard/vcat`. vcat-ai matched a default and worked; vcat-d did not and vanished.

### `vcat_adb.py`
- `find /sdcard/` (trailing slash) — makes `find` resolve the symlink and descend. This is
  the actual fix and works for **any** folder name, not just the two defaults.
- `/sdcard/vcat` added to the fallback list, for devices where `find` is unavailable.

Verified on CPH2625: `vcat_d` resolves to `/sdcard/vcat/test_results` (128 logs).

---

## S. CPU frequency split into large / small cores

One frequency graph became two. "Small" is the **lowest-clocked cluster**; every other core
is large, so a three-cluster SoC groups mid and prime together.

### `vcat_telemetry.py`
- `_core_classes()` maps `core<N>` → `small`/`large` from each core's max clock, carried in
  `telemetry_data.core_classes`. Returns `{}` for a homogeneous CPU or a log header with no
  per-core block, so the client can fall back.

### `static/main.js`
- `splitCoreKeys()` prefers the server map and otherwise infers the split from the peak
  frequency each core reached. Core keys are matched on the **trailing index**: the live
  worker emits `core0…`, but a log's `cpu.freq0…` columns arrive as `freq0…`, so a
  name-equality lookup silently missed on every log file.
- `coreKeysOf()` takes the core list from the newest **populated** sample rather than the
  last one, so a truncated final row can't drop the whole series.
- A homogeneous CPU hides the small chart and retitles the other to plain
  "CPU Frequency (MHz)" rather than claiming a split that isn't there.

---

## T. Spreadsheet export: stacked sheets, new metrics, raw logs

### `vcat_telemetry_writer.py`
- A sheet entry may now be `{sheet, blocks: [{metric, unit, rows}, …]}` as well as the old
  single `{metric, unit, rows}`. `_write_metric_block()` returns a row cursor that clears
  the preceding chart (a 10 cm chart ≈ 20 rows), so stacked charts don't collide.
- `_write_raw_csv_sheet()` dumps a log verbatim: JSON header in column A (its commas would
  otherwise shred it across cells), then the table parsed into real columns with numbers
  stored as numbers. `_unique_sheet_title()` handles two logs sharing a file name.

### New sheets
- **System Health** (was "Temperature") — battery temperature above system thermal status,
  each with its own chart. Status is written as logged (0–5), not rescaled the way the
  on-screen chart normalises it against the battery axis.
- **CPU Frequency – Large / Small Cores** — the mean clock across that cluster at the hour
  mark. Cores are classified per log, so a comparison spanning two SoCs is still correct.
- **Frame Drops** — Frame Drops above Dropped to Keyframe.
- **One sheet per source log**, verbatim, after the charts.

### `vcat_telemetry.py`
- `_raw_log_sheets()` resolves each source **server-side** (saved file or `adb pull`) — the
  files already sit on the host, so there's no reason to round-trip CSV through the
  browser. An unresolvable source is skipped with a log line rather than failing the export.

### Frame Drops aggregates, every other sheet samples
`buildHourlySumTable()` **sums** each hour. A drop count is an event tally, not a level, so
the "reading nearest the hour mark" rule would report one arbitrary second as the hour. On
`logs_1765070594349.csv` the sum shows 760 of 769 drops in hour 4; sampling showed 0 there.
Hours past a log's end stay blank, not 0 — "no data", not "no drops". A block whose rows
are entirely null (e.g. `dropped_to_keyframe` on a pre-3004 run) is dropped rather than
written as a sheet of blank cells.

---

## U. Runs labelled by decoder, not codec family

`comparisonSeriesLabels()` now leads with `videoDecoder` ("vcat-dav1d-1.5.1") instead of the
uppercased codec family ("AV1"), which every AV1 decoder shares. Flows to chart legends,
PDF, spreadsheet column headers and export filenames at once. vcat-ai logs record no
decoder name, so those fall back to the codec family rather than "unknown". `codec` moved
to the front of the tie-break chain, since `decoder` — previously first — can no longer
disambiguate anything.

---

## V. `audioClock` in Test Details

`TestConditions.audioClock` is `Optional[bool]`, surfaced via `_test_conditions()` in both
response builders and shown as a Yes/No row in the panel.

Detected by **presence**, not `header_version >= 3004`, following the lesson already
recorded for the playlist object: a pre-release build can emit a field before the header
version that formalises it. A pre-3004 log reports `None`, **not** `False` — otherwise
every old run would read as "audio clock off" when the log simply never said — and the row
is hidden rather than shown blank.

---

## W. `dropped_to_keyframe` on the frame-drops graph

`FramedropEntry.dropped_to_keyframe` (`Optional[int]`, header 3004 on) plumbed through the
reader and `build_telemetry_response`, and drawn as a second series when any sample reports
a number. A log predating the column gets **one** line, not a flat zero implying none
occurred. Frame Drops is orange (`COLORS[4]`), Dropped to Keyframe red (`COLORS[0]`).

---

## X. Device identity pinned in the comparison header

Guessing which device a column came from was previously only possible from the file name.
`compareColumnHead()` now carries a Device / SoC / Android block, filled by
`fillCompareDeviceHead()` once payloads resolve (the bar is built before the logs are read).
It sits in `.compare-heads`, which was already `position: sticky`, so it stays on screen
while the chart rows scroll. Values come from `run_info`; nothing new was plumbed. Android
is recorded as a bare `"14 (32-bit)"`, so it is prefixed — with a guard against
"Android Android 14". A field the log lacks shows `—`, keeping rows aligned across columns.

---

## Y. Live-session UX: ramped polling, Disconnect on the live tab

### `startBackoffPoll()` replaces the fixed intervals
First refresh lands at **1 s** instead of one whole interval (30 s for vcat-d), then the gap
grows ×1.8 to each app's previous steady rate — 30 s for vcat-d, 5 s for vcat-ai, so neither
regresses. `setTimeout` and `setInterval` share one timer list, so the existing
`clearInterval(...)` teardowns work untouched; the loop re-checks its liveness handle both
before running a tick and before rescheduling. Each tick is awaited, so a slow refresh can
no longer have a second request stacked on it the way `setInterval` allowed.

### Disconnect on the live monitor tab
Ending a session no longer means navigating back to the device panel. The toolbar is shared
with file and comparison tabs, so the button only appears on a tab whose app is live,
resolved per-tab via `tabIdFromNode`, and routes to the matching app's existing
confirm-and-offer-snapshot prompt.

### `stopVcatdLive()` restores the device tab
Removing the pane the user was on left the vcat-d panel with **no visible tab**, which only
looked fixable by reloading. It now falls back to the device tab the way
`handleAiDisconnectClick()` already did — but only when the live tab was the active one, so
an unplug while reading a file tab doesn't yank the view away.

---

## Z. Standalone HTML export

`⤓ Save HTML` on both toolbars, for a single log **or** N logs. One self-contained file —
stylesheet, Chart.js and data inlined — that opens from disk with no server and no network,
with real canvases rather than pictures of them. No 2-log cap: the panel already scrolls
horizontally at a 420 px floor per column, and the export reuses that CSS.

- **Charts are lifted off the live `Chart` instances** (`serializeChart()`), so the export
  cannot drift from what is on screen. Axis settings travel too — `stepSize`, `min`,
  the 0–100 clamp. Tick and tooltip **callbacks are functions and cannot survive JSON**, so
  the export restates them: without this the x axis rendered raw elapsed seconds instead of
  `hh:mm`.
- **Decimation** keeps ~1500 points per series: ~0.8 MB per log against ~14 MB for every
  sample. Rather than striding, it buckets and keeps each bucket's max **and** min of the
  combined series, so spikes survive (verified: a lone 9999 in 27,342 points is retained).
- **Zoom is off**, matching the panel's `zoom: false` — and zooming decimated data would
  imply precision it does not have. The zoom plugin is therefore not inlined (0.45 → 0.28 MB).
- **Chart.js is vendored** to `static/vendor/` and `index.html` now loads it from there
  rather than the CDN: the export has to read those bytes same-origin, and the app gains
  offline operation. **jsPDF is still CDN-loaded**, so PDF export alone still needs a
  network connection.

---

## ⚠️ Notes before pushing

- **Debug timing values** are currently in place and should likely be reverted:
  - `vcat_config.py`: `DEVICE_POLL_INITIAL` and `DEVICE_POLL_STEADY` set to `2` (were
    10/30), `TELEMETRY_LOOP_POLL_INTERVAL` set to `2` (was 10).
  - `vcat_telemetry.py`: `console_cleanup_loop()` sleep set to `2s` (was 60s).
- **Live is a v1.** Each poll re-pulls the full log (simple; could tail incrementally).
  Run Config on the vcat-ai tab is still unwired (needs a vcat-ai HTTP endpoint). The live
  Excel export no longer accumulates frame drops from the worker (they live in the log).
- **Inference CPU (~1 s) dwarfs Inference (~0.24 s)** on the shared AI Processing Time
  chart's scale — may want a secondary axis / separate chart.
- **Per-zone thermal temperatures are device-dependent.** `dumpsys thermalservice` reports
  whatever the HAL exposes — a Galaxy S25 gives only `skin`, no cpu/gpu/soc. They are
  collected and exported to Excel but not charted; the live Temperature graph uses battery
  temp + the 0–5 status instead, which every device reports (see § Q).
- **`getDeviceRootFolder` / `/api/device/root_folder`** (the vcat-d broadcast path) are now
  unused for listings (superseded by the scan) — left in place, safe to remove.
- **`transform.inference_cpu_time`** older logs stored tiny values (non-ns); newer logs use
  ns. Missing/unparseable values render as 0.
- **PDF is capped at two logs** (`PDF_MAX_COLUMNS`); the spreadsheet and the HTML
  export have no limit (see § Z).
- **`chartOptions()` is declared twice** in `static/main.js` and the **second** declaration
  is the effective one. Edits to the first have no effect — it should be deleted.
- **Exports need a loaded payload**, so they are disabled on the **live** tab (same rule as
  Compare To); snapshot first.
- **Excel/`.xlsx` produced before § L** carry memory in bytes and battery as a 0–1 fraction.
- **Hourly sheets sample, not aggregate** — except Frame Drops, which sums (§ T). Battery
  moves slowly so the reading at the hour mark is representative; temperature does not, so
  a per-hour min/avg/max would describe thermal behaviour better if that becomes the point
  of interest.
- **Focus-mode filmstrip thumbnails** still clip Test Details text (a 150 px-tall preview
  with `overflow: hidden`); § P improved but did not eliminate the overhang.
- **PDF charts keep the app's dark theme** (the card colour is painted behind each
  transparent canvas). A light-theme export would need the charts re-rendered.
