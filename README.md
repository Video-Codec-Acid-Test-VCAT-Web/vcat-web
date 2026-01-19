<img src="static/VCAT_Logo_tnsp.png" width="100" alt="VCAT Logo">

# VCAT Web Remote Monitor

Web-based remote monitoring and control for VCAT (Video Codec Analysis Tool) benchmark sessions on Android devices.

## Features

- Real-time telemetry monitoring: CPU usage/frequency, memory (system & app), battery level, frame drops
- Multi-device support via ADB
- Live console log with ADB command history
- Export telemetry to Excel (.xlsx) or CSV
- Wireless ADB support
- Device info display (SoC, CPU cores, memory, storage, display resolution)

## Prerequisites

- **Python 3.9+**
- **ADB** installed and in PATH
- **Android device(s)** with:
  - USB debugging enabled
  - VCAT app installed

## Installation

```bash
# Clone the repository
git clone <repo-url>
cd vcat_web

# Create virtual environment (optional but recommended)
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

## Usage

### Start the Server

```bash
# Default: localhost:5050
python vcat_telemetry.py

# Custom host/port
python vcat_telemetry.py --host 0.0.0.0 --port 8080
```

### Connect to a Device

1. Connect Android device(s) via USB
2. Open browser to `http://localhost:5050`
3. Select a device from the dropdown and click Connect
4. The server will automatically launch VCAT on the device if not running
5. Start a benchmark from the VCAT app or view existing test results

### Wireless ADB

Click the "Wireless ADB" button after connecting via USB to enable wireless debugging. The device can then be disconnected from USB while maintaining the connection.

> **Note:** When a device is connected via USB, the battery will charge and not drain. For accurate battery consumption measurements during benchmarks, use Wireless ADB and disconnect the USB cable.

## Configuration

Create `vcat_config.json` in the project root to override defaults:

```json
{
  "telemetry_session_access_timeout_seconds": 7200,
  "console_access_timeout_seconds": 1800,
  "device_poll_initial_interval_seconds": 10,
  "device_poll_steady_state_interval_seconds": 30,
  "default_http_routing": "http",
  "telemetry_collection": "Always"
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `telemetry_session_access_timeout_seconds` | 7200 (2hr) | Idle timeout before device is disconnected |
| `console_access_timeout_seconds` | 1800 (30min) | Console log retention time |
| `device_poll_initial_interval_seconds` | 10 | Polling interval when first connecting |
| `device_poll_steady_state_interval_seconds` | 30 | Polling interval after 10 minutes |
| `default_http_routing` | AdbTunneling | `http` or `AdbTunneling` |
| `telemetry_collection` | Always | `Always` or `WhenTestRunning` |

## API Endpoints

All endpoints require `?session=<token>` query parameter. Device endpoints also require `?device=<device_id>`.

### Session
- `GET /api/session_token` - Get new session token
- `GET /api/session_console_log` - Get console history

### Device Management
- `GET /api/all_connected_devices` - List ADB devices
- `GET /api/device/info` - Get device hardware info
- `GET /api/device/ping` - Ping device IP
- `GET /api/wireless_adb` - Enable wireless ADB

### Monitoring
- `POST /api/vcat_monitor/start` - Start monitoring a device
- `POST /api/vcat_monitor/stop` - Stop monitoring
- `GET /api/vcat_monitor/telemetry` - Get live telemetry data
- `POST /api/vcat_monitor/reset` - Reset telemetry counters

### Test Control
- `POST /api/device/stop` - Stop current test
- `POST /api/device/play_pause` - Toggle playback
- `POST /api/device/show_stats` - Show video stats overlay

### Data Export
- `GET /api/device/files?path=/sdcard/...` - List files on device
- `GET /api/vcat_monitor/telemetry_from_file` - Parse telemetry CSV from device
- `GET /api/vcat_monitor/download_telemetry_file` - Download as Excel or CSV

## Output Files

- **logs/** - Server logs (symlink `latest.log` points to current)
- **output/** - Exported telemetry Excel files

## Troubleshooting

**Device not appearing:**
- Run `adb devices` to verify ADB sees the device
- Check USB debugging is enabled on device
- Try `adb kill-server && adb start-server`

**Cannot connect to device HTTP server:**
- Ensure VCAT app is running on device
- Check device and host are on same network (for HTTP mode)
- Try switching to ADB tunneling mode in config

**Telemetry not updating:**
- Check console log for errors
- Verify device is still connected (`adb devices`)
- Reset telemetry and reconnect

---

## Disclaimer of Suitability

VCAT Web is provided for general benchmarking and evaluation purposes only. RoncaTech makes no representations or guarantees that VCAT Web is suitable for any particular purpose, environment, or workflow. You are solely responsible for determining whether VCAT Web meets your needs. Under no circumstances should reliance on VCAT Web substitute for your own testing, validation, or professional judgment.

## Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT WILL RONCATECH, LLC OR ITS AFFILIATES, CONTRIBUTORS, OR SUPPLIERS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF PROFITS, REVENUE, DATA, OR USE, ARISING OUT OF OR IN CONNECTION WITH YOUR USE OF VCAT WEB, EVEN IF RONCATECH HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

You agree that your sole and exclusive remedy for any claim under or related to VCAT Web will be to discontinue use of the software.

## Patent Notice (No Patent Rights Granted)

VCAT Web is distributed under GPL-3.0-or-later. Nothing in this README, the source code, or the license grants you any rights under third-party patents, including without limitation patents essential to implement or use media codecs and container formats (e.g., AVC/H.264, HEVC/H.265, VVC/H.266, MPEG-2, AAC, etc.).

- You are solely responsible for determining whether your use, distribution, or deployment of VCAT Web requires patent licenses from any third party (including patent pools or individual patent holders) and for obtaining any such licenses.
- Contributions to this project may include a limited patent grant from contributors as specified by GPL-3.0-or-later, but no additional patent rights are provided, and no rights are granted on behalf of any third party.
- Use of bundled or integrated decoders/parsers does not imply or provide patent clearance for any jurisdiction. Your compliance with all applicable intellectual property laws remains your responsibility.

## License

VCAT Web is licensed under GPL-3.0-or-later.

See: https://www.gnu.org/licenses/gpl-3.0.html

Contact us for commercial licensing if you can't use GPL.

Use of the VCAT logo and artwork is permitted when discussing, documenting, demonstrating, or promoting VCAT itself. Any other usage requires prior written permission from RoncaTech LLC.

Contact: https://www.roncatech.com/contact
