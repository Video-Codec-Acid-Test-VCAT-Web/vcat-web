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
ADB utilities for device communication, session management, and telemetry collection.
"""

from dataclasses import asdict, dataclass, field, is_dataclass
from typing import Dict, List, Optional
import re
import os
import threading
from collections import OrderedDict
import time
from datetime import datetime
import subprocess
from dataclasses import dataclass
from vcat_logging import logger

__all__ = [
    "SessionConsoleLogEntry",
    "SessionConsole",
    "touchConsole",
    "log_console_entry",
    "run_adb_command_with_log"

]

@dataclass
class SessionConsoleLogEntry:
    time: float  # Unix timestamp (for pruning)
    date: str  # Human-readable timestamp string (e.g., '23:45:01')
    text: str  # Full command + output block, with embedded \n


@dataclass
class SessionConsole:
    last_access: float
    history: List[SessionConsoleLogEntry] = field(default_factory=list)


session_consoles: Dict[str, SessionConsole] = OrderedDict()
console_thread = None
console_thread_lock = threading.RLock()

MAX_CONSOLE_LINES = 500


BROADCAST_COMMANDS = {
    "log_http_port": "com.roncatech.vcat.ADB_LOG_HTTP_INFO",
    "log_http_port_ai": "com.roncatech.vcat_ai.ADB_LOG_HTTP_INFO",
    "log_root": "com.roncatech.vcat.ACTION_LOG_ROOT",
}


def touchConsole(session_id: str):
    with console_thread_lock:
        console = session_consoles.get(session_id)
        if console:
            console.last_access = time.time()


def log_console_entry(session_id: str, text: str):
    now = time.time()
    timestamp = datetime.now().strftime("%H:%M:%S")

    entry = SessionConsoleLogEntry(time=now, date=timestamp, text=text)

    if session_id not in session_consoles:
        session_consoles[session_id] = SessionConsole(last_access=now)

    log = session_consoles[session_id]
    log.history.append(entry)
    touchConsole(session_id)

    if len(log.history) > MAX_CONSOLE_LINES:
        log.history = log.history[-MAX_CONSOLE_LINES:]


def reset_session_console(session_id: str):
    now = time.time()

    with console_thread_lock:
        session_consoles[session_id] = SessionConsole(
            last_access=now, history=[]
        )

    touchConsole(session_id)


def isSessionValid(session_id: str) -> bool:
    with console_thread_lock:
        if(session_consoles.get(session_id) is not None):
            return True
        return False


def run_adb_command_with_log(
    session_id: str, device_id: str, cmd: List[str], log_level: str = "info"
):
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        output = result.stdout.strip()
        error = result.stderr.strip() if result.stderr else ""

        if log_level != "debug" and session_id in session_consoles:
            log_text = f"$ {' '.join(cmd)}\n"
            if output:
                log_text += f"[OUT] {output}\n"
            if error:
                log_text += f"[ERR] {error}"
                logger.error(log_text)
            log_console_entry(session_id, log_text)

        return output

    except subprocess.CalledProcessError as e:
        error_msg = e.stderr.strip() if e.stderr else str(e)
        log_console_entry(session_id, f"$ {' '.join(cmd)}\n[ERR] {error_msg}")
        logger.error(error_msg);
        return None


def get_adb_devices(session_id, log_level: str = "info"):
    cmd = ["adb", "devices"]

    # device_id is not needed for this command, so pass an empty string
    stdout = run_adb_command_with_log(
        session_id=session_id, device_id="", cmd=cmd, log_level=log_level
    )

    if stdout is None:
        return []

    lines = stdout.strip().splitlines()[1:]  # Skip the "List of devices attached" line
    return [line.split()[0] for line in lines if "device" in line]


def is_valid_device(session_id, device_id):
    return device_id in get_adb_devices(session_id)

def send_adb_broadcast(session_id, device_id, command_key, extras=None):
    if not is_valid_device(session_id, device_id):
        logger.error(f"[ERROR] Invalid device.")
        return

    if command_key not in BROADCAST_COMMANDS:
        logger.error(f"[ERROR] Unknown broadcast command: {command_key}")
        return

    base_cmd = [
        "adb",
        "-s",
        device_id,
        "shell",
        "am",
        "broadcast",
        "-a",
        BROADCAST_COMMANDS[command_key],
    ]

    if extras:
        for key, value in extras.items():
            base_cmd += ["--es", key, value]

    output = run_adb_command_with_log(session_id, device_id, base_cmd, log_level="info")

    if output is not None:
        print(f"[Broadcast '{command_key}' sent]")
        print(output)
    else:
        print(f"[Broadcast '{command_key}' failed']")

def get_cpu_frequencies(device_id):
    try:
        result = subprocess.run(
            [
                "adb",
                "-s",
                device_id,
                "shell",
                "cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        freqs = result.stdout.strip().splitlines()
        freq_dict = {
            f"core{i}": int(freq) // 1000 for i, freq in enumerate(freqs)
        }  # Convert to MHz
        return freq_dict
    except Exception as e:
        logger.error(f"[get_cpu_frequencies ERROR] {e}")
        return {}

ipCache: OrderedDict[str, str] = OrderedDict()

def get_device_ip(session_id: str, device_id: str) -> Optional[str]:
    cmd = ["adb", "-s", device_id, "shell", "ip", "route"]
    output = run_adb_command_with_log(session_id, device_id, cmd)

    if not output:
        return None

    # Look for 'src <ip>' in output
    for line in output.splitlines():
        match = re.search(r"\bsrc\s+(\d+\.\d+\.\d+\.\d+)", line)
        if match:
            return match.group(1)

    return None
    

def _resolve_http_server(session_id, device_id, broadcast_key, cache_key):
    """
    Asks a VCAT app to log its HTTP server address via broadcast, then scrapes
    logcat for the "HTTP server @ <ip>:<port>" line and returns "http://ip:port".

    Not filtered by logcat tag: vcat-d and vcat-ai log under different tags. We
    take the most recent match, which corresponds to the broadcast just sent.
    """
    if cache_key in ipCache:
        return ipCache[cache_key]

    try:
        # Clear logcat first so only this app's fresh response is present (both
        # vcat-d and vcat-ai log an "HTTP server @ ip:port" line), then broadcast.
        subprocess.run(["adb", "-s", device_id, "logcat", "-c"], capture_output=True)
        send_adb_broadcast(session_id, device_id, broadcast_key)

        # The app logs its address asynchronously after handling the broadcast, so
        # poll logcat until the line appears.
        for _ in range(6):
            result = subprocess.run(
                ["adb", "-s", device_id, "logcat", "-d"],
                capture_output=True, text=True, check=True,
            )
            matches = re.findall(
                r"HTTP server @ ((?:\d{1,3}\.){3}\d{1,3}):(\d+)", result.stdout
            )
            if matches:
                ip_address, port = matches[-1]
                addr = f"http://{ip_address}:{port}"
                log_console_entry(session_id, f"[VCAT] {device_id} ip_addr: {addr}")
                print(f"[VCAT] {device_id} ip_addr: {addr}")
                ipCache[cache_key] = addr
                return addr
            time.sleep(0.5)

        logger.error("[VCAT] ERROR: Could not find HTTP server line in logcat")
        log_console_entry(
            session_id, "[VCAT] ERROR: Could not find HTTP server line in logcat"
        )
        return None

    except Exception as e:
        msg = f"[VCAT] Exception during IP/port retrieval: {str(e)}"
        logger.error(msg)
        log_console_entry(session_id, msg)
        return None


def get_device_ip_and_port(session_id, device_id):
    """Resolve the vcat-d app's HTTP server address."""
    return _resolve_http_server(session_id, device_id, "log_http_port", device_id)


def get_ai_device_ip_and_port(session_id, device_id):
    """Resolve the vcat-ai app's HTTP server address (separate cache key/port)."""
    return _resolve_http_server(
        session_id, device_id, "log_http_port_ai", f"{device_id}:ai"
    )


rootFolderCache: OrderedDict[str, str] = OrderedDict()


def get_device_root_folder(session_id: str, device_id: str) -> Optional[str]:
    """
    Discovers the on-device VCAT data folder (which the user selects/creates and
    can be named anything) by asking the app to log it.

    Sends the ACTION_LOG_ROOT broadcast; the app responds by logging a line under
    the "CommandReceiver" tag:
        root_folder=/sdcard/vcat-d (uri=content://.../tree/primary%3Avcat-d)
    We scrape that line from logcat and return the path portion.
    """
    if device_id in rootFolderCache:
        return rootFolderCache[device_id]

    send_adb_broadcast(session_id, device_id, "log_root")

    try:
        # NOTE: the app logs this under the "CommandReceiver" tag, NOT "VCAT".
        logcat_cmd = ["adb", "-s", device_id, "logcat", "-d", "-s", "CommandReceiver"]
        result = subprocess.run(logcat_cmd, capture_output=True, text=True, check=True)
        log_output = result.stdout

        # Take the last match in case stale entries are present in the buffer.
        matches = re.findall(r"root_folder=(.+?)\s+\(uri=", log_output)
        if matches:
            root_folder = matches[-1].strip()
            log_console_entry(
                session_id, f"[VCAT] {device_id} root_folder: {root_folder}"
            )
            print(f"[VCAT] {device_id} root_folder: {root_folder}")
            rootFolderCache[device_id] = root_folder
            return root_folder

        logger.error("[VCAT] ERROR: Could not find root_folder line in logcat")
        log_console_entry(
            session_id, "[VCAT] ERROR: Could not find root_folder line in logcat"
        )
        return None

    except Exception as e:
        msg = f"[VCAT] Exception during root folder retrieval: {str(e)}"
        logger.error(msg)
        log_console_entry(session_id, msg)
        return None


def scan_vcat_data_folders(session_id: str, device_id: str) -> dict:
    """
    Locate each VCAT app's data folder by scanning /sdcard for a `test_results`
    subfolder containing that app's log files (vcatd_log_* / vcatai_log_*).

    Works WITHOUT the app running (no broadcast needed), so non-live log viewing
    doesn't require vcat-d/vcat-ai to be launched. Returns e.g.:
        {"vcat_d": {"root": "...", "test_results": ".../test_results"},
         "vcat_ai": {"root": "...", "test_results": ".../test_results"}}
    """
    # find can exit non-zero on permission-denied dirs; don't use check=True.
    find = subprocess.run(
        ["adb", "-s", device_id, "shell",
         "find /sdcard -maxdepth 6 -type d -name test_results 2>/dev/null"],
        capture_output=True, text=True,
    )

    # Candidate test_results dirs: scan results first, then known defaults (covers
    # devices where find is unavailable/limited, or the folder is the default).
    candidates, seen = [], set()
    for line in find.stdout.splitlines():
        d = line.strip()
        if d and d not in seen:
            seen.add(d)
            candidates.append(d)
    for default_root in ("/sdcard/vcat-d", "/sdcard/vcat-ai"):
        d = f"{default_root}/test_results"
        if d not in seen:
            seen.add(d)
            candidates.append(d)

    result: Dict[str, dict] = {}
    for tr in candidates:
        listing = subprocess.run(
            ["adb", "-s", device_id, "shell", f"ls '{tr}' 2>/dev/null"],
            capture_output=True, text=True,
        ).stdout
        names = [n.strip() for n in listing.splitlines() if n.strip()]
        root = tr.rsplit("/", 1)[0]

        if "vcat_d" not in result and any(
            n.startswith("vcatd_log_") or n.startswith("logs_") for n in names
        ):
            result["vcat_d"] = {"root": root, "test_results": tr}
        if "vcat_ai" not in result and any(n.startswith("vcatai_log_") for n in names):
            result["vcat_ai"] = {"root": root, "test_results": tr}

    logger.info(f"[scan] {device_id} vcat folders: {result}")
    return result


def list_installed_packages(session_id: str, device_id: str) -> set:
    """Returns the set of package names installed on the device (via `pm list packages`)."""
    cmd = ["adb", "-s", device_id, "shell", "pm", "list", "packages"]
    output = run_adb_command_with_log(
        session_id=session_id, device_id=device_id, cmd=cmd, log_level="debug"
    )
    packages = set()
    for line in (output or "").splitlines():
        line = line.strip()
        if line.startswith("package:"):
            packages.add(line[len("package:"):])
    return packages


def get_battery_level(device_id):
    try:
        result = subprocess.run(
            ["adb", "-s", device_id, "shell", "dumpsys", "battery"],
            capture_output=True,
            text=True,
            check=True,
        )
        for line in result.stdout.splitlines():
            if "level:" in line:
                return int(line.strip().split(":")[1].strip())
    except Exception as e:
        logger.error(f"[Battery Error] {e}")
    return None


def get_system_memory(device_id):
    result = subprocess.run(
        ["adb", "-s", device_id, "shell", "cat /proc/meminfo"],
        capture_output=True,
        text=True,
    )
    meminfo = {}
    for line in result.stdout.splitlines():
        if ":" in line:
            key, val = line.split(":", 1)
            meminfo[key.strip()] = int(val.strip().split()[0])  # value in kB
    mem_total = meminfo.get("MemTotal", 0)
    mem_available = meminfo.get("MemAvailable", 0)
    mem_used = mem_total - mem_available
    return mem_total, mem_used


def get_app_memory(device_id, package="com.roncatech.vcat"):
    try:
        result = subprocess.run(
            ["adb", "-s", device_id, "shell", "dumpsys", "meminfo", package],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("TOTAL"):
                parts = line.split()
                if len(parts) >= 2 and parts[1].isdigit():
                    return int(parts[1])  # PSS in KB
    except Exception as e:
        logger.error(f"[get_app_memory ERROR] {e}")
    return None
