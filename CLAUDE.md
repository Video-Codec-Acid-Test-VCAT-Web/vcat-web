# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VCAT Web is a Python Flask server that provides web-based remote monitoring and control of VCAT (Video Codec Analysis Tool) benchmark sessions running on Android devices. It communicates with devices via ADB and HTTP to collect telemetry data (CPU, memory, battery, frame drops) and export results.

## Running the Server

```bash
# Install dependencies
pip install -r requirements.txt

# Run the server (default: localhost:5050)
python vcat_telemetry.py

# With custom host/port
python vcat_telemetry.py --host 0.0.0.0 --port 8080
```

Prerequisites:
- Python 3.9+
- ADB installed and in PATH
- Android devices with USB debugging enabled and VCAT app installed

## Architecture

### Core Components

- **vcat_telemetry.py** - Main Flask server with REST API endpoints and telemetry polling worker thread
- **vcat_adb.py** - ADB command execution, device discovery, and per-session console logging
- **vcat_http_proxy.py** - Routes HTTP requests to devices via network or ADB tunneling
- **vcat_telemetry_data_models.py** - Dataclasses for device info, telemetry entries (CPU, memory, battery, frame drops)
- **vcat_telemetry_reader.py** - Parses CSV telemetry files exported from devices
- **vcat_telemetry_writer.py** - Creates and appends to Excel workbooks for telemetry export
- **vcat_config.py** - Configuration management with defaults (can be overridden via vcat_config.json)

### Frontend

- **static/index.html** - Single-page web interface
- **static/main.js** - Frontend JavaScript for device control and telemetry visualization
- **static/style.css** - Styling

### Data Flow

1. Browser requests session token from `/api/session_token`
2. User connects to a device via `/api/vcat_monitor/start` which launches VCAT app if needed
3. Background `telemetry_worker()` thread polls devices for CPU stats, memory, battery, and frame drops
4. Telemetry data stored in `telemetry_dataset` OrderedDict keyed by device_id
5. Frontend polls `/api/vcat_monitor/telemetry` for live data
6. Results can be exported to Excel via `/api/vcat_monitor/download_telemetry_file`

### HTTP Routing Modes

Device communication can use either:
- **HTTP** - Direct network requests to device IP
- **ADB Tunneling** - Routes requests through ADB shell using netcat

Configured via `ConfigKey.DEFAULT_HTTP_ROUTING` in vcat_config.py.

### Session Management

- Each browser tab gets a unique session token (UUID)
- Sessions track console history and last access time
- Stale sessions are cleaned up by background threads
- Device monitoring is per-device but session-aware for logging

## Key API Patterns

All API endpoints use decorators for validation:
- `@require_valid_session` - Validates session query param
- `@require_valid_session_and_device` - Validates session and device params
- `@require_valid_session_device_and_path` - Also validates path starts with /sdcard/

## Configuration

Default values in `vcat_config.py`, can be overridden in `vcat_config.json`:
- Session timeout: 2 hours
- Console timeout: 30 minutes
- Telemetry polling: 10s initial, 30s steady state (after 10 min)
