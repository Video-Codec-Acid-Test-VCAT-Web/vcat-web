import atexit
import os
import re
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List

from openpyxl import Workbook, __version__

print(f"[DEBUG] openpyxl version: {__version__}")
print(f"[DEBUG] Workbook type: {type(Workbook)}")

from vcat_logging import logger  # ✅ shared logger
from vcat_telemetry_data_models import TelemetryData

__all__ = [
    "append_telemetry",
    "close_telemetry_excel",
    "create_telemetry_excel",
    "TelemetrySheet",
]



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

    print(f"[DEBUG] Created workbook: {wb}")
    print(f"[DEBUG] Sheet names: {wb.sheetnames}")
    print(f"[DEBUG] Active sheet: {wb.active}")

    sheet = wb.active
    if sheet is None:
        raise RuntimeError("Workbook has no active worksheet!")

    sheet.title = TelemetrySheet.BATTERY.value

    for sheet_name in [
        TelemetrySheet.CPU_USAGE.value,
        TelemetrySheet.CPU_FREQ.value,
        TelemetrySheet.FRAME_DROPS.value,
        TelemetrySheet.MEMORY.value,
    ]:
        wb.create_sheet(sheet_name)

    ccore_labels = [
        f"cpu{core.core_id}" for core in telemetry_data.device_info.cpu.cores
    ]

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
    workbook_handles[telemetry_data.owner_session_id] = wb
    file_paths[telemetry_data.owner_session_id] = filename
    logger.info(f"📁 Created telemetry file: {filename}")
    return filename


def append_telemetry(session_id: str, sheet: TelemetrySheet, rows: List[List[Any]]):
    if session_id not in workbook_handles:
        logger.critical(f"Device workbook not initialized: {session_id}")

    wb = workbook_handles[session_id]
    sheet_name = sheet.value

    if sheet_name not in wb.sheetnames:
        raise ValueError(f"Sheet does not exist: {sheet_name}")

    ws = wb[sheet_name]
    for row in rows:
        ws.append(row)

    wb.save(file_paths[session_id])


def close_telemetry_excel(session_id: str):
    if session_id in workbook_handles:
        wb = workbook_handles.pop(session_id)
        path = file_paths.pop(session_id, None)
        if path:
            wb.save(path)
            logger.info(f"✅ Closed workbook for session: {session_id}")


def cleanup_all_workbooks():
    for session_id in list(workbook_handles.keys()):
        close_telemetry_excel(session_id)
    logger.info("🧹 All telemetry workbooks have been closed.")


atexit.register(cleanup_all_workbooks)
