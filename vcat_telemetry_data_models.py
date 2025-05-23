import json
import re
from collections import OrderedDict
from typing import cast

from dataclasses import dataclass, field
from typing import Dict, Generic, List, Optional, OrderedDict, TypeVar, Union


__all__ = [
    "BatteryEntry",
    "CoreInfo",
    "CPUInfo",
    "CpuFreguencyEntry",
    "CpuUsageEntry",
    "CurrentTestVideo",
    "DeviceInfo",
    "DisplayResolution",
    "FramedropEntry",
    "LRUCache",
    "MemoryEntry",
    "MemoryInfo",
    "parse_device_info",
    "TelemetryData",
    "TestDetails",
    "make_empty_telemetry_data"
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

    @classmethod
    def from_dict(cls, data: dict, ip_addr: str = "none") -> "DeviceInfo":
        cpu_data = data.get("cpu", {})
        core_objs = []

        for label, desc in cpu_data.get("cores", {}).items():
            match = re.match(r"Cortex-([A-Z0-9\-]+).*?(\d+)\s*MHz", desc)
            if match:
                core_type = f"Cortex-{match.group(1)}"
                frequency = int(match.group(2))
                core_id = int(label.replace("core", ""))
                core_objs.append(CoreInfo(core_id=core_id, core_type=core_type, frequency_mhz=frequency))

        return cls(
            manufacturer=data.get("manufacturer", ""),
            model=data.get("model", ""),
            soc_manufacturer=data.get("soc_manufacturer", ""),
            soc=data.get("soc", ""),
            android_version=data.get("android_version", ""),
            ip_addr=ip_addr,
            cpu=CPUInfo(
                architecture=cpu_data.get("architecture", ""),
                cores=sorted(core_objs, key=lambda c: c.core_id)
            ),
            display_resolution=DisplayResolution(**data.get("display_resolution", {})),
            memory=MemoryInfo(**data.get("memory", {})),
            storage=StorageInfo(**data.get("storage", {}))
        )

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
    level: float
    current_ma: float = 0
    charge_count: int = 0
    battery_temp : float = 0


@dataclass
class FramedropEntry:
    elapsed_time: float = 0.0
    delta_framedrops: int = 0


@dataclass
class MemoryEntry:
    elapsed_time: float = 0.0
    used_kb: int = 0


@dataclass
class CpuUsageEntry:
    elapsed_time: float = 0
    usage_pct: Dict[str, float] = field(default_factory=dict)
    raw_stats: Dict[
        str, List[int]
    ]  = field(default_factory=dict)


@dataclass
class CpuFreguencyEntry:
    elapsed_time: float = 0.0
    frequencies: Dict[str, int] = field(default_factory=dict)


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
    app_memory: list[MemoryEntry]
    frame_drops: list[FramedropEntry]
    cpu_freq: List[CpuFreguencyEntry]
    cpu_usage: List[CpuUsageEntry] = field(default_factory=list)

def make_empty_telemetry_data() -> TelemetryData:
    obj = object.__new__(TelemetryData)

    # Explicitly cast to avoid Pyright confusion
    obj = cast(TelemetryData, obj)


    obj.owner_session_id = ""
    obj.device_id = ""
    obj.device_ipaddr = ""
    obj.device_info = DeviceInfo()  
    obj.start_time = 0.0
    obj.test_details = TestDetails()
    obj.battery_data = []
    obj.system_memory = []
    obj.app_memory = []
    obj.frame_drops = []
    obj.cpu_freq = []
    obj.cpu_usage = []

    return obj


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
