import csv
from vcat_telemetry_data_models import *
import os
import re
from datetime import datetime
from io import StringIO
__all__ = ["read_telemetry_data"]
import json
from typing import List, Optional

path = "/storage/emulated/0/Download/f720p-p7-crf50-av1-fd2.mp4"
filename = os.path.basename(path)
print(filename)

def parse_json_header(preamble_lines: list[str]) -> tuple[int, dict, dict, dict]:
    """
    Parses the entire preamble as a single JSON blob.
    Returns (header_version, device_info, session_info, test_conditions).
    If no 'header_version' is present, treats it as invalid.
    """
    try:
        raw_json = json.loads("".join(preamble_lines))
        if "header_version" not in raw_json:
            return 0, {}, {}, {}

        return (
            raw_json.get("header_version", 0),
            raw_json.get("device_info", {}),
            raw_json.get("session_info", {}),
            raw_json.get("test_conditions", {}),
        )
    except Exception as e:
        print(f"[warn] Failed to parse JSON header: {e}")
        return 0, {}, {}, {}

def _read_telemetry_dicts(file_path: str) -> tuple[list[dict], int, DeviceInfo, SessionInfo, TestConditions]:
    with open(file_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    preamble_lines = []
    data_start_index = 0

    for i, line in enumerate(lines):
        if line.strip().startswith("test.timestamp"):
            data_start_index = i
            break
        preamble_lines.append(line)

    header_version, device_raw, session_raw, test_raw = parse_json_header(preamble_lines)

    device_details = DeviceInfo.from_dict(device_raw)
    session_info = SessionInfo.from_dict(session_raw)
    test_conditions = TestConditions.from_dict(test_raw)

    data_lines = lines[data_start_index:]
    rows = list(csv.DictReader(StringIO("".join(data_lines))))

    return rows, header_version, device_details, session_info, test_conditions



def parse_float(value) -> float:
    if value is None:
        raise ValueError("Expected float, got None")
    match = re.search(r"[-+]?\d*\.?\d+", value)
    return float(match.group()) if match else 0.0


def parse_int(value) -> int:
    if value is None:
        raise ValueError("Expected int, got None")
    return int(float(value))  # Accepts "123.0" as valid


def _read_battery_row(elapsed_time: float, row: dict) -> BatteryEntry:
    return BatteryEntry(
        elapsed_time=elapsed_time,
        level=parse_float(row.get("battery.level")),
        current_ma=parse_float(row.get("battery.milliamps")),
        charge_count=parse_int(row.get("battery.charge_counter")),
        battery_temp=parse_float(row.get("battery.temperature")),
    )


def _read_cpu_freqs(elapsed_time: float, row: dict) -> CpuFreguencyEntry:
    freqs = {
        key.split(".")[-1]: parse_int(value)
        for key, value in row.items()
        if key.startswith("cpu.freq")
    }

    return CpuFreguencyEntry(elapsed_time=elapsed_time, frequencies=freqs)


def _read_cpu_usages(elapsed_time: float, row: dict) -> CpuUsageEntry:
    usage: dict[str, float] = {}

    for key, value in row.items():
        if key == "cpu.usage.total":
            usage["cpu"] = parse_float(value)
        elif key.startswith("cpu.usage."):
            suffix = key.split(".")[-1]
            if suffix != "total":
                usage[f"cpu{suffix}"] = parse_float(value)

    if "cpu" not in usage:
        raise ValueError("Missing 'cpu.usage.total' (mapped to 'cpu')")

    return CpuUsageEntry(
        elapsed_time=elapsed_time,
        usage_pct=usage,
        raw_stats={},  # You can populate this later if needed
    )


def _read_frame_drops(elapsed_time: float, row: dict) -> FramedropEntry:
    value = row.get("video.frames_dropped")
    if value is None:
        raise ValueError("Missing 'video.frames_dropped'")

    return FramedropEntry(elapsed_time=elapsed_time, delta_framedrops=parse_int(value))


def _read_system_memory(elapsed_time: float, row: dict):

    return MemoryEntry(elapsed_time=elapsed_time, used_kb=0)


def read_app_memory(elapsed_time: float, row: dict):

    return MemoryEntry(elapsed_time=elapsed_time, used_kb=0)


def _read_timestamp(row) -> int:
    return int(
        float(row["test.timestamp"])
    )  # Handles integers and float strings like "1716308013.245"


def identify_blob_type(blob: dict) -> Optional[str]:
    first_key = next(iter(blob), None)
    if first_key == "manufacturer":
        return "device_info"
    elif first_key == "playlist":
        return "test_details"
    elif first_key == "test_conditions":
        return "test_conditions"
    return None

def read_telemetry_data(session_id, telemetry_file) -> TelemetryData:

    # code here

    battery_data: list[BatteryEntry] = []
    system_memory: list[MemoryEntry] = []
    app_memory: list[MemoryEntry] = []
    frame_drops: list[FramedropEntry] = []
    cpu_freq: List[CpuFreguencyEntry] = []
    cpu_usage: List[CpuUsageEntry] = []

    rows, header_version, device_info, session_info, test_conditions = _read_telemetry_dicts(telemetry_file)

    # handle unsupported versions of header
    if header_version < 32:
        raise ValueError("Missing or unsupported header version")

    start_time = _read_timestamp(rows[0])

    for row in rows:
        cur_time = _read_timestamp(row)
        elapsed_time = (cur_time - start_time) / 1000.0
        battery_data.append(_read_battery_row(elapsed_time, row))
        cpu_freq.append(_read_cpu_freqs(elapsed_time, row))
        cpu_usage.append(_read_cpu_usages(elapsed_time, row))
        frame_drops.append(_read_frame_drops(elapsed_time, row))
        system_memory.append(_read_system_memory(elapsed_time, row))
        app_memory.append(read_app_memory(elapsed_time, row))

    test_start_time = datetime.fromtimestamp(start_time / 1000.0).isoformat()

    # build test details
    current_video = CurrentTestVideo(
        fileName=os.path.basename(rows[0]["video.filename"]),
        startTime=test_start_time,
        videoCodec=rows[0]["video.codec_name"],
        videoDecoder=rows[0]["video.decoder_name"],
        resolution=rows[0]["video.resolution"],
        mimeType=rows[0].get("video.mime", "None"),
        bitrate=rows[0]["video.bitrate"],
        framerate=parse_float(rows[0]["video.framerate"]),
    )

    test_details = TestDetails(
        testState="Completed",
        startTime=test_start_time,
        playlist=session_info.playlist,
        currentTestVideo=current_video,
    )

    telemetry = make_empty_telemetry_data()
    telemetry.version = header_version
    telemetry.owner_session_id = session_id
    telemetry.device_info = device_info
    telemetry.session_info = session_info
    telemetry.start_time = start_time
    telemetry.battery_data = battery_data
    telemetry.system_memory = system_memory
    telemetry.app_memory = app_memory
    telemetry.cpu_freq = cpu_freq
    telemetry.cpu_usage = cpu_usage
    telemetry.frame_drops = frame_drops
    telemetry.test_conditions = test_conditions
    telemetry.test_details = test_details

    return telemetry
