import os
import re
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List

from openpyxl import Workbook

from vcat_telemetry_data_models import TelemetryData


# Sheet name enum for safe usage
class TelemetrySheet(str, Enum):
    BATTERY = "Battery"
    CPU_USAGE = "CPU Usage"
    CPU_FREQ = "CPU Frequency"
    FRAME_DROPS = "Frame Drops"
    MEMORY = "Memory"


# Maintain open workbooks in memory per device
workbook_handles: Dict[str, Workbook] = {}
file_paths: Dict[str, str] = {}


def format_device_filename(device_id: str, manufacturer: str, model: str) -> str:
    """
    Formats a safe filename string like: deviceid_manufacturer_model
    Replaces spaces and unsafe characters with underscores.
    """

    def sanitize(s: str) -> str:
        return re.sub(r"[^A-Za-z0-9._-]", "_", s.strip())

    return f"{sanitize(device_id)}_{sanitize(manufacturer)}_{sanitize(model)}"


def create_telemetry_excel(telemetry_data: TelemetryData) -> str:
    base_filename = format_device_filename(
        telemetry_data.device_id,
        telemetry_data.device_info.manufacturer,
        telemetry_data.device_info.model,
    )

    os.makedirs("output", exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"output/{base_filename}_{timestamp}.xlsx"

    wb = Workbook()
    sheet = wb.active
    if sheet is None:
        raise RuntimeError("Workbook has no active worksheet!")

    sheet.title = TelemetrySheet.BATTERY.value

    # Create and name remaining sheets
    for sheet_name in [
        TelemetrySheet.CPU_USAGE.value,
        TelemetrySheet.CPU_FREQ.value,
        TelemetrySheet.FRAME_DROPS.value,
        TelemetrySheet.MEMORY.value,
    ]:
        wb.create_sheet(sheet_name)

    # Extract CPU core labels
    ccore_labels = [
        f"cpu{core.core_id}" for core in telemetry_data.device_info.cpu.cores
    ]

    # Initialize headers
    wb[TelemetrySheet.BATTERY.value].append(["Elapsed Time (s)", "Battery Level (%)"])
    wb[TelemetrySheet.CPU_USAGE.value].append(
        ["Elapsed Time (s)", "total"] + ccore_labels
    )
    wb[TelemetrySheet.CPU_FREQ.value].append(["Elapsed Time (s)"] + ccore_labels)
    wb[TelemetrySheet.FRAME_DROPS.value].append(
        ["Elapsed Time (s)", "Delta Frame Drops"]
    )
    wb[TelemetrySheet.MEMORY.value].append(
        ["Elapsed Time (s)", "Total KB", "Used KB", "App KB"]
    )

    wb.save(filename)
    workbook_handles[telemetry_data.device_id] = wb
    file_paths[telemetry_data.device_id] = filename
    print(f"📁 Created telemetry file: {filename}")
    return filename


def append_telemetry(device_id: str, sheet: TelemetrySheet, rows: List[List[Any]]):
    if device_id not in workbook_handles:
        raise RuntimeError(f"Device workbook not initialized: {device_id}")

    wb = workbook_handles[device_id]
    sheet_name = sheet.value

    if sheet_name not in wb.sheetnames:
        raise ValueError(f"Sheet does not exist: {sheet_name}")

    ws = wb[sheet_name]
    for row in rows:
        ws.append(row)

    wb.save(file_paths[device_id])
