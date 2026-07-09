#!/usr/bin/env python3
# vcat_web
#
# SPDX-FileCopyrightText: Copyright (C) 2020-2025 VCAT authors and RoncaTech
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This file is part of vcat_web.
#
# vcat_web is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# vcat_web is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with vcat_web. If not, see <https://www.gnu.org/licenses/gpl-3.0.html>.
#
# For proprietary/commercial use cases, a written GPL-3.0 waiver or
# a separate commercial license is required from RoncaTech LLC.
#
# All VCAT artwork is owned exclusively by RoncaTech LLC. Use of VCAT logos
# and artwork is permitted for the purpose of discussing, documenting,
# or promoting VCAT itself. Any other use requires prior written permission
# from RoncaTech LLC.
#
# Contact: legal@roncatech.com

"""
VCAT Web Telemetry Server

Flask-based server for remote monitoring and control of VCAT benchmark
sessions on Android devices via ADB and HTTP.
"""

import argparse
import atexit
import bisect
import csv
import io
import json
import os
import random
import shutil
import re
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import asdict, dataclass, field, is_dataclass
from datetime import datetime
from functools import wraps
from re import S
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse

# Keep Mac awake while server is running
caffeinate_proc = subprocess.Popen(["caffeinate", "-i"])


import requests
import vcat_adb
import vcat_http_proxy

from flask import Flask, jsonify, make_response, request, Response, send_from_directory, send_file
from vcat_logging import logger
from vcat_telemetry_data_models import *
from vcat_telemetry_reader import *
from vcat_telemetry_writer import *
from vcat_config import *

# fail gracefully if we don't have the right version of Python
if sys.version_info < (3, 9):
    logger.critical("❌ Python 3.9 or higher is required to run VCAT Telemetry.")
    sys.exit(1)
else:
    logger.debug("✅ Python version is OK.")


telemetry_dataset = OrderedDict()
session_last_access: OrderedDict[str, float] = OrderedDict()
session_last_poll: OrderedDict[str, float] = OrderedDict()

session_thread_lock = threading.RLock()
stop_event = threading.Event()

max_console_lines = get_config_option(ConfigKey.MAX_CONSOLE_LINES)

app = Flask(__name__, static_folder="static")

# Dev/monitoring tool: never let the browser cache HTML/JS/CSS, so UI changes
# always take effect on reload (no manual hard-refresh needed).
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0


@app.after_request
def add_no_cache_headers(response):
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


# Known VCAT app builds. A device may have either, both, or neither installed;
# the frontend renders one left-rail tab per installed app (order preserved).
VCAT_APP_PROFILES = [
    {"id": "vcat_d", "label": "VCAT-D", "package": "com.roncatech.vcat"},
    {"id": "vcat_ai", "label": "VCAT-AI", "package": "com.roncatech.vcat_ai"},
]


@app.route("/")
def serve_index():
    return send_from_directory("static", "index.html")


def touch_session_access(session_id: str, device_id: str):
    with session_thread_lock:
        session_last_access[device_id] = time.time()


def touch_session_poll(session_id: str):
    session_last_poll[session_id] = time.time()


def get_cpu_stats(device_id, elapsed_time, prev_raw_data: Dict[str, List[int]]):
    try:
        result = subprocess.run(
            ["adb", "-s", device_id, "shell", "cat /proc/stat"],
            capture_output=True,
            text=True,
            check=True,
        )

        lines = result.stdout.splitlines()
        cur_raw_stats = {}

        for line in lines:
            if line.startswith("cpu"):  # includes "cpu", "cpu0", ...
                parts = line.split()
                label = parts[0]
                values = list(map(int, parts[1:]))
                cur_raw_stats[label] = values

                # First call, no previous stats to compare
        if not prev_raw_data:
            return CpuUsageEntry(
                elapsed_time=elapsed_time, usage_pct={}, raw_stats=cur_raw_stats
            )

        # Compute deltas and usage percentages
        cur_usage_pct = {}
        for label, cur in cur_raw_stats.items():
            if label in prev_raw_data:
                prev = prev_raw_data[label]
                delta_total = sum(cur) - sum(prev)
                delta_idle = cur[3] - prev[3]
                if delta_total > 0:
                    usage = 100 * (1 - delta_idle / delta_total)
                    cur_usage_pct[label] = round(usage, 1)

        return CpuUsageEntry(
            elapsed_time=elapsed_time, usage_pct=cur_usage_pct, raw_stats=cur_raw_stats
        )

    except Exception as e:
        logger.error(f"[get_cpu_stats ERROR] {e}")
        return None


# Ordered list of sysfs paths to try for GPU busy percentage, by vendor
_GPU_SYSFS_PATHS = [
    "/sys/class/kgsl/kgsl-3d0/gpu_busy_percentage",    # Adreno (Qualcomm)
    "/sys/class/misc/mali0/device/utilization",          # Mali (ARM / Samsung)
    "/sys/bus/platform/drivers/mali/mali0/utilization",  # Mali (alternative)
    "/sys/kernel/ged/hal/gpu_utilization",               # MediaTek GED HAL
    "/sys/kernel/ged/hal/loading",                       # MediaTek GED loading
    "/proc/mtk_mali/gpu_utilization",                    # MediaTek Mali proc
]


def get_gpu_stats(device_id: str, elapsed_time: float) -> Optional[CpuUsageEntry]:
    try:
        cat_cmds = " || ".join(f"cat {p} 2>/dev/null" for p in _GPU_SYSFS_PATHS)
        result = subprocess.run(
            ["adb", "-s", device_id, "shell", cat_cmds],
            capture_output=True,
            text=True,
        )

        output = result.stdout.strip()
        if not output:
            return None

        match = re.search(r"(\d+(?:\.\d+)?)", output)
        if not match:
            return None

        pct = float(match.group(1))
        return CpuUsageEntry(
            elapsed_time=elapsed_time,
            usage_pct={"gpu": pct},
            raw_stats={},
        )

    except Exception as e:
        logger.error(f"[get_gpu_stats ERROR] {e}")
        return None


# NPU sysfs probe paths, grouped by vendor (Qualcomm then MediaTek).
# Google Tensor NPU does not expose utilization via sysfs and is not probed.
_NPU_SYSFS_PATHS = [
    # Qualcomm — msm_npu driver (Snapdragon devices with dedicated NPU block)
    "/sys/class/npu/msm_npu/stats",
    "/sys/bus/platform/drivers/msm_npu/stats",
    # MediaTek — MDLA (ML Dedicated Learning Accelerator) core
    "/sys/class/misc/mdla0/device/utilization",
    # MediaTek — APUSYS subsystem (Dimensity / MT8xxx series)
    "/sys/devices/platform/soc/10006000.apusys/utilization",
    "/sys/devices/platform/soc/19000000.apusys/utilization",
]


def get_npu_stats(device_id: str, elapsed_time: float) -> Optional[CpuUsageEntry]:
    try:
        cat_cmds = " || ".join(f"cat {p} 2>/dev/null" for p in _NPU_SYSFS_PATHS)
        result = subprocess.run(
            ["adb", "-s", device_id, "shell", cat_cmds],
            capture_output=True,
            text=True,
        )

        output = result.stdout.strip()
        if not output:
            return None

        match = re.search(r"(\d+(?:\.\d+)?)", output)
        if not match:
            return None

        pct = float(match.group(1))
        return CpuUsageEntry(
            elapsed_time=elapsed_time,
            usage_pct={"npu": pct},
            raw_stats={},
        )

    except Exception as e:
        logger.error(f"[get_npu_stats ERROR] {e}")
        return None


# Per-device cursor tracking for dumpsys gfxinfo frame stats
_last_vsync_id: Dict[str, int] = {}


def get_gpu_frame_stats(device_id: str, elapsed_time: float) -> Optional[GpuFrameStatsEntry]:
    try:
        package = get_config_option(ConfigKey.VCAT_PACKAGE)
        result = subprocess.run(
            ["adb", "-s", device_id, "shell", f"dumpsys gfxinfo {package} framestats"],
            capture_output=True,
            text=True,
        )
        output = result.stdout

        # Parse PROFILEDATA section — CSV rows after the header line.
        # Column indices are parsed from the header row (varies by Android version/OEM).
        profile_section = False
        col_vsync_id = col_swap = col_gpu = col_deadline = None
        frames: List[Dict[str, int]] = []

        for line in output.splitlines():
            stripped = line.strip()
            if stripped == "---PROFILEDATA---":
                if profile_section:
                    break  # second marker = end of section
                profile_section = True
                col_vsync_id = col_swap = col_gpu = col_deadline = None
                continue
            if not profile_section:
                continue

            # First line after marker is the header
            if col_vsync_id is None:
                headers = [h.strip() for h in stripped.split(",")]
                try:
                    col_vsync_id = headers.index("FrameTimelineVsyncId")
                    col_swap = headers.index("SwapBuffers")
                    col_gpu = headers.index("GpuCompleted")
                    col_deadline = headers.index("FrameDeadline")
                except ValueError:
                    break  # missing required columns, skip this section
                continue

            cols = stripped.split(",")
            if len(cols) <= max(col_vsync_id, col_swap, col_gpu, col_deadline):
                continue
            try:
                vsync_id = int(cols[col_vsync_id])
                swap_ns = int(cols[col_swap])
                gpu_ns = int(cols[col_gpu])
                deadline_ns = int(cols[col_deadline])
            except (ValueError, IndexError):
                continue

            # Skip invalid/zero rows and negative GPU times (gpu finished before swap = invalid)
            if swap_ns <= 0 or gpu_ns <= 0 or gpu_ns <= swap_ns:
                continue

            frames.append({
                "vsync_id": vsync_id,
                "gpu_ms": (gpu_ns - swap_ns) / 1_000_000.0,
                "deadline_ns": deadline_ns,
                "gpu_ns": gpu_ns,
            })

        if not frames:
            return None

        # Only process frames newer than the last seen vsync_id.
        max_vsync = max(f["vsync_id"] for f in frames)
        last_seen = _last_vsync_id.get(device_id, -1)
        new_frames = [f for f in frames if f["vsync_id"] > last_seen]

        if not new_frames:
            return None

        _last_vsync_id[device_id] = max_vsync

        gpu_times = [f["gpu_ms"] for f in new_frames]
        gpu_times_sorted = sorted(gpu_times)
        n = len(gpu_times_sorted)

        def percentile(sorted_list, pct):
            idx = max(0, int(pct / 100.0 * n) - 1)
            return sorted_list[idx]

        # Janky = frame completed after its deadline
        janky = sum(1 for f in new_frames if f["gpu_ns"] > f["deadline_ns"])

        # Parse percentiles from summary section (p50/p90/p95/p99)
        p50 = p90 = p95 = p99 = 0.0
        for line in output.splitlines():
            m = re.match(r"\s*(\d+)th gpu percentile:\s*(\d+)ms", line, re.IGNORECASE)
            if m:
                pval = int(m.group(1))
                ms = float(m.group(2))
                if pval == 50:
                    p50 = ms
                elif pval == 90:
                    p90 = ms
                elif pval == 95:
                    p95 = ms
                elif pval == 99:
                    p99 = ms

        # Fall back to computed percentiles if summary section had none
        if p50 == 0.0 and n > 0:
            p50 = percentile(gpu_times_sorted, 50)
            p90 = percentile(gpu_times_sorted, 90)
            p95 = percentile(gpu_times_sorted, 95)
            p99 = percentile(gpu_times_sorted, 99)

        return GpuFrameStatsEntry(
            elapsed_time=elapsed_time,
            new_frames=n,
            avg_gpu_ms=round(sum(gpu_times) / n, 2),
            max_gpu_ms=round(max(gpu_times), 2),
            janky_frames=janky,
            p50_ms=round(p50, 2),
            p90_ms=round(p90, 2),
            p95_ms=round(p95, 2),
            p99_ms=round(p99, 2),
        )

    except Exception as e:
        logger.error(f"[get_gpu_frame_stats ERROR] {e}")
        return None


def get_thermal_status(device_id: str, elapsed_time: float) -> Optional[ThermalStatus]:
    try:
        result = subprocess.run(
            ["adb", "-s", device_id, "shell", "dumpsys thermalservice"],
            capture_output=True,
            text=True,
        )

        temps: Dict[str, float] = {}
        in_current = False

        for line in result.stdout.splitlines():
            stripped = line.strip()
            if stripped.startswith("Current temperatures from HAL"):
                in_current = True
                continue
            if in_current:
                if stripped.startswith("Current cooling") or stripped == "":
                    break
                m = re.match(r"Temperature\{mValue=([\d.]+),\s*mType=\d+,\s*mName=(\w+),", stripped)
                if m:
                    temps[m.group(2).lower()] = float(m.group(1))

        if not temps:
            return None

        return ThermalStatus(
            elapsed_time=elapsed_time,
            cpu=temps.get("cpu"),
            gpu=temps.get("gpu"),
            npu=temps.get("npu"),
            skin=temps.get("skin"),
            soc=temps.get("soc"),
        )

    except Exception as e:
        logger.error(f"[get_thermal_status ERROR] {e}")
        return None


def get_test_details(session_id, device_id: str) -> TestDetails:

    if device_id not in telemetry_dataset:
        logger.error(f"Unknown device: {device_id}")
        return TestDetails()

    telemetry = telemetry_dataset[device_id]

    # Call the telemetry endpoint
    ip_addr = telemetry.device_ipaddr

    if not ip_addr or not ip_addr.strip():
        return TestDetails()

    response: Response = vcat_http_proxy.get_device_http_response(
        session_id, device_id, ip_addr, "/api/test/status"
    )

    if not response or response.status_code != 200:
        logger.warning(f"Failed to fetch test status for {device_id}")
        return TestDetails()

    try:
        data = response.get_json() or {}
        video = data.get("currentTestVideo") or {}

        return TestDetails(
            playlist=data.get("playlist", ""),
            startTime=data.get("startTime", ""),
            testState=data.get("testState", "Unknown"),
            currentTestVideo=CurrentTestVideo(
                fileName=video.get("fileName", ""),
                startTime=video.get("startTime", ""),
                videoCodec=video.get("videoCodec", ""),
                videoDecoder=video.get("videoDecoder", ""),
                resolution=video.get("resolution", ""),
                mimeType=video.get("mimeType", ""),
                bitrate=video.get("bitrate", ""),
                framerate=video.get("fps", 0.0),
            ),
        )
    except Exception as e:
        logger.error(f"Failed to parse test status: {e}")
        return TestDetails()


def telemetry_worker():
    global last_core_times

    logger.info("starting telemetry polling thread")

    session_idle_timeout = get_config_option(ConfigKey.TELEMETRY_SESSION_TIMEOUT)

    long_poll_interval = get_config_option(ConfigKey.DEVICE_POLL_STEADY)
    initial_poll_interval = get_config_option(ConfigKey.DEVICE_POLL_INITIAL)
    time_to_steady = get_config_option(ConfigKey.DEVICE_POLL_TIME_TO_STEADY)

    session_state: OrderedDict[str, bool] = OrderedDict()

    while not stop_event.is_set():
        if not telemetry_dataset:
            logger.info("[Monitor] No devices left, stopping telemetry monitor")
            break

        with session_thread_lock:
            device_ids = list(telemetry_dataset.keys())

        for device_id in device_ids:

            with session_thread_lock:
                telemetry_data = telemetry_dataset.get(device_id)
                if telemetry_data is None:
                    continue

            iteration_start_time = time.time()

            elapsed = time.time() - telemetry_data.start_time
            last_poll = session_last_poll.get(telemetry_data.owner_session_id, 0)
            time_since_last_poll = iteration_start_time - last_poll

            if elapsed > time_to_steady and time_since_last_poll < long_poll_interval:
                continue  # Skip polling this device for now

            touch_session_poll(telemetry_data.owner_session_id)

            # is current connection stale?
            with session_thread_lock:
                last_access = session_last_access.get(device_id, 0)

            time_since_access = time.time() - last_access

            if time_since_access > session_idle_timeout:
                logger.info(
                    f"[Monitor] Session {telemetry_data.owner_session_id} Device {device_id} stale for {time_since_access:.1f}s, removing from monitor list"
                )

                with session_thread_lock:
                    telemetry_dataset.pop(device_id, None)
                    session_last_access.pop(device_id, None)
                continue  # Skip to next device

            # Device gone (thermal shutdown, unplugged)? Stop collecting it, but keep
            # the dataset + temp file so the client can be offered a snapshot save.
            if not vcat_adb.is_valid_device(telemetry_data.owner_session_id, device_id):
                if device_id not in _disconnected_devices:
                    logger.warning(
                        f"[Monitor] Device {device_id} disconnected — halting collection; "
                        f"snapshot available for recovery"
                    )
                    _disconnected_devices.add(device_id)
                continue

            if telemetry_data.app == "vcat_ai":
                # vcat-ai test info comes from the log file (polled by the client),
                # not an HTTP status endpoint — skip the (nonexistent) /api/test/status.
                test_details = TestDetails()
            else:
                test_details = get_test_details(telemetry_data.owner_session_id, device_id)
            telemetry_data.test_details = test_details

            poll_when_not_testing = (
                get_config_option(ConfigKey.TELEMETRY_COLLECTION)
                == TelemetryCollectionMode.ALWAYS
            )
            test_running = test_details.testState == "Running"

            if (
                test_running
                and poll_when_not_testing
                and not session_state.get(telemetry_data.owner_session_id, False)
            ):
                # we've just switched into test mode, reset all collected telemetry
                logger.debug(
                    f"[Monitor] Device {device_id} test active.  Resetting pre-test telemetry"
                )
                resetTelemetry(telemetry_data.owner_session_id, device_id, app=telemetry_data.app)

            session_state[telemetry_data.owner_session_id] = test_running

            if not test_running:
                if not poll_when_not_testing:
                    logger.debug(
                        f"[Monitor] Device {device_id} is not running a test, skipping telemetry collection"
                    )
                    continue
                else:
                    logger.debug(
                        f"[Monitor] Device {device_id} is not running a test, only collecting system stats"
                    )

            battery = vcat_adb.get_battery_level(device_id)
            elapsed = time.time() - telemetry_data.start_time
            total_kb, used_kb = vcat_adb.get_system_memory(device_id)
            app_kb = vcat_adb.get_app_memory(device_id, _package_for_app(telemetry_data.app))

            # Frame drops are no longer collected here — they're read from the
            # active log file (video.frames_dropped) by the client, same as vcat-ai.

            if telemetry_data.cpu_usage:
                prev_raw_data = telemetry_data.cpu_usage[-1].raw_stats
            else:
                prev_raw_data = {}

            cur_cpu_usage = get_cpu_stats(device_id, elapsed, prev_raw_data)
            cur_gpu_usage = get_gpu_stats(device_id, elapsed)
            cur_npu_usage = get_npu_stats(device_id, elapsed)
            cur_gpu_frame_stats = get_gpu_frame_stats(device_id, elapsed)
            cur_thermal = get_thermal_status(device_id, elapsed)

            cpu_freqs = vcat_adb.get_cpu_frequencies(device_id)

            with session_thread_lock:
                if telemetry_data.start_time < 0:
                    telemetry_data.start_time = time.time()

                if iteration_start_time < telemetry_data.start_time:
                    logger.debug(
                        f"[Monitor] Skipping stale telemetry for {device_id} (collected before reset)"
                    )
                    continue  # skip applying this iteration's data

                telemetry_data.test_details = test_details

                if battery is not None:
                    telemetry_data.battery_data.append(
                        BatteryEntry(elapsed_time=elapsed, level=battery)
                    )

                    row = [
                        [
                            telemetry_data.battery_data[-1].elapsed_time,
                            telemetry_data.battery_data[-1].level,
                        ]
                    ]
                    append_telemetry(
                        telemetry_data.owner_session_id,
                        TelemetrySheet.BATTERY,
                        row,
                    )

                if used_kb is not None and app_kb is not None:
                    telemetry_data.system_memory.append(
                        MemoryEntry(elapsed_time=elapsed, used_kb=used_kb)
                    )

                    telemetry_data.app_memory.append(
                        MemoryEntry(elapsed_time=elapsed, used_kb=app_kb)
                    )

                    mem_entry = telemetry_data.system_memory[-1]
                    app_entry = telemetry_data.app_memory[-1]

                    row = [
                        mem_entry.elapsed_time,
                        mem_entry.used_kb,
                        app_entry.used_kb,
                    ]
                    append_telemetry(
                        telemetry_data.owner_session_id, TelemetrySheet.MEMORY, [row]
                    )

                if cur_cpu_usage is not None:
                    telemetry_data.cpu_usage.append(cur_cpu_usage)

                    usage_row = [cur_cpu_usage.elapsed_time]

                    # Build row in consistent order: total first, then sorted cores
                    usage_row.append(
                        cur_cpu_usage.usage_pct.get("cpu", 0.0)
                    )  # 'cpu' is the total key

                    core_keys = sorted(
                        k
                        for k in cur_cpu_usage.usage_pct
                        if k.startswith("cpu") and k != "cpu"
                    )

                    usage_row.extend(
                        [cur_cpu_usage.usage_pct.get(k, 0.0) for k in core_keys]
                    )

                    append_telemetry(
                        telemetry_data.owner_session_id,
                        TelemetrySheet.CPU_USAGE,
                        [usage_row],
                    )

                if cpu_freqs:
                    telemetry_data.cpu_freq.append(
                        CpuFreguencyEntry(elapsed_time=elapsed, frequencies=cpu_freqs)
                    )

                    freq_row = [elapsed]

                    # Use sorted keys for consistent column order
                    core_keys = sorted(cpu_freqs.keys())
                    freq_row.extend([cpu_freqs[k] for k in core_keys])

                    append_telemetry(
                        telemetry_data.owner_session_id,
                        TelemetrySheet.CPU_FREQ,
                        [freq_row],
                    )

                if cur_gpu_usage is not None:
                    telemetry_data.gpu_usage.append(cur_gpu_usage)
                    append_telemetry(
                        telemetry_data.owner_session_id,
                        TelemetrySheet.GPU_USAGE,
                        [[cur_gpu_usage.elapsed_time, cur_gpu_usage.usage_pct.get("gpu", 0.0)]],
                    )

                if cur_npu_usage is not None:
                    telemetry_data.npu_usage.append(cur_npu_usage)
                    append_telemetry(
                        telemetry_data.owner_session_id,
                        TelemetrySheet.NPU_USAGE,
                        [[cur_npu_usage.elapsed_time, cur_npu_usage.usage_pct.get("npu", 0.0)]],
                    )

                if cur_gpu_frame_stats is not None:
                    telemetry_data.gpu_frame_stats.append(cur_gpu_frame_stats)
                    append_telemetry(
                        telemetry_data.owner_session_id,
                        TelemetrySheet.GPU_FRAME_STATS,
                        [[
                            cur_gpu_frame_stats.elapsed_time,
                            cur_gpu_frame_stats.new_frames,
                            cur_gpu_frame_stats.avg_gpu_ms,
                            cur_gpu_frame_stats.max_gpu_ms,
                            cur_gpu_frame_stats.janky_frames,
                            cur_gpu_frame_stats.p50_ms,
                            cur_gpu_frame_stats.p90_ms,
                            cur_gpu_frame_stats.p95_ms,
                            cur_gpu_frame_stats.p99_ms,
                        ]],
                    )

                if cur_thermal is not None:
                    telemetry_data.thermal_status.append(cur_thermal)
                    append_telemetry(
                        telemetry_data.owner_session_id,
                        TelemetrySheet.THERMAL_STATUS,
                        [[
                            cur_thermal.elapsed_time,
                            cur_thermal.cpu,
                            cur_thermal.gpu,
                            cur_thermal.npu,
                            cur_thermal.skin,
                            cur_thermal.soc,
                        ]],
                    )

            # Maintain the live-session temp file (throttled inside).
            refresh_session_file(
                telemetry_data.owner_session_id, device_id, telemetry_data.app
            )

        # If every monitored device has disconnected, stop the polling thread.
        with session_thread_lock:
            active = [d for d in telemetry_dataset if d not in _disconnected_devices]
        if telemetry_dataset and not active:
            logger.info("[Monitor] All monitored devices disconnected — stopping telemetry thread")
            break

        if stop_event.wait(
            timeout=get_config_option(ConfigKey.TELEMETRY_LOOP_POLL_INTERVAL)
        ):
            break


def console_cleanup_loop():
    while True:
        now = time.time()
        with session_thread_lock:
            expired = [
                sid
                for sid, log in vcat_adb.session_consoles.items()
                if now - log.last_access > get_config_option(ConfigKey.CONSOLE_TIMEOUT)
            ]
            for sid in expired:
                logger.debug(f"[Session Cleanup] Expiring session {sid}")
                del vcat_adb.session_consoles[sid]
        time.sleep(2)


def resetTelemetry(session_id, device_id, app: str = "vcat_d"):
    if app == "vcat_ai":
        ipAddr = vcat_adb.get_ai_device_ip_and_port(session_id, device_id) or ""
    else:
        ipAddr = vcat_adb.get_device_ip_and_port(session_id, device_id) or ""

    now = time.time()

    telemetry_data = VcatdTelemetryData(
        version=0,
        owner_session_id=session_id,
        device_id=device_id,
        device_ipaddr=ipAddr,
        device_info=DeviceInfo(),
        start_time=time.time(),
        test_conditions=TestConditions.empty(),
        start_battery=BatteryEntry(),
        test_details=TestDetails(),
        system_thermal_status = SystemThermalStatus(),
        battery_data=[],
        system_memory=[],
        app_memory=[],
        frame_drops=[],
        cpu_freq=[],
        cpu_usage=[],
        gpu_usage=[],
        npu_usage=[],
        gpu_frame_stats=[],
        thermal_status=[],
        session_info=SessionInfo()
    )

    telemetry_data.app = app

    # Reset the vsync cursor for this device so we don't skip frames after reset
    _last_vsync_id.pop(device_id, None)

    # ✅ Reset telemetry for the given device
    with session_thread_lock:
        telemetry_dataset[device_id] = telemetry_data

    # ✅ Log the telemetry reset event
    vcat_adb.log_console_entry(
        session_id, f"[VCAT] Telemetry reset for device {device_id}"
    )

    return telemetry_data


class DeviceAccessException(Exception):
    def __init__(self, message: str):
        super().__init__(message)


def get_device_info(
    session_id: str, device_id: str, refresh: bool = False
) -> Tuple[Optional[DeviceInfo], Optional[Response]]:

    if not refresh and device_id in device_info_cache:
        return device_info_cache[device_id], None

    # On refresh, drop the cached IP so it's re-resolved (e.g. after launching
    # the app, whose HTTP address only becomes available once it's running).
    if refresh:
        vcat_adb.ipCache.pop(device_id, None)

    def run_adb(cmd: List[str]) -> str:
        full_cmd = ["adb", "-s", device_id] + cmd
        output = (
            vcat_adb.run_adb_command_with_log(session_id, device_id, full_cmd) or ""
        )
        return output

        # Mapping of CPU part IDs to core types

    CPU_PART_MAP = {
        "0xd03": "Cortex-A53",
        "0xd04": "Cortex-A35",
        "0xd05": "Cortex-A55",
        "0xd07": "Cortex-A57",
        "0xd08": "Cortex-A72",
        "0xd09": "Cortex-A73",
        "0xd0a": "Cortex-A75",
        "0xd0b": "Cortex-A76",
        "0xd0c": "Neoverse-N1",
        "0xd40": "Cortex-A78",
        "0xd41": "Cortex-A78AE",
        "0xd44": "Cortex-X1",
        "0xd47": "Cortex-A710",
        "0xd48": "Cortex-X2",
        "0xd49": "Cortex-A510",
        "0xd4a": "Cortex-A715",
        "0xd4b": "Cortex-X3",
        "0xd4c": "Cortex-A520",
        "0xd4d": "Cortex-A720",
        "0xd4e": "Cortex-X4",
    }

    try:

        def parse_wm_size(output: str) -> DisplayResolution:
            if "Physical size:" not in output:
                raise DeviceAccessException("Missing 'Physical size' in wm size output")
            try:
                _, size_str = output.split(":")
                w, h = map(int, size_str.strip().split("x"))
                return DisplayResolution(width=w, height=h)
            except Exception as e:
                raise DeviceAccessException(f"Failed to parse wm size: {e}")

        def parse_meminfo(output: str) -> MemoryInfo:
            total, available = None, None
            for line in output.splitlines():
                if line.startswith("MemTotal:"):
                    total = line.split(":")[1].strip()
                elif line.startswith("MemAvailable:"):
                    available = line.split(":")[1].strip()
            if not total or not available:
                raise DeviceAccessException("Failed to parse /proc/meminfo")
            return MemoryInfo(total=total, available=available)

        def parse_cpuinfo(cpuinfo_output: str, cores: List[CoreInfo]):
            for block in cpuinfo_output.strip().split("\n\n"):
                lines = {
                    k.strip(): v.strip()
                    for line in block.strip().splitlines()
                    if ":" in line
                    for k, v in [line.split(":", 1)]
                }
                if "processor" in lines and "CPU part" in lines:
                    cid = int(lines["processor"])
                    part = lines["CPU part"].lower()
                    part = part if part.startswith("0x") else f"0x{part}"
                    core_type = CPU_PART_MAP.get(part, f"Unknown ({part})")
                    for core in cores:
                        if core.core_id == cid:
                            core.core_type = core_type
                            break

        info = DeviceInfo()

        info.manufacturer = run_adb(["shell", "getprop", "ro.product.manufacturer"])
        info.model = run_adb(["shell", "getprop", "ro.product.model"])
        info.android_version = run_adb(["shell", "getprop", "ro.build.version.release"])
        info.soc_manufacturer = run_adb(["shell", "getprop", "ro.soc.manufacturer"])
        info.soc = run_adb(["shell", "getprop", "ro.soc.model"])
        info.cpu.architecture = run_adb(["shell", "getprop", "ro.product.cpu.abi"])

        # IP is reported by the app via broadcast->logcat, so it's only available
        # once the app is running. Skip the (slow) broadcast when it isn't, and
        # fall back to the device's wlan0 address.
        app_addr = None
        if is_vcat_running(session_id, device_id):
            app_addr = vcat_adb.get_device_ip_and_port(session_id, device_id)
        if app_addr:
            info.ip_addr = app_addr
        else:
            ip_output = run_adb(["shell", "ip", "addr", "show", "wlan0"])
            for line in ip_output.splitlines():
                if "inet " in line:
                    ip_addr = line.strip().split()[1].split("/")[0]
                    info.ip_addr = ip_addr if ip_addr else "<none>"
                    break

        for i in range(32):
            freq = run_adb(
                [
                    "shell",
                    "cat",
                    f"/sys/devices/system/cpu/cpu{i}/cpufreq/cpuinfo_max_freq",
                ]
            )
            if freq.isdigit():
                info.cpu.cores.append(
                    CoreInfo(core_id=i, frequency_mhz=int(freq) // 1000)
                )
            else:
                break

        cpuinfo = run_adb(["shell", "cat", "/proc/cpuinfo"])
        parse_cpuinfo(cpuinfo, info.cpu.cores)

        wm_output = run_adb(["shell", "wm", "size"])
        info.display_resolution = parse_wm_size(wm_output)

        meminfo = run_adb(["shell", "cat", "/proc/meminfo"])
        info.memory = parse_meminfo(meminfo)

        df_output = run_adb(["shell", "df"])
        found_data_line = False
        for line in df_output.splitlines():
            if "/data" in line:
                parts = line.split()
                if len(parts) >= 4:
                    info.storage.total = parts[1]
                    info.storage.available = parts[3]
                    found_data_line = True
                    break
        if not found_data_line:
            raise DeviceAccessException("Could not find /data line in df output")

        device_info_cache[device_id] = info
        return info, None

    except DeviceAccessException as e:
        logger.error(f"[DeviceAccessException] {e}")
        response = make_response(jsonify({"error": str(e)}), 500)
        return None, response
    except Exception as e:
        logger.exception("Unexpected error during device info collection")
        response = make_response(jsonify({"error": "Internal server error"}), 500)
        return None, response


##################################
#  HTTP APIs
##################################


def require_valid_session(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        session_id = request.args.get("session") or "<missing>"

        if not vcat_adb.isSessionValid(session_id):
            logger.error(
                f"{func.__name__} called with invalid or missing session_id: [{session_id}]"
            )
            return jsonify({"error": "Invalid or missing session_id"}), 400

        vcat_adb.touchConsole(session_id)
        return func(session_id, *args, **kwargs)

    return wrapper


def require_valid_session_and_device(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        session_id = request.args.get("session") or "<missing>"
        device_id = request.args.get("device") or "<missing>"

        if not vcat_adb.isSessionValid(session_id):
            logger.error(
                f"{func.__name__} called with invalid or missing session_id: [{session_id}]"
            )
            return jsonify({"error": "Invalid or missing session_id"}), 400

        if not device_id:
            logger.error(f"{func.__name__} called with invalid or missing device_id")
            return jsonify({"error": "Invalid or missing device ID"}), 400

        vcat_adb.touchConsole(session_id)
        return func(session_id, device_id, *args, **kwargs)

    return wrapper


def require_valid_session_device_and_path(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        session_id = request.args.get("session") or "<missing>"
        device_id = request.args.get("device") or "<missing>"
        path = request.args.get("path") or ""

        if not vcat_adb.isSessionValid(session_id):
            logger.error(
                f"{func.__name__} called with invalid or missing session_id: [{session_id}]"
            )
            return jsonify({"error": "Invalid or missing session_id"}), 400

        if not device_id:
            logger.error(f"{func.__name__} called with invalid or missing device_id")
            return jsonify({"error": "Invalid or missing device ID"}), 400

        if not path.startswith("/sdcard/"):
            logger.error(f"{func.__name__} called with invalid path: [{path}]")
            return jsonify({"error": "Invalid or missing path"}), 400

        vcat_adb.touchConsole(session_id)
        return func(session_id, device_id, path, *args, **kwargs)

    return wrapper


def get_required_ip_and_port(session_id: str, device_id: str):
    ip_addr = vcat_adb.get_device_ip_and_port(session_id, device_id)
    if not ip_addr:
        logger.error(
            f"Unable to determine IP/port for session: [{session_id}] device: [{device_id}]"
        )
        raise ValueError("Could not determine IP or port")
    return ip_addr


def get_required_ip(session_id: str, device_id: str):
    ip_addr = vcat_adb.get_device_ip(session_id, device_id)
    if not ip_addr:
        logger.error(
            f"Unable to determine IP for session: [{session_id}] device: [{device_id}]"
        )
        raise ValueError("Could not determine IP or port")
    return ip_addr


@app.route("/api/session_token", methods=["GET"])
def session_token():
    token = str(uuid.uuid4())
    vcat_adb.session_consoles[token] = vcat_adb.SessionConsole(last_access=time.time())
    logger.debug(f"api/session_token - VCAT Session started: [{token}]")
    return jsonify({"session_token": token})


@app.route("/api/session_console_log", methods=["GET"])
@require_valid_session
def session_console_log(session_id):

    log_data = vcat_adb.session_consoles.get(session_id)
    vcat_adb.touchConsole(session_id)

    if not log_data:
        logger.critical(
            f"api/session_token: Unable to locate console session for [{session_id}]"
        )
        return jsonify({f"Unable to locate console session for: [{session_id}]"}), 400

    # Build ordered response
    ordered = OrderedDict()
    ordered["session_id"] = session_id
    ordered["entry_count"] = len(log_data.history)
    ordered["log"] = [
        {
            "time": entry.time,
            "date": entry.date,
            "text": entry.text,
        }
        for entry in log_data.history
    ]

    return Response(
        json.dumps(ordered, indent=2, sort_keys=False), mimetype="application/json"
    )


@app.route("/api/reset_session_console_log", methods=["POST"])
@require_valid_session
def api_reset_session_console_log(session_id):

    vcat_adb.reset_session_console(session_id)

    return jsonify({"status": "console log reset completed"}), 200


##########################################
# Device management
##########################################


def _package_for_app(app_id: str) -> str:
    """Resolve an app id (vcat_d / vcat_ai) to its package; defaults to vcat-d."""
    for p in VCAT_APP_PROFILES:
        if p["id"] == app_id:
            return p["package"]
    return "com.roncatech.vcat"


def is_vcat_running(session_id: str, device_id: str, package: str = "com.roncatech.vcat") -> bool:
    cmd = ["adb", "-s", device_id, "shell", "pidof", package]
    output = vcat_adb.run_adb_command_with_log(session_id, device_id, cmd)
    return bool(output and output.strip())


def launch_vcat(session_id: str, device_id: str, package: str = "com.roncatech.vcat") -> Tuple[bool, bool]:
    """
    Launches the given VCAT app package if it's not already running.

    Returns:
        (launched, already_running)
    """
    if is_vcat_running(session_id, device_id, package):
        return False, True

    cmd = [
        "adb",
        "-s",
        device_id,
        "shell",
        "monkey",
        "-p",
        package,
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
    ]
    output = vcat_adb.run_adb_command_with_log(session_id, device_id, cmd)

    success = bool(output and "Events injected: 1" in output)
    return success, False


@app.route("/api/device/vcat_running")
@require_valid_session_and_device
def vcat_running(session_id, device_id):
    package = _package_for_app(request.args.get("app", "vcat_d"))
    running = is_vcat_running(session_id, device_id, package)
    return jsonify({"running": running})


@app.route("/api/device/launch_vcat")
@require_valid_session_and_device
def launch_vcat_api(session_id, device_id):
    package = _package_for_app(request.args.get("app", "vcat_d"))
    launched, already_running = launch_vcat(session_id, device_id, package)
    return jsonify({"launched": launched, "already_running": already_running})


def get_device_file(
    session_id: str,
    device_id: str,
    device_file_path: str,
    local_path: str = "",
    force_temp: bool = True,
) -> str:
    """
    Pulls a file from an Android device to the host machine via ADB.

    Args:
        session_id (str): Session ID for logging.
        device_id (str): ADB device ID.
        device_file_path (str): Full path on the Android device (e.g. /sdcard/foo.csv).
        local_path (str): Optional full or relative path on host where to save the file.
        force_temp (bool): If True, override local_path and save to a unique file in temp folder.

    Returns:
        str: The full local path of the downloaded file.

    Raises:
        Exception: If pull fails or directory is not writable.
    """

    if force_temp or not local_path:
        base_name = os.path.basename(device_file_path)
        unique_name = f"{uuid.uuid4().hex}_{base_name}"
        local_path = os.path.join(tempfile.gettempdir(), unique_name)
    else:
        local_path = os.path.normpath(local_path)
        local_dir = os.path.dirname(local_path)
        if not os.path.isdir(local_dir) or not os.access(local_dir, os.W_OK):
            raise Exception(f"Directory '{local_dir}' is not writable")

    adb_cmd = ["adb", "-s", device_id, "pull", device_file_path, local_path]

    vcat_adb.run_adb_command_with_log(session_id, device_id, adb_cmd)
    return local_path


@app.route("/api/device/copy_file")
@require_valid_session_and_device
def copy_file(session_id, device_id):
    device_file_path = request.args.get("file_path")
    if not device_file_path:
        return (
            jsonify(
                {
                    "status": "error",
                    "message": "Missing required query parameter: test_file_path",
                }
            ),
            400,
        )

    try:
        local_path = get_device_file(
            session_id=session_id,
            device_id=device_id,
            device_file_path=device_file_path,
            force_temp=True,  # ignore caller's destination
        )
        return jsonify({"status": "success", "local_path": local_path})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/device/ping")
@require_valid_session_and_device
def ping_device(session_id, device_id):

    ip_addr = get_required_ip(session_id, device_id)

    try:
        result = subprocess.run(
            ["ping", "-c", "1", "-W", "1", ip_addr],
            capture_output=True,
            text=True,
            check=False,
        )

        # Write the actual ping output line-by-line into the console
        for line in result.stdout.strip().splitlines():
            vcat_adb.log_console_entry(session_id, line.strip())

        # Also log stderr if present (e.g. if ping fails)
        if result.stderr:
            for line in result.stderr.strip().splitlines():
                vcat_adb.log_console_entry(session_id, line.strip())

        return jsonify(success=(result.returncode == 0), message="Ping complete")

    except subprocess.TimeoutExpired:
        logger.error(session_id, f"Ping to {ip_addr} timed out.")
        return jsonify(success=False, message="Ping timed out")

    except Exception as e:
        logger.error(session_id, f"Ping error: {str(e)}")
        return jsonify(success=False, message="Ping error")


@app.route("/api/all_connected_devices", methods=["GET"])
@require_valid_session
def api_devices(session_id):
    return jsonify(vcat_adb.get_adb_devices(session_id))


@app.route("/api/device/address_of", methods=["GET"])
@require_valid_session_and_device
def api_ip_port(session_id, device_id):

    ip_addr = ""
    try:
        ip_addr = get_required_ip_and_port(session_id, device_id)
        return jsonify({"address": ip_addr})

    except ValueError as e:
        return jsonify({"error": str(e)}), 404


device_info_cache: LRUCache[str, DeviceInfo] = LRUCache(10)


@app.route("/api/device/info", methods=["GET"])
@require_valid_session_and_device
def api_device_info(session_id, device_id):

    try:
        refresh = request.args.get("refresh") in ("1", "true", "yes")
        device_info, error_response = get_device_info(session_id, device_id, refresh=refresh)
        if error_response:
            return error_response

        if device_info is None:
            logger.error(
                f"api/device/info: Unexpected missing data for get_device_info([{session_id}]:[{device_id}])"
            )
            return make_response(jsonify({"error": "Missing device info"}), 500)

        return jsonify(
            device_info.to_dict()
        )  # You may need to import `asdict` from `dataclasses`
    except ValueError as e:
        return jsonify({"error": str(e)}), 404


@app.route("/api/device/run_config", methods=["GET"])
@require_valid_session_and_device
def api_device_run_config(session_id, device_id):

    try:
        ip_addr = get_required_ip_and_port(session_id, device_id)

        try:
            response = vcat_http_proxy.get_device_http_response(
                session_id, device_id, ip_addr, "/api/run_config"
            )

            return response

        except requests.RequestException as e:
            logger.error(f"Failed to fetch run config: [{str(e)}]")
            return jsonify({"error": f"Failed to fetch run config: {str(e)}"}), 500
    except ValueError as e:
        return jsonify({"error": str(e)}), 404


@app.route("/api/device/stop", methods=["POST"])
@require_valid_session_and_device
def api_device_stop(session_id, device_id):

    try:
        ip_addr = get_required_ip_and_port(session_id, device_id)

        return vcat_http_proxy.get_device_http_response(
            session_id, device_id, ip_addr, "/api/control/stop"
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 404


@app.route("/api/device/show_stats", methods=["POST"])
@require_valid_session_and_device
def api_device_show_stats(session_id, device_id):
    try:
        ip_addr = get_required_ip_and_port(session_id, device_id)

        return vcat_http_proxy.get_device_http_response(
            session_id, device_id, ip_addr, "/api/control/show_stats"
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 404


@app.route("/api/device/play_pause", methods=["POST"])
@require_valid_session_and_device
def api_device_playpause(session_id, device_id):
    try:
        ip_addr = get_required_ip_and_port(session_id, device_id)

        return vcat_http_proxy.get_device_http_response(
            session_id, device_id, ip_addr, "/api/control/playpause"
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 404


@app.route("/api/wireless_adb")
@require_valid_session_and_device
def api_enable_wireless_adb(session_id, device_id):

    try:
        ip_addr = ""

        # Step 1: Find device IP address
        try:
            ip_addr = get_required_ip_and_port(session_id, device_id)
        except ValueError as e:
            return jsonify({"error": str(e)}), 404

        # Step 2: Enable wireless ADB
        output = vcat_adb.run_adb_command_with_log(
            session_id,
            device_id,
            ["adb", "-s", device_id, "tcpip", "5555"],
            log_level="info",
        )

        if output is None:
            logger.error(
                f"/api/wireless_adb: Failed to enable wireless ADB for device [{device_id}]"
            )
            return (
                jsonify(
                    {"error": f"Failed to enable wireless ADB for device [{device_id}]"}
                ),
                500,
            )

        parsed_url = urlparse(ip_addr)
        ip_addr = parsed_url.hostname

        # Step 3: Connect wirelessly
        connect_output = vcat_adb.run_adb_command_with_log(
            session_id,
            device_id,
            ["adb", "connect", f"{ip_addr}:5555"],
            log_level="info",
        )

        if connect_output is None:
            logger.error(
                f"/api/wireless_adb: Failed to connect to {ip_addr}:5555 for device [{device_id}]"
            )
            return jsonify({"error": f"Failed to connect to {ip_addr}:5555"}), 500

        resetTelemetry(session_id, device_id)

        return (
            jsonify(
                {"message": f"Wireless ADB enabled and connected to {ip_addr}:5555"}
            ),
            200,
        )

    except Exception as e:
        return jsonify({"error": str(e)}), 500


def get_files(session_id, device_id, path):
    # Construct ADB command exactly as it would run in terminal
    full_cmd = ["adb", "-s", device_id, "shell", f"ls {path}"]

    output = vcat_adb.run_adb_command_with_log(
        session_id=session_id, device_id=device_id, cmd=full_cmd, log_level="debug"
    )

    # Split output into lines
    filenames = [line.strip() for line in (output or "").splitlines() if line.strip()]

    return filenames


@app.route("/api/device/ai_device_info", methods=["GET"])
@require_valid_session_and_device
def api_device_ai_device_info(session_id, device_id):
    """
    Resolves the vcat-ai app's HTTP server (via the vcat_ai broadcast + logcat)
    and proxies GET /api/device_info, returning the app's device-info JSON.
    """
    ip_addr = vcat_adb.get_ai_device_ip_and_port(session_id, device_id)
    if not ip_addr:
        return jsonify({"error": "Could not resolve vcat-ai HTTP server"}), 404

    response = vcat_http_proxy.get_device_http_response(
        session_id, device_id, ip_addr, "/api/device_info"
    )
    if not response or response.status_code != 200:
        return jsonify({"error": "Failed to fetch vcat-ai device info"}), 502

    try:
        data = json.loads(response.get_data(as_text=True))
    except Exception as e:
        logger.error(f"Invalid vcat-ai device_info JSON: {e}")
        return jsonify({"error": "Invalid device info from vcat-ai"}), 502

    data["ip_addr"] = ip_addr
    return jsonify(data)


@app.route("/api/device/vcat_apps", methods=["GET"])
@require_valid_session_and_device
def api_device_vcat_apps(session_id, device_id):
    """
    Returns the VCAT app builds installed on the device, in profile order.
    The frontend renders one left-rail tab per entry.
    """
    installed = vcat_adb.list_installed_packages(session_id, device_id)
    apps = [
        {"id": p["id"], "label": p["label"], "package": p["package"]}
        for p in VCAT_APP_PROFILES
        if p["package"] in installed
    ]
    return jsonify(apps)


@app.route("/api/device/scan_folders", methods=["GET"])
@require_valid_session_and_device
def api_device_scan_folders(session_id, device_id):
    """
    Filesystem scan for each app's data folder (no app running required).
    Used for non-live log viewing. See vcat_adb.scan_vcat_data_folders.
    """
    return jsonify(vcat_adb.scan_vcat_data_folders(session_id, device_id))


@app.route("/api/device/root_folder", methods=["GET"])
@require_valid_session_and_device
def api_device_root_folder(session_id, device_id):
    """
    Resolves the on-device VCAT data folder (user-selected, no fixed name) by
    asking the app to log it via broadcast. See vcat_adb.get_device_root_folder.
    """
    root = vcat_adb.get_device_root_folder(session_id, device_id)
    if not root:
        return jsonify({"error": "Could not resolve device root folder"}), 404
    return jsonify({"root_folder": root})


@app.route("/api/device/files", methods=["GET"])
@require_valid_session_device_and_path
def api_device_files(session_id, device_id, path):

    try:
        filenames = get_files(session_id, device_id, path)

        return jsonify(filenames)

    except Exception as e:
        app.logger.error(f"[{device_id}] Failed to list playlists in {path}: {e}")
        return jsonify({"error": "Failed to list playlist files"}), 500


@app.route("/api/device/test_results_files", methods=["GET"])
@require_valid_session_device_and_path
def api_device_test_results_files(session_id, device_id, path):

    try:
        # `ls -l` so we get file sizes; toybox format is:
        #   perms links owner group SIZE date time NAME
        cmd = ["adb", "-s", device_id, "shell", f"ls -l {path}"]
        output = vcat_adb.run_adb_command_with_log(
            session_id=session_id, device_id=device_id, cmd=cmd, log_level="debug"
        )

        file_entries = []
        for line in (output or "").splitlines():
            line = line.strip()
            if not line or line.startswith("total"):
                continue

            parts = line.split()
            if len(parts) < 8:
                continue
            try:
                size = int(parts[4])
            except ValueError:
                continue
            full_path = " ".join(parts[7:])
            filename = full_path.rsplit("/", 1)[-1]

            # Timestamp (ms) embedded in the filename — handles both vcat-d
            # (logs_<ts>.csv) and vcat-ai (vcatai_log_<ts>.csv) naming.
            match = re.search(r"(\d{10,})", filename)
            if match:
                dt = datetime.fromtimestamp(int(match.group(1)) / 1000.0)
                date_display = dt.strftime("%m/%d/%Y, %I:%M:%S %p")
            else:
                date_display = ""

            file_entries.append(
                {
                    "path": full_path,
                    "filename": filename,
                    "date": date_display,
                    "size": size,
                }
            )

        # Newest first (filename embeds the timestamp)
        file_entries.sort(key=lambda e: e["filename"], reverse=True)

        return jsonify(file_entries)

    except Exception as e:
        app.logger.error(f"[{device_id}] Failed to list test results in {path}: {e}")
        return jsonify({"error": "Failed to list test result files"}), 500


##########################################
# Telemetry
##########################################

from dataclasses import asdict
from datetime import datetime


def build_ai_telemetry_response(telemetry, device_id: str) -> dict:
    """Response for vcat-ai telemetry (VcataiTelemetryData): common series
    (no frame drops) plus the AI processing-time series."""

    def proc_series(entries):
        return [
            {"elapsed_time": e.elapsed_time, "value_ns": e.value_ns} for e in entries
        ]

    return {
        "timestamp": datetime.now().isoformat(),
        "device_id": device_id,
        "test_details": asdict(telemetry.test_details),
        # Raw vcat-ai test object (name/id/createdAt/testCases[...]) for the panel.
        "ai_test": telemetry.session_info.test,
        "telemetry_data": {
            "battery": [
                {"elapsed_time": e.elapsed_time, "level": e.level}
                for e in telemetry.battery_data
            ],
            "system_memory": [
                {"elapsed_time": e.elapsed_time, "used_kb": e.used_kb}
                for e in telemetry.system_memory
            ],
            "app_memory": [
                {"elapsed_time": e.elapsed_time, "used_kb": e.used_kb}
                for e in telemetry.app_memory
            ],
            "cpu_usage": [
                {"elapsed_time": e.elapsed_time, **e.usage_pct}
                for e in telemetry.cpu_usage
            ],
            "cpu_freq": [
                {"elapsed_time": e.elapsed_time, "frequencies": e.frequencies}
                for e in telemetry.cpu_freq
            ],
            "battery_temp": [
                {"elapsed_time": e.elapsed_time, "temp": e.battery_temp}
                for e in telemetry.battery_data
            ],
            "system_thermal": [
                {"elapsed_time": e.elapsed_time, "status": e.status}
                for e in telemetry.system_thermal_status
            ],
            "frameProcTime": proc_series(telemetry.frameProcTime),
            "infTimeNs": proc_series(telemetry.infTimeNs),
            "infCpuTimeNs": proc_series(telemetry.infCpuTimeNs),
        },
    }


def build_telemetry_response(telemetry, device_id: str) -> dict:
    # Live telemetry may leave system_thermal_status as a non-list; normalize.
    sts = telemetry.system_thermal_status
    if not isinstance(sts, list):
        sts = []
    return {
        "timestamp": datetime.now().isoformat(),
        "device_id": device_id,
        "test_details": asdict(telemetry.test_details),
        "telemetry_data": {
            "battery": [
                {"elapsed_time": entry.elapsed_time, "level": entry.level}
                for entry in telemetry.battery_data
            ],
            "battery_temp": [
                {"elapsed_time": entry.elapsed_time, "temp": entry.battery_temp}
                for entry in telemetry.battery_data
            ],
            "system_thermal": [
                {"elapsed_time": e.elapsed_time, "status": e.status}
                for e in sts
            ],
            "system_memory": [
                {
                    "elapsed_time": entry.elapsed_time,
                    "used_kb": entry.used_kb,
                }
                for entry in telemetry.system_memory
            ],
            "app_memory": [
                {
                    "elapsed_time": entry.elapsed_time,
                    "used_kb": entry.used_kb,
                }
                for entry in telemetry.app_memory
            ],
            "cpu_usage": [
                {
                    "elapsed_time": entry.elapsed_time,
                    **entry.usage_pct,
                }
                for entry in telemetry.cpu_usage
            ],
            "cpu_freq": [
                {
                    "elapsed_time": entry.elapsed_time,
                    "frequencies": entry.frequencies,
                }
                for entry in telemetry.cpu_freq
            ],
            "gpu_usage": [
                {
                    "elapsed_time": entry.elapsed_time,
                    **entry.usage_pct,
                }
                for entry in telemetry.gpu_usage
            ],
            "npu_usage": [
                {
                    "elapsed_time": entry.elapsed_time,
                    **entry.usage_pct,
                }
                for entry in telemetry.npu_usage
            ],
            "frame_drops": [
                {
                    "elapsed_time": entry.elapsed_time,
                    "delta_framedrops": entry.delta_framedrops,
                }
                for entry in telemetry.frame_drops
            ],
            "gpu_frame_stats": [
                {
                    "elapsed_time": entry.elapsed_time,
                    "new_frames": entry.new_frames,
                    "avg_gpu_ms": entry.avg_gpu_ms,
                    "max_gpu_ms": entry.max_gpu_ms,
                    "janky_frames": entry.janky_frames,
                    "p50_ms": entry.p50_ms,
                    "p90_ms": entry.p90_ms,
                    "p95_ms": entry.p95_ms,
                    "p99_ms": entry.p99_ms,
                }
                for entry in telemetry.gpu_frame_stats
            ],
            "thermal_status": [
                {
                    "elapsed_time": entry.elapsed_time,
                    "cpu": entry.cpu,
                    "gpu": entry.gpu,
                    "npu": entry.npu,
                    "skin": entry.skin,
                    "soc": entry.soc,
                }
                for entry in telemetry.thermal_status
            ],
        },
    }


def _sessions_dir() -> str:
    # Saved sessions go in the user's Downloads folder (local desktop tool).
    d = os.path.expanduser("~/Downloads")
    os.makedirs(d, exist_ok=True)
    return d


# Per-device live-session temp file (the running merged CSV), append state, throttle.
_session_files: Dict[str, str] = {}
_session_state: Dict[str, dict] = {}
_session_file_last: Dict[str, float] = {}
_disconnected_devices: set = set()  # devices that dropped mid-session (e.g. thermal)
SESSION_FILE_REFRESH = 10  # seconds between temp-file appends


def _merge_worker_series(rows, log_elapsed, entries, key_to_col):
    """Fill CSV rows with worker (ADB) values, nearest sample per row, with the
    worker series shifted onto the log timeline (offset = latest log − latest worker)."""
    if not entries or not rows:
        return
    offset = log_elapsed[-1] - entries[-1].elapsed_time
    times = [offset + e.elapsed_time for e in entries]
    for r, e_row in zip(rows, log_elapsed):
        if e_row < offset - 1.0:
            continue  # before connect — nothing captured
        idx = bisect.bisect_left(times, e_row)
        cands = [j for j in (idx - 1, idx) if 0 <= j < len(entries)]
        if not cands:
            continue
        best = min(cands, key=lambda j: abs(times[j] - e_row))
        for uk, col in key_to_col.items():
            if uk in entries[best].usage_pct:
                r[col] = entries[best].usage_pct[uk]


def write_session_csv(session_id, device_id, log_device_path, out_path) -> str:
    """
    Build the merged session CSV: the app log plus ADB-collected columns the app
    can't log — per-core CPU (cpu.usage.<core>) and GPU (gpu.usage) — written to
    out_path. Used both to maintain the live temp file and to save a snapshot.
    """
    telemetry = telemetry_dataset.get(device_id)

    local_log = get_device_file(session_id, device_id, log_device_path, force_temp=True)
    with open(local_log, "r", encoding="utf-8") as f:
        lines = f.readlines()

    data_start = next(
        (i for i, ln in enumerate(lines) if ln.strip().startswith("test.timestamp")),
        len(lines),
    )
    preamble = lines[:data_start]
    reader = csv.DictReader(io.StringIO("".join(lines[data_start:])))
    fieldnames = list(reader.fieldnames or [])
    rows = list(reader)

    if telemetry and rows:
        first_ts = int(float(rows[0]["test.timestamp"]))
        log_elapsed = [(int(float(r["test.timestamp"])) - first_ts) / 1000.0 for r in rows]

        # Per-core CPU
        cpu = getattr(telemetry, "cpu_usage", None) or []
        if cpu:
            core_keys = sorted(
                {k for e in cpu for k in e.usage_pct if k.startswith("cpu") and k != "cpu"},
                key=lambda k: int(k[3:]) if k[3:].isdigit() else 0,
            )
            cpu_cols = {k: f"cpu.usage.{k[3:]}" for k in core_keys}
            for col in cpu_cols.values():
                if col not in fieldnames:
                    fieldnames.append(col)
            _merge_worker_series(rows, log_elapsed, cpu, cpu_cols)

        # GPU
        gpu = getattr(telemetry, "gpu_usage", None) or []
        if gpu:
            if "gpu.usage" not in fieldnames:
                fieldnames.append("gpu.usage")
            _merge_worker_series(rows, log_elapsed, gpu, {"gpu": "gpu.usage"})

    with open(out_path, "w", encoding="utf-8", newline="") as f:
        f.writelines(preamble)
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)

    return out_path


def get_active_log_path(session_id, device_id, app):
    """Newest log file in the app's test_results folder (the one being written)."""
    folders = vcat_adb.scan_vcat_data_folders(session_id, device_id)
    info = folders.get("vcat_ai" if app == "vcat_ai" else "vcat_d")
    if not info:
        return None
    tr = info["test_results"]
    cmd = ["adb", "-s", device_id, "shell", f"ls -1 {tr}/*.csv 2>/dev/null"]
    out = vcat_adb.run_adb_command_with_log(session_id, device_id, cmd, log_level="debug") or ""
    files = sorted(l.strip() for l in out.splitlines() if l.strip())
    return files[-1] if files else None


def _adb_exec_out(device_id, shell_cmd) -> bytes:
    """exec-out = raw bytes (no CRLF mangling), so byte offsets stay exact."""
    return subprocess.run(
        ["adb", "-s", device_id, "exec-out", shell_cmd], capture_output=True
    ).stdout


def _worker_extra_columns(device_id):
    """Fixed extra columns for a session: {cpu-core-key: column} + whether GPU exists."""
    telemetry = telemetry_dataset.get(device_id)
    cpu_cols, has_gpu = {}, False
    if telemetry:
        cpu = getattr(telemetry, "cpu_usage", None) or []
        core_keys = sorted(
            {k for e in cpu for k in e.usage_pct if k.startswith("cpu") and k != "cpu"},
            key=lambda k: int(k[3:]) if k[3:].isdigit() else 0,
        )
        cpu_cols = {k: f"cpu.usage.{k[3:]}" for k in core_keys}
        has_gpu = bool(getattr(telemetry, "gpu_usage", None))
    return cpu_cols, has_gpu


def _merge_extra(device_id, rows, log_elapsed, cpu_cols, has_gpu):
    telemetry = telemetry_dataset.get(device_id)
    if not telemetry:
        return
    if cpu_cols:
        _merge_worker_series(rows, log_elapsed, getattr(telemetry, "cpu_usage", []) or [], cpu_cols)
    if has_gpu:
        _merge_worker_series(rows, log_elapsed, getattr(telemetry, "gpu_usage", []) or [], {"gpu": "gpu.usage"})


def _init_session_file(device_id, log_path):
    raw = _adb_exec_out(device_id, f"cat '{log_path}'")
    last_nl = raw.rfind(b"\n")
    if last_nl < 0:
        return
    raw = raw[: last_nl + 1]  # only complete lines
    lines = raw.decode("utf-8", "replace").splitlines(keepends=True)
    data_start = next((i for i, ln in enumerate(lines) if ln.strip().startswith("test.timestamp")), None)
    if data_start is None:
        return
    preamble = lines[:data_start]
    orig_fields = next(csv.reader([lines[data_start]]))
    rows = list(csv.DictReader(io.StringIO("".join(lines[data_start:]))))

    cpu_cols, has_gpu = _worker_extra_columns(device_id)
    full_fields = list(orig_fields) + list(cpu_cols.values()) + (["gpu.usage"] if has_gpu else [])
    first_ts = int(float(rows[0]["test.timestamp"])) if rows else 0
    if rows:
        log_elapsed = [(int(float(r["test.timestamp"])) - first_ts) / 1000.0 for r in rows]
        _merge_extra(device_id, rows, log_elapsed, cpu_cols, has_gpu)

    temp_path = _session_files.get(device_id) or os.path.join(
        tempfile.gettempdir(), f"vcatweb_session_{device_id}.csv"
    )
    _session_files[device_id] = temp_path
    with open(temp_path, "w", encoding="utf-8", newline="") as f:
        f.writelines(preamble)
        w = csv.DictWriter(f, fieldnames=full_fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)

    _session_state[device_id] = {
        "log": log_path, "offset": len(raw), "orig_fields": orig_fields,
        "full_fields": full_fields, "first_ts": first_ts,
        "cpu_cols": cpu_cols, "has_gpu": has_gpu,
    }


def _append_session_file(device_id, log_path, st):
    raw = _adb_exec_out(device_id, f"tail -c +{st['offset'] + 1} '{log_path}'")
    last_nl = raw.rfind(b"\n")
    if last_nl < 0:
        return  # no complete new line yet
    raw = raw[: last_nl + 1]
    dict_rows = [
        dict(zip(st["orig_fields"], vals))
        for vals in csv.reader(io.StringIO(raw.decode("utf-8", "replace")))
        if vals
    ]
    dict_rows = [r for r in dict_rows if r.get("test.timestamp")]
    if dict_rows:
        log_elapsed = [(int(float(r["test.timestamp"])) - st["first_ts"]) / 1000.0 for r in dict_rows]
        _merge_extra(device_id, dict_rows, log_elapsed, st["cpu_cols"], st["has_gpu"])
        with open(_session_files[device_id], "a", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=st["full_fields"], extrasaction="ignore")
            w.writerows(dict_rows)
    st["offset"] += len(raw)


def refresh_session_file(session_id, device_id, app):
    """Maintain the live-session temp file by APPENDING the log's new rows
    (merged with ADB per-core CPU + GPU) — no full rebuild. Throttled."""
    now = time.time()
    if now - _session_file_last.get(device_id, 0) < SESSION_FILE_REFRESH:
        return
    _session_file_last[device_id] = now
    try:
        log_path = get_active_log_path(session_id, device_id, app)
        if not log_path:
            return
        st = _session_state.get(device_id)
        if st is None or st.get("log") != log_path:
            _init_session_file(device_id, log_path)  # new session / new test file
        else:
            _append_session_file(device_id, log_path, st)
    except Exception as e:
        logger.error(f"refresh_session_file failed: {e}")


@app.route("/api/vcat_monitor/save_session", methods=["POST"])
@require_valid_session_and_device
def api_save_session(session_id, device_id):
    try:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        temp_path = _session_files.get(device_id)
        st = _session_state.get(device_id)
        log_path = request.args.get("telemetry_file_path")

        # Snapshot = copy the live temp file (works even if the device disconnected).
        if temp_path and os.path.isfile(temp_path):
            log_name = log_path or (st and st.get("log")) or f"session_{device_id}"
            base = os.path.splitext(os.path.basename(log_name))[0]
            out_path = os.path.join(_sessions_dir(), f"{base}_snap_{stamp}.csv")
            shutil.copy(temp_path, out_path)
        elif log_path and log_path.startswith("/sdcard/"):
            base = os.path.splitext(os.path.basename(log_path))[0]
            out_path = os.path.join(_sessions_dir(), f"{base}_snap_{stamp}.csv")
            write_session_csv(session_id, device_id, log_path, out_path)  # fallback build
        else:
            return jsonify({"status": "error", "message": "No session data to save"}), 400

        return jsonify({"status": "saved", "name": os.path.basename(out_path), "path": out_path})
    except Exception as e:
        logger.error(f"save_session failed: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


_ORPHAN_PREFIX = "vcatweb_session_"


def _list_orphan_files():
    """Leftover live-session temp files from a previous run (crash / hard
    shutdown). A clean stop removes its temp file, so any that survive — and are
    not owned by a currently-active session — are orphans worth recovering."""
    tmpdir = tempfile.gettempdir()
    active = {os.path.abspath(p) for p in _session_files.values()}
    out = []
    try:
        for name in os.listdir(tmpdir):
            if not (name.startswith(_ORPHAN_PREFIX) and name.endswith(".csv")):
                continue
            path = os.path.join(tmpdir, name)
            if os.path.abspath(path) in active or not os.path.isfile(path):
                continue
            try:
                stt = os.stat(path)
            except OSError:
                continue
            out.append({
                "name": name,
                "device_id": name[len(_ORPHAN_PREFIX):-4],
                "size": stt.st_size,
                "mtime": stt.st_mtime,
            })
    except OSError:
        pass
    out.sort(key=lambda o: o["mtime"], reverse=True)
    return out


def _resolve_orphan_path(name):
    """Map a client-supplied name to a temp file, refusing path traversal."""
    if not name or os.path.basename(name) != name:
        return None
    if not (name.startswith(_ORPHAN_PREFIX) and name.endswith(".csv")):
        return None
    path = os.path.join(tempfile.gettempdir(), name)
    return path if os.path.isfile(path) else None


@app.route("/api/vcat_monitor/orphan_sessions", methods=["GET"])
@require_valid_session
def api_orphan_sessions(session_id):
    return jsonify({"orphans": _list_orphan_files()})


@app.route("/api/vcat_monitor/recover_orphan", methods=["POST"])
@require_valid_session
def api_recover_orphan(session_id):
    name = request.args.get("file")
    path = _resolve_orphan_path(name)
    if not path:
        return jsonify({"status": "error", "message": "Unknown orphan file"}), 400
    try:
        if request.args.get("discard") == "1":
            os.remove(path)
            return jsonify({"status": "discarded", "name": name})
        device_id = name[len(_ORPHAN_PREFIX):-4]
        stamp = datetime.fromtimestamp(os.path.getmtime(path)).strftime("%Y%m%d-%H%M%S")
        out_path = os.path.join(_sessions_dir(), f"recovered_{device_id}_{stamp}.csv")
        shutil.copy(path, out_path)
        os.remove(path)  # recovered — clear the orphan
        return jsonify({"status": "recovered", "name": os.path.basename(out_path), "path": out_path})
    except Exception as e:
        logger.error(f"recover_orphan failed: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/vcat_monitor/saved_sessions", methods=["GET"])
@require_valid_session
def api_saved_sessions(session_id):
    d = _sessions_dir()
    # Only our snapshot files (avoid listing unrelated CSVs in Downloads).
    files = sorted(
        (f for f in os.listdir(d) if f.endswith(".csv") and "_snap_" in f),
        reverse=True,
    )
    return jsonify([{"name": f} for f in files])


@app.route("/api/vcat_monitor/upload_session", methods=["POST"])
@require_valid_session
def api_upload_session(session_id):
    """Receive a browsed CSV, store it in the sessions dir, return its name so it
    can be opened via load_saved. No device required."""
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"status": "error", "message": "No file provided"}), 400
    name = os.path.basename(f.filename)
    f.save(os.path.join(_sessions_dir(), name))
    return jsonify({"status": "ok", "name": name})


@app.route("/api/vcat_monitor/load_saved", methods=["GET"])
@require_valid_session
def api_load_saved(session_id):
    """
    Load a saved session (host-side CSV) — no device required. Infers the app
    from the filename (or the `app` param) and returns the telemetry response.
    """
    name = request.args.get("name")
    if not name:
        return jsonify({"status": "error", "message": "Missing name"}), 400

    local_path = os.path.join(_sessions_dir(), os.path.basename(name))
    if not os.path.isfile(local_path):
        return jsonify({"status": "error", "message": "Saved session not found"}), 404

    app = request.args.get("app") or ("vcat_ai" if "vcatai" in os.path.basename(name) else "vcat_d")
    try:
        if app == "vcat_ai":
            telemetry = read_ai_telemetry_data(session_id, local_path)
            response = build_ai_telemetry_response(telemetry, "")
        else:
            telemetry = read_telemetry_data(session_id, local_path)
            response = build_telemetry_response(telemetry, "")
        response["app"] = app
        return Response(json.dumps(response, indent=2, sort_keys=False), mimetype="application/json")
    except Exception as e:
        logger.error(f"load_saved failed: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/vcat_monitor/telemetry_from_file", methods=["GET"])
@require_valid_session_and_device
def api_telemetry_from_file(session_id, device_id):

    device_file_path = request.args.get("telemetry_file_path")
    if not device_file_path:
        return (
            jsonify(
                {
                    "status": "error",
                    "message": "Missing required query parameter: file_path",
                }
            ),
            400,
        )

    logger.info(
        f"api_telemetry_from_file: [{session_id}] [{device_id}] [{device_file_path}]"
    )
    local_path = ""

    try:
        if request.args.get("saved") == "1":
            # Host-side saved session (output/sessions/); basename guards traversal.
            local_path = os.path.join(_sessions_dir(), os.path.basename(device_file_path))
            if not os.path.isfile(local_path):
                return jsonify({"status": "error", "message": "Saved session not found"}), 404
        else:
            local_path = get_device_file(
                session_id=session_id,
                device_id=device_id,
                device_file_path=device_file_path,
                force_temp=True,  # ignore caller's destination
            )

        app = request.args.get("app")
        if not app:
            app = "vcat_ai" if "vcatai" in os.path.basename(device_file_path) else "vcat_d"

        if app == "vcat_ai":
            telemetry = read_ai_telemetry_data(session_id, local_path)
            response = build_ai_telemetry_response(telemetry, device_id)
        else:
            telemetry = read_telemetry_data(session_id, local_path)
            response = build_telemetry_response(telemetry, device_id)

        return Response(
            json.dumps(response, indent=2, sort_keys=False), mimetype="application/json"
        )

    except Exception as e:
        logger.error(f"message: [{str(e)}]")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/vcat_monitor/download_telemetry_file", methods=["GET"])
@require_valid_session_and_device
def api_export_telemetry_file(session_id, device_id):
    device_file_path = request.args.get("telemetry_file_path")
    requested_mimetype = request.args.get("mimetype", "text/csv")

    if not device_file_path:
        return (
            jsonify(
                {
                    "status": "error",
                    "message": "Missing required query parameter: telemetry_file_path",
                }
            ),
            400,
        )

    allowed_mimetypes = {
        "text/csv",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }

    if requested_mimetype not in allowed_mimetypes:
        return jsonify({"error": f"Unsupported mimetype: {requested_mimetype}"}), 400

    logger.info(
        f"api_export_telemetry_file: [{session_id}] [{device_id}] input=[{device_file_path}] mime_type=[{requested_mimetype}]"
    )

    try:
        local_path = get_device_file(
            session_id=session_id,
            device_id=device_id,
            device_file_path=device_file_path,
            force_temp=True,  # ensure a local copy
        )

        base_name = os.path.basename(device_file_path)
        name_root = os.path.splitext(base_name)[0]

        if requested_mimetype == "text/csv":
            return send_file(
                local_path,
                mimetype="text/csv",
                as_attachment=True,
                download_name=f"{name_root}.csv"
            )

        telemetry = read_telemetry_data(session_id, local_path)

        # Generate export in a temp location
        from tempfile import NamedTemporaryFile
        with NamedTemporaryFile(suffix=".xlsx", delete=False) as temp_file:
            export_path = temp_file.name

        # Attempt export
        exported_file = export_telemetry(session_id, device_id, telemetry, export_path)

        # Derive output filename from input CSV
        base_name = os.path.basename(device_file_path)
        download_name = os.path.splitext(base_name)[0] + ".xlsx"

        return send_file(
            export_path,
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            as_attachment=True,
            download_name=download_name  # ← matches base name
        )

    except Exception as e:
        logger.error(f"Export failed: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/vcat_monitor/telemetry", methods=["GET"])
@require_valid_session_and_device
def api_telemetry(session_id, device_id):

    with session_thread_lock:
        telemetry = telemetry_dataset.get(device_id)

        if not telemetry:
            logger.error(
                f"/api/vcat_monitor/telemetry: Device [{device_id}] not being monitored"
            )
            return jsonify({"error": "Device not being monitored"}), 404

        if telemetry.start_time < 0:
            logger.debug(
                f"/api/vcat_monitor/telemetry: Device [{device_id}] tlemetry not avaiable yet"
            )
            return jsonify({"message": "Telemetry not avaiable yet."}), 202

        response = build_telemetry_response(telemetry, device_id)
        response["disconnected"] = device_id in _disconnected_devices

        touch_session_access(session_id, device_id)
        vcat_adb.touchConsole(session_id)

        return Response(
            json.dumps(response, indent=2, sort_keys=False), mimetype="application/json"
        )


@app.route("/api/vcat_monitor/start", methods=["POST"])
@require_valid_session_and_device
def api_start_device_monitor(session_id, device_id):

    app = request.args.get("app", "vcat_d")
    package = _package_for_app(app)

    existing = telemetry_dataset.get(device_id)
    if existing is not None:
        if getattr(existing, "app", "vcat_d") == app:
            return jsonify({"status": "already_monitored", "app": app}), 200
        # A different app is monitored on this device — switch to the requested one.
        with session_thread_lock:
            telemetry_dataset.pop(device_id, None)
            session_last_access.pop(device_id, None)

    # vcat-d and vcat-ai can't run together — stop the other before launching.
    other_package = _package_for_app("vcat_d" if app == "vcat_ai" else "vcat_ai")
    vcat_adb.run_adb_command_with_log(
        session_id, device_id,
        ["adb", "-s", device_id, "shell", "am", "force-stop", other_package],
    )

    if not is_vcat_running(session_id, device_id, package):
        launched, already_running = launch_vcat(session_id, device_id, package)
        if not launched and not already_running:
            logger.error(f"Unable to launch {package}")
        time.sleep(0.5)

    device_info, error_response = get_device_info(session_id, device_id, refresh=True)
    if error_response:
        return error_response

    if device_info is None:
        return make_response(jsonify({"error": "Missing device info"}), 500)

    time.sleep(0.5)

    telemetry_data = resetTelemetry(session_id, device_id, app=app)
    telemetry_data.device_info = device_info

    touch_session_access(session_id, device_id)

    create_telemetry_excel(telemetry_data)

    if vcat_adb.console_thread is None or not vcat_adb.console_thread.is_alive():
        stop_event.clear()
        vcat_adb.console_thread = threading.Thread(target=telemetry_worker, daemon=True)
        vcat_adb.console_thread.start()

    return jsonify({"status": "monitoring_started", "device_id": device_id, "app": app}), 200


@app.route("/api/vcat_monitor/connected", methods=["GET"])
@require_valid_session_and_device
def api_is_connected(session_id, device_id):

    if device_id in telemetry_dataset:
        return (
            jsonify(
                {
                    "monitored": True,
                    "app": getattr(telemetry_dataset[device_id], "app", "vcat_d"),
                    "status": f"device_id '{device_id}' is being monitored by session_id '{session_id}'",
                }
            ),
            200,
        )

    return (
        jsonify(
            {
                "monitored": False,
                "status": f"device_id '{device_id}' is not being monitored by session_id '{session_id}'",
            }
        ),
        200,
    )


@app.route("/api/vcat_monitor/stop", methods=["POST"])
@require_valid_session_and_device
def api_stop_device_monitor(session_id, device_id):

    if not device_id in telemetry_dataset:
        logger.error(f"api/vcat_monitor/stop: device id '[{device_id}] not found")
        return jsonify({"status": "not_found", "device_id": device_id}), 202

    with session_thread_lock:
        telemetry_dataset.pop(device_id, None)
        session_last_access.pop(device_id, None)
        close_telemetry_excel(session_id)

        if not telemetry_dataset:
            stop_event.set()

    # Drop the live-session temp file for this device.
    _session_file_last.pop(device_id, None)
    _session_state.pop(device_id, None)
    _disconnected_devices.discard(device_id)
    tmp = _session_files.pop(device_id, None)
    if tmp:
        try:
            os.remove(tmp)
        except OSError:
            pass

    logger.info(
        f"api/vcat_monitor/stop: executed for device id '[{device_id}] and session_id '[{session_id}]"
    )
    return jsonify({"status": "monitoring_stopped", "device_id": device_id}), 200


@app.route("/api/vcat_monitor/monitored_devices", methods=["GET"])
@require_valid_session_and_device
def api_monitored_devices(session_id):

    with session_thread_lock:
        devices = [
            {"device_id": data.device_id, "ip_address": data.device_ipaddr}
            for data in telemetry_dataset.values()
        ]
    return jsonify({"devices": devices}), 200


@app.route("/api/vcat_monitor/raw_cpu", methods=["GET"])
@require_valid_session_and_device
def api_cpu(session_id, device_id):

    if not device_id in telemetry_dataset:
        logger.error(f"/api/vcat_monitor/raw_cpu: not monitoring device [{device_id}]")
        return jsonify({"error": "not_monitoring", "device_id": device_id}), 400

    touch_session_access(session_id, device_id)

    cpu_stats = {}

    with session_thread_lock:
        cpu_stats = telemetry_dataset[device_id].cpu_usage

    return jsonify(
        {
            "timestamp": datetime.now().isoformat(),
            "cpu_stats": cpu_stats,
        }
    )


@app.route("/api/vcat_monitor/reset", methods=["POST"])
@require_valid_session_and_device
def api_vcat_monitor_reset(session_id, device_id):

    with session_thread_lock:
        if telemetry_dataset.get(device_id) is None:
            return (
                jsonify(
                    {f"status": "no telemetry session for device_id: [{device_id}]"}
                ),
                200,
            )

    resetTelemetry(session_id, device_id)

    return jsonify({"status": "telemetry reset completed"}), 200


@app.route("/api/vcat_monitor/connected", methods=["POST"])
@require_valid_session_and_device
def api_vcat_monitor_is_connected(session_id, device_id):

    if not device_id in telemetry_dataset:
        logger.info(f"/api/vcat_monitor/raw_cpu: not monitoring device [{device_id}]")
        return jsonify({"status": "not_monitoring", "device_id": device_id}), 204

    return jsonify({"status": "telemetry connected", "device_id": device_id}), 200


##########################################
# Main code area
##########################################

# Start the cleanup thread
cleanup_thread = threading.Thread(target=console_cleanup_loop, daemon=True)
cleanup_thread.start()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="VCAT Telemetry Server")
    parser.add_argument(
        "--port", type=int, default=5050, help="Port to run the server on"
    )
    parser.add_argument(
        "--host", type=str, default="127.0.0.1", help="Host to bind the server to"
    )
    args = parser.parse_args()
    app.run(host=args.host, port=args.port, debug=True)


@atexit.register
def cleanup_caffeinate():
    if caffeinate_proc and caffeinate_proc.poll() is None:
        caffeinate_proc.terminate()
