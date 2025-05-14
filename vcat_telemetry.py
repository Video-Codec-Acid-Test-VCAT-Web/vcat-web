import argparse
import json
import os
import random
import struct
import subprocess
import sys
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
import subprocess
import atexit

# Keep Mac awake while server is running
caffeinate_proc = subprocess.Popen(["caffeinate", "-i"])


import requests
import vcat_adb
import vcat_http_proxy

from flask import Flask, jsonify, make_response, request, Response, send_from_directory
from vcat_logging import logger
from vcat_telemetry_data_models import * 
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

max_console_lines = get_config_option(ConfigKey.MAX_CONSOLE_LINES)

app = Flask(__name__, static_folder="static")


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


def get_frame_drops(session_id, device_id: str) -> list[FramedropEntry]:
    if device_id not in telemetry_dataset:
        logger.warn(f"Unknown device: {device_id}")
        return []

    telemetry = telemetry_dataset[device_id]
    last_time = (
        telemetry.frame_drops[-1].elapsed_time if telemetry.frame_drops else -1.0
    )

    ipAddr = telemetry.device_ipaddr

    if not ipAddr:
        logger.error(f"[Could not determine IP or port")
        return []

    # Call the telemetry endpoint
    ip_addr = telemetry.device_ipaddr
    response: Response = vcat_http_proxy.get_device_http_response(
        session_id, device_id, ip_addr, "/api/telemetry/framedrops"
    )

    if not response or response.status_code != 200:
        logger.error(f"Failed to fetch frame drops for {device_id}")
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
        logger.error(f"Parsing frame drop data failed: {e}")
        return []


def get_framedrop_stats(device_id):
    return random.randint(0, 10)


def get_test_details(session_id, device_id: str) -> TestDetails:

    if device_id not in telemetry_dataset:
        logger.error(f"Unknown device: {device_id}")
        return TestDetails()

    telemetry = telemetry_dataset[device_id]

    # Call the telemetry endpoint
    ip_addr = telemetry.device_ipaddr
    response: Response = vcat_http_proxy.get_device_http_response(
        session_id, device_id, ip_addr, "/api/test/status"
    )

    if not response or response.status_code != 200:
        logger.error(f"Failed to fetch test status for {device_id}")
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
        logger.error(f"Failed to parse test status: {e}")
        return TestDetails()


def telemetry_worker():
    global last_core_times

    logger.info("starting telemetry polling thread")

    session_idle_timeout = get_config_option(ConfigKey.TELEMETRY_SESSION_TIMEOUT)

    long_poll_interval = get_config_option(ConfigKey.DEVICE_POLL_STEADY)
    initial_poll_interval= get_config_option(ConfigKey.DEVICE_POLL_INITIAL)
    time_to_steady = get_config_option(ConfigKey.DEVICE_POLL_TIME_TO_STEADY)

    session_state : OrderedDict[str, bool] = OrderedDict()

    while True:
        if not telemetry_dataset:
            logger.info("[Monitor] No devices left, stopping telemetry monitor")
            break

        for device_id, telemetry_data in telemetry_dataset.items():

            iteration_start_time = time.time()

            elapsed = time.time() - telemetry_data.start_time
            last_poll = session_last_poll.get(telemetry_data.owner_session_id, 0)
            time_since_last_poll = iteration_start_time - last_poll

            if (
                elapsed > time_to_steady
                and time_since_last_poll < long_poll_interval
            ):
                continue  # Skip polling this device for now

            touch_session_poll(telemetry_data.owner_session_id)

            # is current connection stale?
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

            test_details = get_test_details(telemetry_data.owner_session_id, device_id)
            telemetry_data.test_details = test_details

            poll_when_not_testing = get_config_option(ConfigKey.TELEMETRY_COLLECTION) == TelemetryCollectionMode.ALWAYS
            test_running = test_details.testState == "Running"

            if test_running and poll_when_not_testing and not session_state.get(telemetry_data.owner_session_id, False) :
                #we've just switched into test mode, reset all collected telemetry
                logger.debug(f"[Monitor] Device {device_id} test active.  Resetting pre-test telemetry")
                resetTelemetry(telemetry_data.owner_session_id, device_id)

            session_state[telemetry_data.owner_session_id] = test_running

            if not test_running:
                if not poll_when_not_testing :
                    logger.debug(
                        f"[Monitor] Device {device_id} is not running a test, skipping telemetry collection"
                    )
                    continue
                else :
                    logger.debug(
                        f"[Monitor] Device {device_id} is not running a test, only collecting system stats"
                    )

            battery = vcat_adb.get_battery_level(device_id)
            elapsed = time.time() - telemetry_data.start_time
            total_kb, used_kb = vcat_adb.get_system_memory(device_id)
            app_kb = vcat_adb.get_app_memory(device_id)

            if test_running:
                frame_drops = get_frame_drops(telemetry_data.owner_session_id, device_id)
            else:
                frame_drops = None

            if telemetry_data.cpu_usage:
                prev_raw_data = telemetry_data.cpu_usage[-1].raw_stats
            else:
                prev_raw_data = {}

            cur_cpu_usage = get_cpu_stats(device_id, elapsed, prev_raw_data)

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
                        BatteryEntry(elapsed_time=elapsed, battery_level=battery)
                    )

                    row = [
                        [
                            telemetry_data.battery_data[-1].elapsed_time,
                            telemetry_data.battery_data[-1].battery_level,
                        ]
                    ]
                    append_telemetry(
                        telemetry_data.owner_session_id,
                        TelemetrySheet.BATTERY,
                        row,
                    )

                if total_kb is not None and used_kb is not None and app_kb is not None:
                    telemetry_data.system_memory.append(
                        MemoryEntry(
                            elapsed_time=elapsed, total_kb=total_kb, used_kb=used_kb
                        )
                    )

                    telemetry_data.app_memory.append(
                        AppMemoryEntry(elapsed_time=elapsed, app_kb=app_kb)
                    )

                    mem_entry = telemetry_data.system_memory[-1]
                    app_entry = telemetry_data.app_memory[-1]

                    row = [
                        mem_entry.elapsed_time,
                        mem_entry.total_kb,
                        mem_entry.used_kb,
                        app_entry.app_kb,
                    ]
                    append_telemetry(
                        telemetry_data.owner_session_id, TelemetrySheet.MEMORY, [row]
                    )

                if frame_drops is not None:
                    telemetry_data.frame_drops.extend(frame_drops)
                    rows = [
                        [entry.elapsed_time, entry.delta_framedrops]
                        for entry in frame_drops
                    ]
                    append_telemetry(
                        telemetry_data.owner_session_id,
                        TelemetrySheet.FRAME_DROPS,
                        rows,
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

        time.sleep(get_config_option(ConfigKey.TELEMETRY_LOOP_POLL_INTERVAL))


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
        time.sleep(60)


def resetTelemetry(session_id, device_id):
    ipAddr = vcat_adb.get_device_ip_and_port(session_id, device_id) or ""

    now = time.time()

    telemetry_data = TelemetryData(
        owner_session_id=session_id,
        device_id=device_id,
        device_ipaddr=ipAddr,
        device_info=DeviceInfo(),
        start_time=time.time(),
        test_details=TestDetails(),
        battery_data=[],
        system_memory=[],
        app_memory=[],
        frame_drops=[],
        cpu_freq=[],
        cpu_usage=[],
    )

    # ✅ Reset telemetry for the given device
    with session_thread_lock:
        telemetry_dataset[device_id] = telemetry_data

        response = vcat_http_proxy.get_device_http_response(
            session_id, device_id, ipAddr, "/api/telemetry/reset_framedrops"
        )

        if not response or response.status_code != 200:
            logger.error(
                f"[{device_id}] Failed to reset frame drops (HTTP {response.status_code if response else 'No Response'})"
            )
        else:
            logger.debug(f"[{device_id}] Frame drops reset successfully")

    # ✅ Log the telemetry reset event
    vcat_adb.log_console_entry(
        session_id, f"[VCAT] Telemetry reset for device {device_id}"
    )

    return telemetry_data


def get_device_info(
    session_id: str, device_id: str, ip_addr: str
) -> Tuple[Optional[DeviceInfo], Optional[Response]]:
    if device_id in device_info_cache:
        return device_info_cache[device_id], None

    try:
        response = vcat_http_proxy.get_device_http_response(
            session_id, device_id, ip_addr, "/api/device_info"
        )

        if response is None or response.status_code != 200:
            return None, response

        data = response.get_json(force=True)
        if data is None:
            resp = jsonify({"error": "Device info response body is empty"})
            resp.status_code = 500
            return None, resp

        device_info = parse_device_info(data)
        device_info_cache[device_id] = device_info
        return device_info, None

    except requests.RequestException as e:
        return None, make_response(
            jsonify({"error": f"Failed to fetch device info: {e}"}), 500
        )


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


def get_required_ip(session_id: str, device_id: str):
    ip_addr = vcat_adb.get_device_ip_and_port(session_id, device_id)
    if not ip_addr:
        logger.error(
            f"Unable to determine IP/port for session: [{session_id}] device: [{device_id}]"
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


@app.route("/api/all_connected_devices", methods=["GET"])
@require_valid_session
def api_devices(session_id):
    return jsonify(vcat_adb.get_adb_devices(session_id))


@app.route("/api/device/address_of", methods=["GET"])
@require_valid_session_and_device
def api_ip_port(session_id, device_id):

    ip_addr = ""
    try:
        ip_addr = get_required_ip(session_id, device_id)
        return jsonify({"address": ip_addr})

    except ValueError as e:
        return jsonify({"error": str(e)}), 404


device_info_cache: LRUCache[str, DeviceInfo] = LRUCache(10)


@app.route("/api/device/info", methods=["GET"])
@require_valid_session_and_device
def api_device_info(session_id, device_id):

    try:
        ip_addr = get_required_ip(session_id, device_id)
        device_info, error_response = get_device_info(session_id, device_id, ip_addr)
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
        ip_addr = get_required_ip(session_id, device_id)

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
        ip_addr = get_required_ip(session_id, device_id)

        return vcat_http_proxy.get_device_http_response(
            session_id, device_id, ip_addr, "/api/control/stop"
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 404


@app.route("/api/device/show_stats", methods=["POST"])
@require_valid_session_and_device
def api_device_show_stats(session_id, device_id):
    try:
        ip_addr = get_required_ip(session_id, device_id)

        return vcat_http_proxy.get_device_http_response(
            session_id, device_id, ip_addr, "/api/control/show_stats"
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 404


@app.route("/api/device/play_pause", methods=["POST"])
@require_valid_session_and_device
def api_device_playpause(session_id, device_id):
    try:
        ip_addr = get_required_ip(session_id, device_id)

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
            ip_addr = get_required_ip(session_id, device_id)
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


##########################################
# Telemetry
##########################################


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

        touch_session_access(session_id, device_id)
        vcat_adb.touchConsole(session_id)

        return Response(
            json.dumps(response, indent=2, sort_keys=False), mimetype="application/json"
        )


@app.route("/api/vcat_monitor/start", methods=["POST"])
@require_valid_session_and_device
def api_start_device_monitor(session_id, device_id):

    global console_thread

    if device_id in telemetry_dataset:
        return jsonify({"status": "already_monitored"}), 200

    ip_addr = ""

    # Step 1: Find device IP address
    try:
        ip_addr = get_required_ip(session_id, device_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 404

    device_info, error_response = get_device_info(session_id, device_id, ip_addr)
    if error_response:
        return error_response

    if device_info is None:
        return make_response(jsonify({"error": "Missing device info"}), 500)

    time.sleep(0.5)

    telemetry_data = resetTelemetry(session_id, device_id)

    touch_session_access(session_id, device_id)

    create_telemetry_excel(telemetry_data)

    if vcat_adb.console_thread is None or not vcat_adb.console_thread.is_alive():
        vcat_adb.console_thread = threading.Thread(target=telemetry_worker, daemon=True)
        vcat_adb.console_thread.start()

    return jsonify({"status": "monitoring_started", "device_id": device_id}), 200


@app.route("/api/vcat_monitor/stop", methods=["POST"])
@require_valid_session_and_device
def api_stop_device_monitor(session_id, device_id):

    if not device_id in telemetry_dataset:
        logger.error(f"api/vcat_monitor/stop: device id '[{device_id}] not found")
        return jsonify({"status": "not_found", "device_id": device_id}), 200

    with session_thread_lock:
        telemetry_dataset.pop(device_id, None)
        session_last_access.pop(device_id, None)
        close_telemetry_excel(session_id)

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
