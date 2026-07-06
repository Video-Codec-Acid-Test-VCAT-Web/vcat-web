#!/usr/bin/env python3
# vcat_web
#
# SPDX-FileCopyrightText: Copyright (C) 2020-2025 VCAT authors and RoncaTech
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This file is part of vcat_web.
#
# vcat_web is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# vcat_web is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with vcat_web. If not, see <https://www.gnu.org/licenses/gpl-3.0.html>.
#
# For proprietary/commercial use cases, a written GPL-3.0 waiver or
# a separate commercial license is required from RoncaTech LLC.
#
# All VCAT artwork is owned exclusively by RoncaTech LLC. Use of VCAT logos
# and artwork is permitted for the purpose of discussing, documenting,
# or promoting VCAT itself. Any other use requires prior written permission
# from RoncaTech LLC.
#
# Contact: legal@roncatech.com

"""
Data models for telemetry entries, device info, and test configuration.
"""

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
    "GpuFrameStatsEntry",
    "LRUCache",
    "MemoryEntry",
    "MemoryInfo",
    "parse_device_info",
    "ProcTimeNs",
    "SessionInfo",
    "VcatdTelemetryData",
    "VcataiTelemetryData",
    "ThermalStatus",
    "TestConditions",
    "TestDetails",
    "SystemThermalStatus",
    "make_empty_telemetry_data",
    "make_empty_ai_telemetry_data"
]

from dataclasses import dataclass
from typing import Optional, Dict


@dataclass
class DecoderConfig:
    video_avc: Optional[str] = None
    video_hevc: Optional[str] = None
    video_vp9: Optional[str] = None
    video_av1: Optional[str] = None
    video_vvc: Optional[str] = None

    @staticmethod
    def from_dict(d: Dict[str, str]) -> "DecoderConfig":
        return DecoderConfig(
            video_avc=d.get("video/avc"),
            video_hevc=d.get("video/hevc"),
            video_vp9=d.get("video/x-vnd.on2.vp9"),
            video_av1=d.get("video/av01"),
            video_vvc=d.get("video/vvc"),
        )

    def to_dict(self) -> Dict[str, str]:
        result = {}
        if self.video_avc: result["video/avc"] = self.video_avc
        if self.video_hevc: result["video/hevc"] = self.video_hevc
        if self.video_vp9: result["video/x-vnd.on2.vp9"] = self.video_vp9
        if self.video_av1: result["video/av01"] = self.video_av1
        if self.video_vvc: result["video/vvc"] = self.video_vvc
        return result


@dataclass
class TestConditions:
    decoderConfig: DecoderConfig
    runLimit: int
    runMode: str
    screenBrightness: int
    threads: int

    @staticmethod
    def empty() -> "TestConditions":
        return TestConditions(
            decoderConfig=DecoderConfig(),  # all fields None by default
            runLimit=0,
            runMode="",
            screenBrightness=0,
            threads=0
        )

    @staticmethod
    def from_dict(d: Dict) -> "TestConditions":
        # vcat-ai logs (and some vcat-d logs) have no test_conditions block.
        if not d:
            return TestConditions.empty()
        decoder_dict = d.get("decoderCfg", {}).get("decoderConfig", {})
        return TestConditions(
            decoderConfig=DecoderConfig.from_dict(decoder_dict),
            runLimit=d.get("runLimit", 0),
            runMode=d.get("runMode", ""),
            screenBrightness=d.get("screenBrightness", 0),
            threads=d.get("threads", 0)
        )

    def to_dict(self) -> Dict:
        return {
            "decoderCfg": {
                "decoderConfig": self.decoderConfig.to_dict()
            },
            "runLimit": self.runLimit,
            "runMode": self.runMode,
            "screenBrightness": self.screenBrightness,
            "threads": self.threads
        }

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
    elapsed_time: float = 0.0
    level: float = 0
    current_ma: float = 0
    charge_count: int = 0
    battery_temp : float = 0


@dataclass
class FramedropEntry:
    elapsed_time: float = 0.0
    delta_framedrops: int = 0


@dataclass
class ProcTimeNs:
    """A timed processing/inference measurement in nanoseconds (vcat-ai)."""
    elapsed_time: float = 0.0
    value_ns: int = 0


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
class ThermalStatus:
    elapsed_time: float = 0.0
    cpu: Optional[float] = None
    gpu: Optional[float] = None
    npu: Optional[float] = None
    skin: Optional[float] = None
    soc: Optional[float] = None


@dataclass
class GpuFrameStatsEntry:
    elapsed_time: float = 0.0
    new_frames: int = 0
    avg_gpu_ms: float = 0.0
    max_gpu_ms: float = 0.0
    janky_frames: int = 0
    p50_ms: float = 0.0
    p90_ms: float = 0.0
    p95_ms: float = 0.0
    p99_ms: float = 0.0


@dataclass
class SystemThermalStatus:
    elapsed_time: float = 0.0
    status: int = 0


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
class SessionBatteryInfo:
    capacity_ma: float = 0.0
    initial_level_ma: float = 0.0
    initial_level_pct: float = 0.0

    @staticmethod
    def from_dict(d: dict) -> "SessionBatteryInfo":
        return SessionBatteryInfo(
            capacity_ma=d.get("capacity_ma", 0.0),
            initial_level_ma=d.get("initial_level_ma", 0.0),
            initial_level_pct=d.get("initial_level_pct", 0.0),
        )


@dataclass
class StartTime:
    unix_time_ms: float = 0.0
    local_date: str = ""
    local_time: str = ""

    @staticmethod
    def from_dict(d: dict) -> "StartTime":
        return StartTime(
            unix_time_ms=d.get("unix_time_ms", 0.0),
            local_date=d.get("local_date", ""),
            local_time=d.get("local_time", ""),
        )


@dataclass
class SessionInfo:
    playlist: str = ""
    vcat_version: str = ""
    battery: SessionBatteryInfo = field(default_factory=SessionBatteryInfo)
    start_time: StartTime = field(default_factory=StartTime)
    # Raw "test" object from the log header. vcat-ai's is a rich nested structure
    # (name/id/createdAt/testCases[...]); vcat-d has none.
    test: dict = field(default_factory=dict)

    @staticmethod
    def from_dict(d: dict) -> "SessionInfo":
        return SessionInfo(
            playlist=d.get("playlist", ""),
            vcat_version=d.get("vcat_version", ""),
            battery=SessionBatteryInfo.from_dict(d.get("battery", {})),
            start_time=StartTime.from_dict(d.get("start_time", {})),
            test=d.get("test", {}) or {},
        )

    def to_dict(self) -> dict:
        return {
            "playlist": self.playlist,
            "vcat_version": self.vcat_version,
            "battery": {
                "capacity_ma": self.battery.capacity_ma,
                "initial_level_ma": self.battery.initial_level_ma,
                "initial_level_pct": self.battery.initial_level_pct,
            },
            "start_time": {
                "unix_time_ms": self.start_time.unix_time_ms,
                "local_date": self.start_time.local_date,
                "local_time": self.start_time.local_time,
            },
            "test": self.test,
        }


@dataclass
class VcatdTelemetryData:
    version: int
    owner_session_id: str
    device_id: str
    device_ipaddr: str
    device_info: DeviceInfo
    session_info: SessionInfo
    start_time: float
    start_battery: BatteryEntry
    test_conditions: TestConditions
    test_details: TestDetails
    system_thermal_status: list[SystemThermalStatus]
    battery_data: list[BatteryEntry]
    system_memory: list[MemoryEntry]
    app_memory: list[MemoryEntry]
    frame_drops: list[FramedropEntry]
    cpu_freq: List[CpuFreguencyEntry]
    cpu_usage: List[CpuUsageEntry] = field(default_factory=list)
    gpu_usage: List[CpuUsageEntry] = field(default_factory=list)
    npu_usage: List[CpuUsageEntry] = field(default_factory=list)
    gpu_frame_stats: List[GpuFrameStatsEntry] = field(default_factory=list)
    thermal_status: List[ThermalStatus] = field(default_factory=list)

def make_empty_telemetry_data() -> VcatdTelemetryData:
    obj = object.__new__(VcatdTelemetryData)

    # Explicitly cast to avoid Pyright confusion
    obj = cast(VcatdTelemetryData, obj)

    obj.version = -1
    obj.owner_session_id = ""
    obj.device_id = ""
    obj.device_ipaddr = ""
    obj.device_info = DeviceInfo()
    obj.session_info = SessionInfo()
    obj.start_time = 0.0
    obj.start_battery = BatteryEntry()
    obj.test_conditions = TestConditions.empty()
    obj.test_details = TestDetails()
    obj.system_thermal_status = []
    obj.battery_data = []
    obj.system_memory = []
    obj.app_memory = []
    obj.frame_drops = []
    obj.cpu_freq = []
    obj.cpu_usage = []
    obj.gpu_usage = []
    obj.npu_usage = []
    obj.gpu_frame_stats = []
    obj.thermal_status = []

    return obj


@dataclass
class VcataiTelemetryData:
    version: int
    owner_session_id: str
    device_id: str
    device_ipaddr: str
    device_info: DeviceInfo
    session_info: SessionInfo
    start_time: float
    start_battery: BatteryEntry
    test_conditions: TestConditions
    test_details: TestDetails
    battery_data: list[BatteryEntry]
    system_memory: list[MemoryEntry]
    app_memory: list[MemoryEntry]
    cpu_freq: List[CpuFreguencyEntry]
    cpu_usage: List[CpuUsageEntry] = field(default_factory=list)
    system_thermal_status: List[SystemThermalStatus] = field(default_factory=list)
    infTimeNs: List[ProcTimeNs] = field(default_factory=list)
    infCpuTimeNs: List[ProcTimeNs] = field(default_factory=list)
    frameProcTime: List[ProcTimeNs] = field(default_factory=list)


def make_empty_ai_telemetry_data() -> VcataiTelemetryData:
    obj = object.__new__(VcataiTelemetryData)
    obj = cast(VcataiTelemetryData, obj)

    obj.version = -1
    obj.owner_session_id = ""
    obj.device_id = ""
    obj.device_ipaddr = ""
    obj.device_info = DeviceInfo()
    obj.session_info = SessionInfo()
    obj.start_time = 0.0
    obj.start_battery = BatteryEntry()
    obj.test_conditions = TestConditions.empty()
    obj.test_details = TestDetails()
    obj.battery_data = []
    obj.system_memory = []
    obj.app_memory = []
    obj.cpu_freq = []
    obj.cpu_usage = []
    obj.system_thermal_status = []
    obj.infTimeNs = []
    obj.infCpuTimeNs = []
    obj.frameProcTime = []

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

