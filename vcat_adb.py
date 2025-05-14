from dataclasses import asdict, dataclass, field, is_dataclass
from typing import Dict, List
import re
import threading
from collections import OrderedDict
import time
from datetime import datetime
import subprocess
from dataclasses import dataclass
from vcat_logging import logger

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
    "log_http_port": "org.videolan.vlcbenchmark.ADB_LOG_HTTP_INFO",
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
        if log_level != "debug" or session_id in session_consoles:
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
        logger.error(f"[get_app_memory ERROR] {e}")
    return None
