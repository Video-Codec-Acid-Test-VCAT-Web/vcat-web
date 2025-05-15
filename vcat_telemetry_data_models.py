import json
import re
from collections import OrderedDict

from dataclasses import dataclass, field
from typing import Dict, Generic, List, Optional, OrderedDict, TypeVar, Union


__all__ = [
    "AppMemoryEntry",
    "BatteryEntry",
    "CpuFreguencyEntry",
    "CpuUsageEntry",
    "CurrentTestVideo",
    "DeviceInfo",
    "FramedropEntry",
    "LRUCache",
    "MemoryEntry",
    "parse_device_info",
    "TelemetryData",
    "TestDetails",
]


@dataclass
class CoreInfo:
    core_id: int = 0
    core_type: str = ""
    frequency_mhz: int = 0


@dataclass
class CPUInfo:
    architecture: str = ""
    cores: List[CoreInfo] = field(default_factory=list)


@dataclass
class DisplayResolution:
    width: int = 0
    height: int = 0


@dataclass
class MemoryInfo:
    total: str = ""
    available: str = ""


@dataclass
class StorageInfo:
    total: str = ""
    available: str = ""


@dataclass
class DeviceInfo:
    manufacturer: str = ""
    model: str = ""
    soc_manufacturer: str = ""
    soc: str = ""
    android_version: str = ""
    ip_addr: str = "none"
    cpu: CPUInfo = field(default_factory=CPUInfo)
    display_resolution: DisplayResolution = field(default_factory=DisplayResolution)
    memory: MemoryInfo = field(default_factory=MemoryInfo)
    storage: StorageInfo = field(default_factory=StorageInfo)

    def to_dict(self) -> dict:
        return {
            "manufacturer": self.manufacturer,
            "model": self.model,
            "soc_manufacturer": self.soc_manufacturer,
            "soc": self.soc,
            "ip_addr" : self.ip_addr,
            "android_version": self.android_version,
            "cpu": {
                "architecture": self.cpu.architecture,
                "cores": {
                    f"core{core.core_id}": f"{core.core_type}, {core.frequency_mhz} MHz"
                    for core in self.cpu.cores
                },
            },
            "display_resolution": {
                "width": self.display_resolution.width,
                "height": self.display_resolution.height,
            },
            "memory": {"total": self.memory.total, "available": self.memory.available},
            "storage": {
                "total": self.storage.total,
                "available": self.storage.available,
            },
        }


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
    device_info: DeviceInfo
    start_time: float
    test_details: TestDetails
    battery_data: list[BatteryEntry]
    system_memory: list[MemoryEntry]
    app_memory: list[AppMemoryEntry]
    frame_drops: list[FramedropEntry]
    cpu_freq: List[CpuFreguencyEntry]
    cpu_usage: List[CpuUsageEntry] = field(default_factory=list)


def parse_cores(core_dict: dict) -> List[CoreInfo]:
    cores = []
    for core_label, desc in core_dict.items():
        match = re.match(r"Cortex-([A-Z0-9\-]+).*?(\d+)\s*MHz", desc)
        if match:
            core_type = f"Cortex-{match.group(1)}"
            frequency = int(match.group(2))
            core_id = int(core_label.replace("core", ""))
            cores.append(
                CoreInfo(core_id=core_id, core_type=core_type, frequency_mhz=frequency)
            )
    return sorted(cores, key=lambda c: c.core_id)


def parse_device_info(data: dict, ip_addr) -> DeviceInfo:
    cpu_info = CPUInfo(
        architecture=data["cpu"]["architecture"],
        cores=parse_cores(data["cpu"]["cores"]),
    )
    return DeviceInfo(
        manufacturer=data["manufacturer"],
        model=data["model"],
        soc_manufacturer=data["soc_manufacturer"],
        soc=data["soc"],
        android_version=data["android_version"],
        ip_addr=ip_addr,
        cpu=cpu_info,
        display_resolution=DisplayResolution(**data["display_resolution"]),
        memory=MemoryInfo(**data["memory"]),
        storage=StorageInfo(**data["storage"]),
    )


K = TypeVar("K")
V = TypeVar("V")
T = TypeVar("T")


class LRUCache(OrderedDict, Generic[K, V]):
    def __init__(self, capacity: int):
        super().__init__()
        self.capacity = capacity

    def get(self, key: K, default: T = None) -> Union[V, T]:
        if key in self:
            self.move_to_end(key)
            return super().get(key)  # type: ignore
        return default
