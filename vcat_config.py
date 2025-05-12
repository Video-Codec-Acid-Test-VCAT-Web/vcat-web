import json
from enum import Enum
from pathlib import Path
from typing import Any
from vcat_logging import logger



__all__ = [
    "ConfigKey",
    "TelemetryCollectionMode",
    "HttpRoutingMode",
    "get_config_option",
]


class ConfigKey(str, Enum):
    TELEMETRY_SESSION_TIMEOUT = "telemetry_session_access_timeout_seconds"
    CONSOLE_TIMEOUT = "console_access_timeout_seconds"
    MAX_CONSOLE_LINES = "max_console_lines"
    DEVICE_POLL_INITIAL = "device_poll_initial_interval_seconds"
    DEVICE_POLL_STEADY = "device_poll_steady_state_interval_seconds"
    DEVICE_POLL_TIME_TO_STEADY = "device_poll_time_to_steady_seconds"
    DEFAULT_HTTP_ROUTING = "default_http_routing"
    TELEMETRY_PATH = "absolute_telemetry_data_path"
    TELEMETRY_COLLECTION = "telemetry_collection"
    TELEMETRY_LOOP_POLL_INTERVAL = "telemetry_loop_poll_interval"


class TelemetryCollectionMode(str, Enum):
    ALWAYS = "Always"
    WHEN_TEST_RUNNING = "WhenTestRunning"

class HttpRoutingMode(str, Enum):
    HTTP = "http"
    ADB_TUNNELING = "AdbTunneling"


DEFAULT_CONFIG = {
    ConfigKey.TELEMETRY_SESSION_TIMEOUT: 3600*2, # 2 hours
    ConfigKey.CONSOLE_TIMEOUT: 30 * 60,  # 30 minutes
    ConfigKey.MAX_CONSOLE_LINES: 500,
    ConfigKey.DEVICE_POLL_INITIAL: 10, # when first monitoring a device, collect telemetry every n seconds
    ConfigKey.DEVICE_POLL_STEADY: 30, # after DEVICE_POLL_TIME_TO_STEADY has elapsed, collect telemetry every n seconds
    ConfigKey.DEVICE_POLL_TIME_TO_STEADY: 600, # after n seconds, switch to steady state
    ConfigKey.DEFAULT_HTTP_ROUTING: HttpRoutingMode.ADB_TUNNELING.value,
    ConfigKey.TELEMETRY_PATH: "output",
    ConfigKey.TELEMETRY_COLLECTION: TelemetryCollectionMode.ALWAYS.value,
    ConfigKey.TELEMETRY_LOOP_POLL_INTERVAL: 10
}

def _load_config_file(path="vcat_config.json") -> dict:
    config_file = Path(path)
    if config_file.exists():
        try:
            with config_file.open("r") as f:
                raw = json.load(f)
            return {
                **DEFAULT_CONFIG,
                **{ConfigKey(k): v for k, v in raw.items() if k in ConfigKey._value2member_map_}
            }
        except Exception as e:
            print(f"⚠️ Failed to load config file ({path}), using defaults. Error: {e}")
    return DEFAULT_CONFIG

_config = _load_config_file()

def get_config_option(key: ConfigKey):
    return _config.get(key, DEFAULT_CONFIG[key])
