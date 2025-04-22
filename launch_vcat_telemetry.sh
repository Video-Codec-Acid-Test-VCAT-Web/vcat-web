#!/bin/bash

echo "🔍 Looking for process on port 5050..."
PID=$(lsof -ti:5050)

if [ -n "$PID" ]; then
    echo "💀 Killing process $PID on port 5050..."
    kill -9 $PID
else
    echo "No process found on port 5050."
fi

echo "🚀 Starting vcat_telemetry..."
source .venv/bin/activate
python3 vcat_telemetry.py
