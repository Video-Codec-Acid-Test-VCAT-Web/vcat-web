import argparse
import json
import random
import re
import struct
import subprocess
import sys
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import asdict, dataclass, field, is_dataclass
from datetime import datetime
from typing import Dict, List
from urllib.parse import urlparse
import requests
import vcat_http_proxy

from flask import Flask, jsonify, request, Response, send_from_directory
import os

# Create logs directory if it doesn't exist
os.makedirs("logs", exist_ok=True)



# fail gracefully if we don't have the right version of Python
if sys.version_info < (3, 9):
    print("❌ Python 3.9 or higher is required to run VCAT Telemetry.")
    sys.exit(1)
else:
    print("✅ Python version is OK.")


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
class CurrentTestVideo:
    fileName: str = ""
    startTime: str = ""
    videoCodec: str = ""
    videoDecoder: str = ""
    resolution: str = ""
    mimeType: str = ""
    bitrate: str = ""
    framerate: float = 0.0


@dataclass
class TestDetails:
    testState: str = ""
    startTime: str = ""
    playlist: str = ""
    currentTestVideo: CurrentTestVideo = field(default_factory=CurrentTestVideo)


@dataclass
class TelemetryData:
    owner_session_id: str
    device_id: str
    device_ipaddr: str
    start_time: float
    test_details: TestDetails
    battery_data: list[BatteryEntry]
    system_memory: list[MemoryEntry]
    app_memory: list[AppMemoryEntry]
    frame_drops: list[FramedropEntry]
    cpu_freq: List[CpuFreguencyEntry]
    cpu_usage: List[CpuUsageEntry] = field(default_factory=list)


telemetry_dataset = OrderedDict()
device_last_access: OrderedDict[str, float] = OrderedDict()


@dataclass
class SessionConsoleLogEntry:
    time: float  # Unix timestamp (for pruning)
    date: str  # Human-readable timestamp string (e.g., '23:45:01')
    text: str  # Full command + output block, with embedded \n


@dataclass
class SessionConsoleLog:
    last_access: float
    history: List[SessionConsoleLogEntry] = field(default_factory=list)


session_console_logs: Dict[str, SessionConsoleLog] = OrderedDict()
session_thread_lock = threading.Lock()

MAX_CONSOLE_LINES = 500

monitor_thread = None
monitor_thread_lock = threading.Lock()


app = Flask(__name__, static_folder="static")


@app.route("/")
def serve_index():
    return send_from_directory("static", "index.html")


BROADCAST_COMMANDS = {
    "log_http_port": "org.videolan.vlcbenchmark.ADB_LOG_HTTP_INFO",
}


def touch_session(session_id: str):
    with session_thread_lock:
        session = session_console_logs.get(session_id)
        if session:
            session.last_access = time.time()

def touchConsole(session_id: str):
    with monitor_thread_lock:
        console = session_console_logs.get(session_id)
        if console:
            console.last_access = time.time()


def log_console_entry(session_id: str, text: str):
    now = time.time()
    timestamp = datetime.now().strftime("%H:%M:%S")

    entry = SessionConsoleLogEntry(time=now, date=timestamp, text=text)

    if session_id not in session_console_logs:
        session_console_logs[session_id] = SessionConsoleLog(last_access=now)

    log = session_console_logs[session_id]
    log.history.append(entry)
    touchConsole(session_id)

    if len(log.history) > MAX_CONSOLE_LINES:
        log.history = log.history[-MAX_CONSOLE_LINES:]


def run_adb_command_with_log(
    session_id: str, device_id: str, cmd: List[str], log_level: str = "info"
):
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        output = result.stdout.strip()
        error = result.stderr.strip() if result.stderr else ""

        if log_level != "debug" and session_id in session_console_logs:
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

ipCache: OrderedDict[str, str] = OrderedDict()

def get_device_ip_and_port(session_id, device_id):
    
    if device_id in ipCache:
        return ipCache[device_id]

    send_adb_broadcast(session_id, device_id, "log_http_port")

    try:
        # Grab logcat for just the VCAT tag
        logcat_cmd = ["adb", "-s", device_id, "logcat", "-d", "-s", "VCAT"]
        result = subprocess.run(logcat_cmd, capture_output=True, text=True, check=True)
        log_output = result.stdout

        # Clear logcat to avoid stale data next time
        # subprocess.run(["adb", "-s", device_id, "logcat", "-c"])

        # Parse logcat output
        match = re.search(r"HTTP server @ ((?:\d{1,3}\.){3}\d{1,3}):(\d+)", log_output)
        if match:
            ip_address, port = match.group(1), int(match.group(2))
            log_console_entry(
                session_id, f"[VCAT] {device_id} ip_addr: http://{ip_address}:{port}"
            )
            log_console_entry(
                session_id, f"[VCAT] {device_id} ip_addr: http://{ip_address}:{port}"
            )
            print(f"[VCAT] {device_id} ip_addr: http://{ip_address}:{port}")
            ipCache[device_id] = f"http://{ip_address}:{port}"
            return f"http://{ip_address}:{port}"

        else:
            log_console_entry(
                session_id, "[VCAT] ERROR: Could not find HTTP server line in logcat"
            )
            return None

    except Exception as e:
        log_console_entry(
            session_id, f"[VCAT] Exception during IP/port retrieval: {str(e)}"
        )
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


from flask import Response
from vcat_http_proxy import get_device_http_response


def get_frame_drops(session_id, device_id: str) -> list[FramedropEntry]:
    if device_id not in telemetry_dataset:
        print(f"[WARN] Unknown device: {device_id}")
        return []

    telemetry = telemetry_dataset[device_id]
    last_time = (
        telemetry.frame_drops[-1].elapsed_time if telemetry.frame_drops else -1.0
    )

    ipAddr = telemetry.device_ipaddr

    if not ipAddr:
        print(f"[ERROR] Could not determine IP or port")
        return []

    # Call the telemetry endpoint
    ip_addr = telemetry.device_ipaddr
    response: Response = vcat_http_proxy.get_device_http_response(
        device_id, ip_addr, "/api/telemetry/framedrops"
    )

    if not response or response.status_code != 200:
        print(f"[ERROR] Failed to fetch frame drops for {device_id}")
        return []

    try:
        json_data = response.get_json()
        new_entries = []

        for entry in json_data.get("framedrops", []):
            elapsed = entry.get("elapsed_time")
            drops = entry.get("framedrops")
            if elapsed is not None and drops is not None and elapsed > last_time:
                new_entries.append(
                    FramedropEntry(elapsed_time=elapsed, delta_framedrops=drops)
                )

        return new_entries

    except Exception as e:
        print(f"[ERROR] Parsing frame drop data failed: {e}")
        return []


def get_framedrop_stats(device_id):
    return random.randint(0, 10)


def get_test_details(session_id, device_id: str) -> TestDetails:

    if device_id not in telemetry_dataset:
        print(f"[WARN] Unknown device: {device_id}")
        return TestDetails()

    telemetry = telemetry_dataset[device_id]

    # Call the telemetry endpoint
    ip_addr = telemetry.device_ipaddr
    response: Response = vcat_http_proxy.get_device_http_response(
        device_id, ip_addr, "/api/test/status"
    )

    if not response or response.status_code != 200:
        print(f"[ERROR] Failed to fetch test status for {device_id}")
        return TestDetails()

    try:
        data = response.get_json()

        return TestDetails(
            playlist=data.get("playlist", ""),
            startTime=data.get("startTime", ""),
            testState=data.get("testState", "Unknown"),
            currentTestVideo=CurrentTestVideo(
                fileName=data["currentTestVideo"].get("fileName", ""),
                startTime=data["currentTestVideo"].get("startTime", ""),
                videoCodec=data["currentTestVideo"].get("videoCodec", ""),
                videoDecoder=data["currentTestVideo"].get("videoDecoder", ""),
                resolution=data["currentTestVideo"].get("resolution", ""),
                mimeType=data["currentTestVideo"].get("mimeType", ""),
                bitrate=data["currentTestVideo"].get("bitrate", ""),
                framerate=data["currentTestVideo"].get("fps", 0.0),
            ),
        )
    except Exception as e:
        print(f"❌ Failed to parse test status: {e}")
        return TestDetails()


def telemetry_worker():
    global last_core_times

    MAX_ACCESS_SPAN = (
        3600 * 2
    )  # 2 hours without any activity on a connected device will be considered stale

    print("[Monitor] telemetry_worker started")

    devicePollingTime = 10 * 60

    while True:
        if not telemetry_dataset:
            print("[Monitor] No devices left, stopping telemetry monitor")
            break

        for device_id, telemetry_data in telemetry_dataset.items():

            iteration_start_time = time.time()

            elapsed = time.time() - telemetry_data.start_time
            last_poll = device_last_access.get(device_id, 0)

            if elapsed > 10 * 60 and iteration_start_time - last_poll < 10 * 60:
                continue  # Skip polling this device for now


            # is current connection stale?
            last_access = device_last_access.get(device_id, 0)
            time_since_access = time.time() - last_access

            if time_since_access > MAX_ACCESS_SPAN:
                print(
                    f"[Monitor] Device {device_id} stale for {time_since_access:.1f}s, removing from monitor list"
                )
                with session_thread_lock:
                    telemetry_dataset.pop(device_id, None)
                    device_last_access.pop(device_id, None)
                continue  # Skip to next device

            test_details = get_test_details(telemetry_data.owner_session_id, device_id)
            telemetry_data.test_details = test_details

            if test_details.testState != "Running":
                print(
                    f"[Monitor] Device {device_id} is not running a test, skipping telemetry collection"
                )
                continue

            battery = get_battery_level(device_id)
            elapsed = time.time() - telemetry_data.start_time
            total_kb, used_kb = get_system_memory(device_id)
            app_kb = get_app_memory(device_id)
            frame_drops = get_frame_drops(telemetry_data.owner_session_id, device_id)

            if telemetry_data.cpu_usage:
                prev_raw_data = telemetry_data.cpu_usage[-1].raw_stats
            else:
                prev_raw_data = {}

            cur_cpu_usage = get_cpu_stats(device_id, elapsed, prev_raw_data)

            cpu_freqs = get_cpu_frequencies(device_id)

            with session_thread_lock:
                if telemetry_data.start_time < 0:
                    telemetry_data.start_time = time.time()

                if iteration_start_time < telemetry_data.start_time:
                    print(f"[Monitor] Skipping stale telemetry for {device_id} (collected before reset)")
                    continue  # skip applying this iteration's data

                telemetry_data.test_details = test_details

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
                    telemetry_data.frame_drops.extend(frame_drops)

                if cur_cpu_usage is not None:
                    telemetry_data.cpu_usage.append(cur_cpu_usage)

                if cpu_freqs:
                    telemetry_data.cpu_freq.append(
                        CpuFreguencyEntry(elapsed_time=elapsed, frequencies=cpu_freqs)
                    )

    
        time.sleep(30)


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
            expired = [
                sid
                for sid, log in session_console_logs.items()
                if now - log.last_access > MAX_SESSION_ACCESS_SPAN
            ]
            for sid in expired:
                print(f"[Session Cleanup] Expiring session {sid}")
                del session_console_logs[sid]
        time.sleep(60)


def resetTelemetry(session_id, device_id):
    ipAddr = get_device_ip_and_port(session_id, device_id) or ""

    now = time.time()

    # ✅ Reset telemetry for the given device
    with session_thread_lock:
        telemetry_dataset[device_id] = TelemetryData(
            owner_session_id=session_id,
            device_id=device_id,
            device_ipaddr=ipAddr,
            start_time=time.time(),
            test_details=TestDetails(),
            battery_data=[],
            system_memory=[],
            app_memory=[],
            frame_drops=[],
            cpu_freq=[],
            cpu_usage=[],
        )

        response = vcat_http_proxy.get_device_http_response(device_id, ipAddr, "/api/telemetry/reset_framedrops")

        if not response or response.status_code != 200:
            print(f"[{device_id}] Failed to reset frame drops (HTTP {response.status_code if response else 'No Response'})")
        else:
            print(f"[{device_id}] Frame drops reset successfully")

    
    # ✅ Log the telemetry reset event
    log_console_entry(session_id, f"[VCAT] Telemetry reset for device {device_id}")


@app.route("/api/session_token", methods=["GET"])
def session_token():
    token = str(uuid.uuid4())
    session_console_logs[token] = SessionConsoleLog(last_access=time.time())
    return jsonify({"session_token": token})


@app.route("/api/session_console_log", methods=["GET"])
def session_console_log():
    session_id = request.args.get("session") or "<invalid token>"
    if not isSessionValid(session_id):
        return jsonify({"error": "Invalid or missing session_id"}), 400

    log_data = session_console_logs.get(session_id)
    touchConsole(session_id)

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

    return Response(
        json.dumps(ordered, indent=2, sort_keys=False), mimetype="application/json"
    )


@app.route("/api/reset_session_console_log", methods=["POST"])
def api_reset_session_console_log():
    session_id = request.args.get("session")

    if not session_id:
        return jsonify({"error": "Missing session_id"}), 400

    now = time.time()

    with session_thread_lock:
        session_console_logs[session_id] = SessionConsoleLog(
            last_access=now, history=[]
        )

    touchConsole(session_id)
    return jsonify({"status": "console log reset completed"}), 200


##########################################
# Device management
##########################################


@app.route("/api/all_connected_devices", methods=["GET"])
def api_devices():
    session_id = request.args.get("session") or "<invalid token>"
    if not isSessionValid(session_id):
        return jsonify({"error": "Invalid or missing session_id"}), 400

    touchConsole(session_id)
    return jsonify(get_adb_devices(session_id))


@app.route("/api/device/address_of", methods=["GET"])
def api_ip_port():
    session_id = request.args.get("session") or "<invalid token>"
    if not isSessionValid(session_id):
        return jsonify({"error": "Invalid or missing session_id"}), 400

    touchConsole(session_id)

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
    touchConsole(session_id)

    device_id = request.args.get("device")
    if not device_id:
        return jsonify({"error": "Missing device_id"}), 400

    ipAddr = get_device_ip_and_port(session_id, device_id)
    if not ipAddr:
        return jsonify({"error": "Could not determine IP or port"}), 404

    try:
        response = vcat_http_proxy.get_device_http_response(
            device_id, ipAddr, "/api/device_info"
        )
        return response
    except requests.RequestException as e:
        return jsonify({"error": f"Failed to fetch device info: {str(e)}"}), 500


@app.route("/api/device/run_config", methods=["GET"])
def api_device_run_config():
    session_id = request.args.get("session") or "<invalid token>"
    if not isSessionValid(session_id):
        return jsonify({"error": "Invalid or missing session_id"}), 400

    touchConsole(session_id)
    device_id = request.args.get("device")
    if not device_id:
        return jsonify({"error": "Missing device_id"}), 400

    ipAddr = get_device_ip_and_port(session_id, device_id)
    if not ipAddr:
        return jsonify({"error": "Could not determine IP or port"}), 404

    try:
        response = vcat_http_proxy.get_device_http_response(
            device_id, ipAddr, "/api/run_config"
        )

        return response

    except requests.RequestException as e:
        return jsonify({"error": f"Failed to fetch run config: {str(e)}"}), 500


@app.route("/api/device/stop", methods=["POST"])
def api_device_stop():
    session_id = request.args.get("session") or "<invalid token>"
    if not isSessionValid(session_id):
        return jsonify({"error": "Invalid or missing session_id"}), 400
    touchConsole(session_id)

    device_id = request.args.get("device")
    if not session_id or not device_id:
        return jsonify({"error": "Missing session or device ID"}), 400

    ipAddr = get_device_ip_and_port(session_id, device_id)
    if not ipAddr:
        return jsonify({"error": "Could not determine IP or port"}), 404

    return vcat_http_proxy.get_device_http_response(
        device_id, ipAddr, "/api/control/stop"
    )


@app.route("/api/device/show_stats", methods=["POST"])
def api_device_show_stats():
    session_id = request.args.get("session") or "<invalid token>"
    if not isSessionValid(session_id):
        return jsonify({"error": "Invalid or missing session_id"}), 400
    touchConsole(session_id)

    device_id = request.args.get("device")
    if not session_id or not device_id:
        return jsonify({"error": "Missing session or device ID"}), 400

    ipAddr = get_device_ip_and_port(session_id, device_id)
    if not ipAddr:
        return jsonify({"error": "Could not determine IP or port"}), 404

    return vcat_http_proxy.get_device_http_response(
        device_id, ipAddr, "/api/control/show_stats"
    )


@app.route("/api/device/play_pause", methods=["POST"])
def api_device_playpause():
    session_id = request.args.get("session") or "<invalid token>"
    device_id = request.args.get("device")
    if not session_id or not device_id:
        return jsonify({"error": "Missing session or device ID"}), 400

    touchConsole(session_id)
    ipAddr = get_device_ip_and_port(session_id, device_id)
    if not ipAddr:
        return jsonify({"error": "Could not determine IP or port"}), 404

    return vcat_http_proxy.get_device_http_response(
        device_id, ipAddr, "/api/control/playpause"
    )

@app.route('/api/wireless_adb')
def api_enable_wireless_adb():
    session_id = request.args.get('session')
    device_id = request.args.get('device')

    if not session_id or not device_id:
        return jsonify({"error": "Missing session or device"}), 400

    if not is_valid_device(session_id, device_id):
        return jsonify({"error": "Invalid device"}), 404
    touchConsole(session_id)

    try:
        # Step 1: Enable wireless ADB
        output = run_adb_command_with_log(
            session_id,
            device_id,
            ["adb", "-s", device_id, "tcpip", "5555"],
            log_level="info"
        )

        if output is None:
            return jsonify({"error": "Failed to enable wireless ADB"}), 500

        # Step 2: Find device IP address
        device_ip_url = get_device_ip_and_port(session_id, device_id)  # ⚡ You already have this function
        if not device_ip_url:
            return jsonify({"error": "Could not get device IP address"}), 500

        parsed_url = urlparse(device_ip_url)
        ip_addr = parsed_url.hostname

        # Step 3: Connect wirelessly
        connect_output = run_adb_command_with_log(
            session_id,
            device_id,
            ["adb", "connect", f"{ip_addr}:5555"],
            log_level="info"
        )

        if connect_output is None:
            return jsonify({"error": f"Failed to connect to {ip_addr}:5555"}), 500

        resetTelemetry(session_id, device_id)

        return jsonify({"message": f"Wireless ADB enabled and connected to {ip_addr}:5555"}), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


##########################################
# Telemetry
##########################################
@app.route("/api/vcat_monitor/telemetry", methods=["GET"])
def api_telemetry():
    session_id = request.args.get("session") or "<invalid token>"
    if not isSessionValid(session_id):
        return jsonify({"error": "Invalid or missing session_id"}), 400

    device_id = request.args.get("device")
    if not device_id:
        return jsonify({"error": "Missing device_id"}), 400

    touch_session(session_id)

    with session_thread_lock:
        telemetry = telemetry_dataset.get(device_id)

        if not telemetry:
            return jsonify({"error": "Device not being monitored"}), 404

        if telemetry.start_time < 0:
            return jsonify({"message": "Telemetry not avaiable yet."}), 202

        # Test detqails
        test_details = asdict(telemetry.test_details)

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
            {
                "elapsed_time": entry.elapsed_time,
                "delta_framedrops": entry.delta_framedrops,
            }
            for entry in telemetry.frame_drops
        ]

        response = {
            "timestamp": datetime.now().isoformat(),
            "device_id": device_id,
            "test_details": test_details,
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
        touchConsole(session_id)

        return Response(
            json.dumps(response, indent=2, sort_keys=False), mimetype="application/json"
        )


@app.route("/api/vcat_monitor/start", methods=["POST"])
def api_start_device_monitor():
    session_id = request.args.get("session") or "<invalid token>"
    if session_console_logs.get(session_id) is None:
        return jsonify({"error": "Invalid or missing session_id"}), 400

    touchConsole(session_id)

    global monitor_thread
    device_id = request.args.get("device")

    if not device_id:
        return jsonify({"error": "Missing device_id"}), 400

    if device_id in telemetry_dataset:
        return jsonify({"status": "already_monitored"}), 200

    ip_port = get_device_ip_and_port(session_id, device_id)
    if not ip_port:
        return jsonify({"error": "Invalid device or unable to resolve IP/port"}), 400
    time.sleep(0.5)
    with session_thread_lock:
        telemetry_dataset[device_id] = TelemetryData(
            owner_session_id=session_id,
            device_id=device_id,
            device_ipaddr=ip_port,
            start_time=time.time(),
            test_details=TestDetails(),
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

    touchConsole(session_id)

    device_id = request.args.get("device")
    if not device_id:
        return jsonify({"error": "Missing device_id"}), 400

    if not device_id in telemetry_dataset:
        return jsonify({"status": "not_found", "device_id": device_id}), 200

    with session_thread_lock:
        telemetry_dataset.pop(device_id, None)
        device_last_access.pop(device_id, None)
    return jsonify({"status": "monitoring_stopped", "device_id": device_id}), 200


@app.route("/api/vcat_monitor/monitored_devices", methods=["GET"])
def api_monitored_devices():
    session_id = request.args.get("session") or "<invalid token>"
    if not isSessionValid(session_id):
        return jsonify({"error": "Invalid or missing session_id"}), 400

    touchConsole(session_id)

    with session_thread_lock:
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

    touchConsole(session_id)

    device_id = request.args.get("device")
    if not device_id or not is_valid_device(session_id, device_id):
        return jsonify({"error": "Invalid or missing device ID"}), 400

    if not device_id in telemetry_dataset:
        return jsonify({"error": "not_monitoring", "device_id": device_id}), 400

    touch_session(session_id)

    cpu_stats = {}

    with monitor_thread_lock:
        cpu_stats = telemetry_dataset[device_id].cpu_usage

    return jsonify(
        {
            "timestamp": datetime.now().isoformat(),
            "cpu_stats": cpu_stats,
        }
    )

@app.route("/api/vcat_monitor/reset", methods=["POST"])
def api_vcat_monitor_reset():
    session_id = request.args.get("session") or "<invalid token>"
    if not isSessionValid(session_id):
        return jsonify({"error": "Invalid or missing session_id"}), 400

    touchConsole(session_id)
    device_id = request.args.get("device")
    if not device_id:
        return jsonify({"error": "Missing device_id"}), 400

    resetTelemetry(session_id, device_id)

    return jsonify({"status": "telemetry reset completed"}), 200


##########################################
# Main code area
##########################################

# Start the cleanup thread
cleanup_thread = threading.Thread(target=session_cleanup_loop, daemon=True)
cleanup_thread.start()

vcat_http_proxy.setRouting(vcat_http_proxy.RoutingMethod.ADB)

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
