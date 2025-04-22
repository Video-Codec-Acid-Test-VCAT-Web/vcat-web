<img src="static/VCAT_Logo_tnsp.png" width="100" alt="VCAT Logo">

 # VCAT Web Remote Monitor

## Overview
vcat_web provides web control of VCAT benchmark sessions using a combination of ADB and http.  It consists of vcat_telemetry.py, a python telemetry server which provided the connections to the device under test, and the web server index.html>
vcat_web runs on python using flask.  See requirements.txt for setup details.
## To Run

1. Install VLC and VCAT on Android devices to be tested
2. Connect one or more Android devices to USB and ensure that they all have USB debugging enabled.
3. Launch vcat_telemetry.py
4. vcat_telemetry.py will default to port 5050.  From Browser, go to localhost:5050
5. Select a device and connect.
6. Start a VCAT benchmark on the connected device
