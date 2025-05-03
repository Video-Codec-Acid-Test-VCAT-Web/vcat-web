import json
import re
import subprocess
from enum import Enum
from typing import Optional
import vcat_adb

import requests
from flask import Response
from requests.models import Response as RequestsResponse


class RoutingMethod(Enum):
    HTTP = "http"
    ADB = "adb"


# Global routing preference (default: HTTP)
_current_routing_method = RoutingMethod.HTTP


def setRouting(method: RoutingMethod):
    global _current_routing_method
    _current_routing_method = method


def http_get_via_adb(session_id: str, device_id: str, ipAddr: str, path: str) -> Response:
    try:
        port_match = re.search(r":(\d+)", ipAddr)
        port = port_match.group(1) if port_match else "5302"

        # Sanitize path
        path = path if path.startswith("/") else f"/{path}"

        cmd = f"echo -e 'GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n' | nc 127.0.0.1 {port}"
        full_cmd = ["adb", "-s", device_id, "shell", cmd]

        output = vcat_adb.run_adb_command_with_log(session_id, device_id, full_cmd)

        if output is None:
            return Response("No response from ADB command", status=500)

        body_match = re.search(r"\r?\n\r?\n(.*)", output, re.DOTALL)
        if not body_match:
            return Response("No valid body found in ADB response", status=500)

        body = body_match.group(1).strip().rstrip("%")
        return Response(body, status=200, mimetype="application/json")

    except Exception as e:
        return Response(f"ADB GET failed: {str(e)}", status=500)


def http_get_via_network(ipAddr: str, path: str) -> Response:
    try:
        url = f"{ipAddr.rstrip('/')}/{path.lstrip('/')}"
        response = requests.get(url, timeout=5)
        return Response(
            response.text,  # or .content for bytes
            status=response.status_code,
            mimetype="application/json",
        )
    except Exception as e:
        return Response(f"Network GET failed: {str(e)}", status=500)


def get_device_http_response(session_id, device_id: str, ipAddr: str, path: str) -> Response:
    if _current_routing_method == RoutingMethod.ADB:
        return http_get_via_adb(session_id, device_id, ipAddr, path)
    else:
        return http_get_via_network(ipAddr, path)


def http_post_via_adb(
    device_id: str, path: str, json_payload: Optional[dict] = None
) -> Response:
    try:
        body_str = json.dumps(json_payload or {})
        content_length = len(body_str)

        # Escape double quotes and newlines in body
        safe_body = body_str.replace('"', '"').replace("\n", "")

        cmd = (
            f"echo -e 'POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n"
            f"Content-Length: {content_length}\r\nConnection: close\r\n\r\n{safe_body}' | nc 127.0.0.1 5302"
        )
        full_cmd = ["adb", "-s", device_id, "shell", cmd]
        result = subprocess.run(full_cmd, capture_output=True, text=True, timeout=5)

        body_match = re.search(r"\r?\n\r?\n(.*)", result.stdout, re.DOTALL)
        if not body_match:
            return Response("No valid body found in ADB POST response", status=500)

        body = body_match.group(1).strip().rstrip("%")
        return Response(body, status=200, mimetype="application/json")
    except Exception as e:
        return Response(f"ADB POST failed: {str(e)}", status=500)


def http_post_via_network(ipAddr: str, path: str, json_payload: Optional[dict] = None) -> Response:
    try:
        url = f"{ipAddr.rstrip('/')}/{path.lstrip('/')}"
        response = requests.post(url, json=json_payload, timeout=5)

        return Response(
            response.text,
            status=response.status_code,
            mimetype=response.headers.get("Content-Type", "application/json"),
        )
    except Exception as e:
        return Response(f"Network POST failed: {str(e)}", status=500)


def post_device_http_response(
    device_id: str, ipAddr: str, path: str, json_payload: Optional[dict] = None
) -> Response:
    if _current_routing_method == RoutingMethod.ADB:
        return http_post_via_adb(device_id, path, json_payload)
    else:
        try:
            return http_post_via_network(ipAddr, path, json_payload)
        except Exception as e:
            return Response(f"Network POST failed: {str(e)}", status=500)
