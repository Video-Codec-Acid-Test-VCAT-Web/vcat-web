import argparse
import json
import re
import struct
import subprocess
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List
import random
import uuid

import requests
from flask import send_from_directory

from flask import Flask, jsonify, request, Response


@dataclass
class BatteryEntry:
    elapsed_time: float
    battery_level: float

@dataclass
class FramedropEntry:
    elapsed_time: float
    delta_framedrops: int

@dataclass
class MemoryEntry:
    elapsed_time: float
    total_kb: int
    used_kb: int


@dataclass
class AppMemoryEntry:
    elapsed_time: float
    app_kb: int


@dataclass
class CpuUsageEntry:
    elapsed_time: float
    usage_pct: Dict[str, float]
    raw_stats: Dict[
        str, List[int]
    ]  # e.g., {"cpu": [...], "cpu0": [...], "cpu1": [...]}


@dataclass
class CpuFreguencyEntry:
    elapsed_time: float
    frequencies: Dict[str, int]


@dataclass
class TelemetryData:
    device_id: str
    device_ipaddr: str
    start_time: float
    battery_data: list[BatteryEntry]
    system_memory: list[MemoryEntry]
    app_memory: list[AppMemoryEntry]
    frame_drops : list[FramedropEntry]
    cpu_freq: List[CpuFreguencyEntry]
    cpu_usage: List[CpuUsageEntry] = field(default_factory=list)


telemetry_dataset = OrderedDict()
device_last_access: OrderedDict[str, float] = OrderedDict()

@dataclass
class SessionConsoleLogEntry:
    time: float       # Unix timestamp (for pruning)
    date: str         # Human-readable timestamp string (e.g., '23:45:01')
    text: str         # Full command + output block, with embedded \n

@dataclass
class SessionConsoleLog:
    last_access: float
    history: List[SessionConsoleLogEntry] = field(default_factory=list)

session_console_logs : Dict[str, SessionConsoleLog] = OrderedDict()
session_thread_lock = threading.Lock()

MAX_CONSOLE_LINES = 500


monitor_thread = None
monitor_thread_lock = threading.Lock()


app = Flask(__name__, static_folder='static')

@app.route('/')
def serve_index():
    return send_from_directory('static', 'index.html')

BROADCAST_COMMANDS = {
    "log_http_port": "org.videolan.vlcbenchmark.ADB_LOG_HTTP_INFO",
}

def touch_session(session_id: str):
    with session_thread_lock:
        session = session_console_logs.get(session_id)
        if session:
            session.last_access = time.time()

def log_console_entry(session_id: str, text: str):
    now = time.time()
    timestamp = datetime.now().strftime("%H:%M:%S")

    entry = SessionConsoleLogEntry(time=now, date=timestamp, text=text)

    if session_id not in session_console_logs:
        session_console_logs[session_id] = SessionConsoleLog(last_access=now)

    log = session_console_logs[session_id]
    log.history.append(entry)
    log.last_access = now

    if len(log.history) > MAX_CONSOLE_LINES:
        log.history = log.history[-MAX_CONSOLE_LINES:]

def run_adb_command_with_log(session_id: str, device_id: str, cmd: List[str], log_level: str = "info"):
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        output = result.stdout.strip()
        error = result.stderr.strip() if result.stderr else ""

        if log_level != "debug" or session_id in session_console_logs:
            log_text = f"$ {' '.join(cmd)}\n"
            if output:
                log_text += f"[OUT] {output}\n"
            if error:
                log_text += f"[ERR] {error}"
            log_console_entry(session_id, log_text)

        return output

    except subprocess.CalledProcessError as e:
        error_msg = e.stderr.strip() if e.stderr else str(e)
        if log_level != "debug" or session_id in session_console_logs:
            log_console_entry(session_id, f"$ {' '.join(cmd)}\n[ERR] {error_msg}")
        return None


def get_adb_devices(session_id, log_level: str = "info"):
    cmd = ["adb", "devices"]

    # device_id is not needed for this command, so pass an empty string
    stdout = run_adb_command_with_log(
        session_id=session_id,
        device_id="",
        cmd=cmd,
        log_level=log_level
    )

    if stdout is None:
        return []

    lines = stdout.strip().splitlines()[1:]  # Skip the "List of devices attached" line
    return [line.split()[0] for line in lines if "device" in line]


def is_valid_device(session_id, device_id):
    return device_id in get_adb_devices(session_id)


def send_adb_broadcast(session_id, device_id, command_key, extras=None):
    if not is_valid_device(session_id, device_id):
        print("[ERROR] Invalid device.")
        return

    if command_key not in BROADCAST_COMMANDS:
        print(f"[ERROR] Unknown broadcast command: {command_key}")
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
        print(f"[get_cpu_stats ERROR] {e}")
        return None


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
        print(f"[get_cpu_frequencies ERROR] {e}")
        return {}


def get_device_ip_and_port(session_id, device_id):
    send_adb_broadcast(session_id, device_id, "log_http_port")  # This already logs

    try:
        # Run logcat directly without logging full output
        logcat_cmd = ["adb", "-s", device_id, "logcat", "-d", "-s", "VCAT"]
        result = subprocess.run(logcat_cmd, capture_output=True, text=True, check=True)
        log_output = result.stdout

        # Extract port line from log
        match = re.search(r"VCAT.*HTTP server on port (\d+)", log_output)
        if match:
            port = int(match.group(1))

            # Get IP address and log it normally
            ip_cmd = ["adb", "-s", device_id, "shell", "ip -f inet addr show wlan0"]
            ip_output = run_adb_command_with_log(session_id, device_id, ip_cmd, log_level="info")

            ip_match = re.search(r"inet (\d+\.\d+\.\d+\.\d+)", ip_output or "")
            ip_address = ip_match.group(1) if ip_match else "127.0.0.1"

            log_console_entry(session_id, f"[VCAT] {device_id} ip_addr: http://{ip_address}:{port}")

            return f"http://{ip_address}:{port}"

        else:
            log_console_entry(session_id, "[VCAT] ERROR: Could not find port in logcat")
            return None

    except Exception as e:
        log_console_entry(session_id, f"[VCAT] Exception during IP/port retrieval: {str(e)}")
        return None

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
        print(f"[Battery Error] {e}")
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


def get_app_memory(device_id, package="org.videolan.vlc"):
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
        print(f"[get_app_memory ERROR] {e}")
    return None


def get_framedrop_stats(device_id):
    return random.randint(0, 10)

def telemetry_worker():
    global last_core_times

    MAX_ACCESS_SPAN = (
        3600 * 2
    )  # 2 hours without any activity on a connected device will be considered stale

    print("[Monitor] telemetry_worker started")

    while True:
        if not telemetry_dataset:
            print("[Monitor] No devices left, stopping telemetry monitor")
            break

        for device_id, telemetry_data in telemetry_dataset.items():

            # is current connection stale?
            last_access = device_last_access.get(device_id, 0)
            time_since_access = time.time() - last_access

            if time_since_access > MAX_ACCESS_SPAN:
                print(
                    f"[Monitor] Device {device_id} stale for {time_since_access:.1f}s, removing from monitor list"
                )
                with monitor_thread_lock:
                    telemetry_dataset.pop(device_id, None)
                    device_last_access.pop(device_id, None)
                continue  # Skip to next device

            battery = get_battery_level(device_id)
            elapsed = time.time() - telemetry_data.start_time
            total_kb, used_kb = get_system_memory(device_id)
            app_kb = get_app_memory(device_id)
            frame_drops = get_framedrop_stats(device_id)

            if telemetry_data.cpu_usage:
                prev_raw_data = telemetry_data.cpu_usage[-1].raw_stats
            else:
                prev_raw_data = {}

            cur_cpu_usage = get_cpu_stats(device_id, elapsed, prev_raw_data)

            cpu_freqs = get_cpu_frequencies(device_id)

            with monitor_thread_lock:
                if battery is not None:
                    telemetry_data.battery_data.append(
                        BatteryEntry(elapsed_time=elapsed, battery_level=battery)
                    )

                if total_kb is not None and used_kb is not None:
                    telemetry_data.system_memory.append(
                        MemoryEntry(
                            elapsed_time=elapsed, total_kb=total_kb, used_kb=used_kb
                        )
                    )

                if app_kb is not None:
                    telemetry_data.app_memory.append(
                        AppMemoryEntry(elapsed_time=elapsed, app_kb=app_kb)
                    )

                if frame_drops is not None:
                    telemetry_data.frame_drops.append(
                        FramedropEntry(elapsed_time=elapsed, delta_framedrops=frame_drops)
                    )

                if cur_cpu_usage is not None:
                    telemetry_data.cpu_usage.append(cur_cpu_usage)

                if cpu_freqs:
                    telemetry_data.cpu_freq.append(
                        CpuFreguencyEntry(elapsed_time=elapsed, frequencies=cpu_freqs)
                    )

        time.sleep(5)


def isSessionValid(session_id: str) -> bool:
    with session_thread_lock:
        session = session_console_logs.get(session_id)
        if session:
            session.last_access = time.time()
            return True
        return False

MAX_SESSION_ACCESS_SPAN = 30 * 60  # 30 minutes

def session_cleanup_loop():
    while True:
        now = time.time()
        with session_thread_lock:
            expired = [sid for sid, log in session_console_logs.items()
                       if now - log.last_access > MAX_SESSION_ACCESS_SPAN]
            for sid in expired:
                print(f"[Session Cleanup] Expiring session {sid}")
                del session_console_logs[sid]
        time.sleep(60)



@app.route("/api/session_token", methods=["GET"])
def session_token():
    token = str(uuid.uuid4())
    session_console_logs[token] = SessionConsoleLog(last_access=time.time())
    return jsonify({
        "session_token": token
    })

@app.route("/api/session_console_log", methods=["GET"])
def session_console_log():
    session_id = request.args.get("session") or "<invalid token>"
    if not isSessionValid(session_id):
        return jsonify({"error": "Invalid or missing session_id"}), 400
  
    log_data = session_console_logs.get(session_id)

    if not log_data:
        return jsonify({"error": "Invalid or missing session_id"}), 400

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

    return Response(json.dumps(ordered, indent=2, sort_keys=False), mimetype="application/json")

@app.route("/api/all_connected_devices", methods=["GET"])
def api_devices():
    session_id = request.args.get("session") or "<invalid token>"
    if not isSessionValid(session_id):
     return jsonify({"error": "Invalid or missing session_id"}), 400


    return jsonify(get_adb_devices(session_id))


@app.route("/api/device/address_of", methods=["GET"])
def api_ip_port():
    session_id = request.args.get("session") or "<invalid token>"
    if not isSessionValid(session_id):
        return jsonify({"error": "Invalid or missing session_id"}), 400

    device_id = request.args.get("device")
    if not device_id or not is_valid_device(session_id, device_id):
        return jsonify({"error": "Invalid or missing device ID"}), 400

    info = get_device_ip_and_port(session_id, device_id)
    if info:
        return jsonify({"address": info})
    return jsonify({"error": "Could not determine IP or port"}), 404


@app.route("/api/device/info", methods=["GET"])
def api_device_info():
    session_id = request.args.get("session") or "<invalid token>"
    if not isSessionValid(session_id):
        return jsonify({"error": "Invalid or missing session_id"}), 400

    device_id = request.args.get("device")
    if not device_id:
        return jsonify({"error": "Missing device_id"}), 400

    ipAddr = get_device_ip_and_port(session_id, device_id)
    if not ipAddr:
        return jsonify({"error": "Could not determine IP or port"}), 404

    try:
        url = f"{ipAddr}/device_info"
        response = requests.get(url, timeout=5)
        response.raise_for_status()
        return Response(
            response.text, status=response.status_code, mimetype="application/json"
        )
    except requests.RequestException as e:
        return jsonify({"error": f"Failed to fetch device info: {str(e)}"}), 500

@app.route("/api/device/run_config", methods=["GET"])
def api_device_run_config():
    session_id = request.args.get("session") or "<invalid token>"
    if not isSessionValid(session_id):
        return jsonify({"error": "Invalid or missing session_id"}), 400

    device_id = request.args.get("device")
    if not device_id:
        return jsonify({"error": "Missing device_id"}), 400

    ipAddr = get_device_ip_and_port(session_id, device_id)
    if not ipAddr:
        return jsonify({"error": "Could not determine IP or port"}), 404

    try:
        url = f"{ipAddr}/run_config"
        response = requests.get(url, timeout=5)
        response.raise_for_status()
        return Response(
            response.text, status=response.status_code, mimetype="application/json"
        )
    except requests.RequestException as e:
        return jsonify({"error": f"Failed to fetch run config: {str(e)}"}), 500

@app.route("/api/vcat_monitor/telemetry", methods=["GET"])
def api_telemetry():
    session_id = request.args.get("session") or "<invalid token>"
    if not isSessionValid(session_id):
        return jsonify({"error": "Invalid or missing session_id"}), 400

    device_id = request.args.get("device")
    if not device_id:
        return jsonify({"error": "Missing device_id"}), 400

    with monitor_thread_lock:
        telemetry = telemetry_dataset.get(device_id)

        if not telemetry:
            return jsonify({"error": "Device not being monitored"}), 404

        # Battery records
        battery = [
            {"elapsed_time": entry.elapsed_time, "battery_level": entry.battery_level}
            for entry in telemetry.battery_data
        ]

        # System memory records
        system_memory = [
            {
                "elapsed_time": entry.elapsed_time,
                "total_kb": entry.total_kb,
                "used_kb": entry.used_kb,
            }
            for entry in telemetry.system_memory
        ]

        # App memory records
        app_memory = [
            {
                "elapsed_time": entry.elapsed_time,
                "app_kb": entry.app_kb,
            }
            for entry in telemetry.app_memory
        ]

        # CPU usage records (% per core + total)
        cpu_usage = [
            {
                "elapsed_time": entry.elapsed_time,
                **entry.usage_pct,  # expands to { "core0": 5.1, "core1": ..., "total": 3.2 }
            }
            for entry in telemetry.cpu_usage
        ]

        cpu_freq = [
            {"elapsed_time": entry.elapsed_time, "frequencies": entry.frequencies}
            for entry in telemetry.cpu_freq
        ]

        frame_drops = [
            {"elapsed_time": entry.elapsed_time, "delta_framedrops": entry.delta_framedrops}
            for entry in telemetry.frame_drops
        ]

        response = {
            "timestamp": datetime.now().isoformat(),
            "device_id": device_id,
            "telemetry_data": {
                "battery": battery,
                "system_memory": system_memory,
                "app_memory": app_memory,
                "frame_drops": frame_drops,
                "cpu_usage": cpu_usage,
                "cpu_freq": cpu_freq,
            },
        }

        device_last_access[device_id] = time.time()

        return Response(
            json.dumps(response, indent=2, sort_keys=False), mimetype="application/json"
        )


@app.route("/api/vcat_monitor/start", methods=["POST"])
def api_start_device_monitor():
    session_id = request.args.get("session") or "<invalid token>"
    if session_console_logs.get(session_id) is None:
        return jsonify({"error": "Invalid or missing session_id"}), 400

    global monitor_thread
    device_id = request.args.get("device")

    if not device_id:
        return jsonify({"error": "Missing device_id"}), 400

    if device_id in telemetry_dataset:
        return jsonify({"status": "already_monitored"}), 200

    ip_port = get_device_ip_and_port(session_id, device_id)
    if not ip_port:
        return jsonify({"error": "Invalid device or unable to resolve IP/port"}), 400

    with monitor_thread_lock:
        telemetry_dataset[device_id] = TelemetryData(
            device_id=device_id,
            device_ipaddr=ip_port,
            start_time=time.time(),
            battery_data=[],
            system_memory=[],
            app_memory=[],
            frame_drops=[],
            cpu_freq=[],
        )
        device_last_access[device_id] = time.time()

        if monitor_thread is None or not monitor_thread.is_alive():
            monitor_thread = threading.Thread(target=telemetry_worker, daemon=True)
            monitor_thread.start()

    return jsonify({"status": "monitoring_started", "device_id": device_id}), 200


@app.route("/api/vcat_monitor/stop", methods=["POST"])
def api_stop_device_monitor():
    session_id = request.args.get("session") or "<invalid token>"
    if not isSessionValid(session_id):
        return jsonify({"error": "Invalid or missing session_id"}), 400

    device_id = request.args.get("device")
    if not device_id:
        return jsonify({"error": "Missing device_id"}), 400

    if not device_id in telemetry_dataset:
        return jsonify({"status": "not_found", "device_id": device_id}), 200

    with monitor_thread_lock:
        telemetry_dataset.pop(device_id, None)
        device_last_access.pop(device_id, None)
    return jsonify({"status": "monitoring_stopped", "device_id": device_id}), 200


@app.route("/api/vcat_monitor/monitored_devices", methods=["GET"])
def api_monitored_devices():
    session_id = request.args.get("session") or "<invalid token>"
    if not isSessionValid(session_id):
        return jsonify({"error": "Invalid or missing session_id"}), 400

    with monitor_thread_lock:
        devices = [
            {"device_id": data.device_id, "ip_address": data.device_ipaddr}
            for data in telemetry_dataset.values()
        ]
    return jsonify({"devices": devices}), 200


@app.route("/api/vcat_monitor/raw_cpu", methods=["GET"])
def api_cpu():
    session_id = request.args.get("session") or "<invalid token>"
    if not isSessionValid(session_id):
        return jsonify({"error": "Invalid or missing session_id"}), 400

    device_id = request.args.get("device")
    if not device_id or not is_valid_device(session_id, device_id):
        return jsonify({"error": "Invalid or missing device ID"}), 400

    if not device_id in telemetry_dataset:
        return jsonify({"error": "not_monitoring", "device_id": device_id}), 400

    cpu_stats = {}

    with monitor_thread_lock:
        cpu_stats = telemetry_dataset[device_id].cpu_usage

    return jsonify(
        {
            "timestamp": datetime.now().isoformat(),
            "cpu_stats": cpu_stats,
        }
    )

# Start the cleanup thread
cleanup_thread = threading.Thread(target=session_cleanup_loop, daemon=True)
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
