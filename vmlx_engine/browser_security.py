# SPDX-License-Identifier: Apache-2.0
"""
Who may use a model server's HTTP port: the same rules as MLX Harness's
gateway (panel/src/main/gatewaySecurity.ts), as plain ASGI middleware.

- Host: only this Mac's own names (localhost, 127.x, ::1, *.localhost), so a
  web page cannot reach the server through a domain that resolves to
  127.0.0.1 (DNS rebinding). When the server listens on the network, IP
  addresses and .local names are accepted too, plus --trusted-hosts.
- Origin: native clients send none and pass. Web pages may call only from
  this Mac (localhost, any port), from desktop app webviews (app://, tauri://,
  vscode-webview://, vscode-file://), or from --allowed-origins ("*" = any).
- Other devices: when no API key is set, a client that is not this Mac is
  refused, so a server on 0.0.0.0 is never open to the network by accident.

The idea and the shape follow Rapid-MLX's browser_security middleware
(Apache-2.0); this is our own implementation.
"""

from __future__ import annotations

import ipaddress
import json
from typing import Iterable
from urllib.parse import urlsplit

APP_SCHEMES = ("app", "tauri", "vscode-webview", "vscode-file")


def _ip(value: str):
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        return None


def is_loopback_address(value: str | None) -> bool:
    if not value:
        return False
    v = value.strip().lower().strip("[]")
    if v.startswith("::ffff:"):
        v = v[7:]
    ip = _ip(v)
    return bool(ip and ip.is_loopback)


def is_loopback_bind(host: str | None) -> bool:
    h = (host or "127.0.0.1").strip().lower()
    return h == "localhost" or is_loopback_address(h)


def host_name(header: str | None) -> str | None:
    """'[::1]:8080' -> '::1', 'localhost:8080' -> 'localhost'; None when malformed."""
    if not header:
        return None
    h = header.strip().lower()
    if not h or any(c in h for c in " /@?#\t"):
        return None
    if h.startswith("["):
        end = h.find("]")
        if end < 0:
            return None
        rest = h[end + 1 :]
        if rest and not (rest.startswith(":") and rest[1:].isdigit() and len(rest) <= 6):
            return None
        return h[1:end]
    parts = h.split(":")
    if len(parts) > 2 or (len(parts) == 2 and not (parts[1].isdigit() and len(parts[1]) <= 5)):
        return None
    name = parts[0].rstrip(".")
    return name or None


def _is_loopback_name(name: str) -> bool:
    return name == "localhost" or name.endswith(".localhost") or is_loopback_address(name)


def _matches_trusted(name: str, trusted: Iterable[str]) -> bool:
    for t in trusted:
        p = t.strip().lower()
        if not p:
            continue
        if p.startswith("*."):
            if name.endswith(p[1:]) and len(name) > len(p) - 1:
                return True
        elif name == p:
            return True
    return False


def host_allowed(header: str | None, bind_host: str, trusted: Iterable[str] = ()) -> bool:
    name = host_name(header)
    if not name:
        return False
    if _is_loopback_name(name) or _matches_trusted(name, trusted):
        return True
    if not is_loopback_bind(bind_host):
        return _ip(name) is not None or name.endswith(".local")
    return False


def _normalize_origin(origin: str) -> str | None:
    try:
        u = urlsplit(origin.strip())
    except ValueError:
        return None
    if u.scheme in APP_SCHEMES:
        return f"{u.scheme}://{u.netloc}"
    if u.scheme not in ("http", "https") or not u.hostname:
        return None
    port = f":{u.port}" if u.port else ""
    host = f"[{u.hostname}]" if ":" in u.hostname else u.hostname
    return f"{u.scheme}://{host.lower()}{port}"


def origin_allowed(origin: str | None, allowed: Iterable[str]) -> bool:
    if not origin:
        return True  # native clients send none
    allowed = [a.strip() for a in allowed if a and a.strip()]
    if "*" in allowed:
        return True
    if origin == "null":
        return False
    try:
        u = urlsplit(origin)
    except ValueError:
        return False
    if u.scheme in APP_SCHEMES:
        return True
    if u.scheme in ("http", "https") and u.hostname and _is_loopback_name(u.hostname.lower()):
        return True
    normalized = _normalize_origin(origin)
    return bool(normalized) and any(_normalize_origin(a) == normalized for a in allowed)


# Used by CORSMiddleware so pages that pass the check above can read replies.
LOCAL_ORIGIN_REGEX = (
    r"^(https?://(localhost|127(\.\d{1,3}){3}|\[::1\]|[a-z0-9.-]+\.localhost)(:\d{1,5})?"
    r"|(app|tauri|vscode-webview|vscode-file)://.*)$"
)


class BrowserSecurityMiddleware:
    """ASGI middleware: refuse requests from foreign hosts, pages and devices."""

    def __init__(self, app, bind_host: str = "127.0.0.1", allowed_origins: Iterable[str] = (),
                 trusted_hosts: Iterable[str] = (), api_key_set: bool = False):
        self.app = app
        self.bind_host = bind_host
        self.allowed_origins = [o for o in allowed_origins if o]
        self.trusted_hosts = [h for h in trusted_hosts if h]
        self.api_key_set = api_key_set

    def verdict(self, host: str | None, origin: str | None, client: str | None) -> tuple[int, str, str] | None:
        if not host_allowed(host, self.bind_host, self.trusted_hosts):
            return 400, "invalid_host", "Invalid Host header. This server only answers requests addressed to this Mac."
        if not origin_allowed(origin, self.allowed_origins):
            return 403, "origin_not_allowed", "Cross-origin requests from this site are not allowed (see --allowed-origins)."
        if not self.api_key_set and client and not is_loopback_address(client):
            return 403, "api_key_required", "Set an API key (--api-key) to accept requests from other devices."
        return None

    async def __call__(self, scope, receive, send):
        if scope.get("type") not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = {}
        for k, v in scope.get("headers") or []:
            name = k.decode("latin-1").lower()
            if name in ("host", "origin") and name in headers:
                headers[name] = None  # duplicated: refuse below
            elif name in ("host", "origin"):
                headers[name] = v.decode("latin-1")
        if "host" in headers and headers["host"] is None:
            bad = (400, "invalid_host", "Duplicate Host header.")
        elif "origin" in headers and headers["origin"] is None:
            bad = (403, "origin_not_allowed", "Duplicate Origin header.")
        else:
            client = (scope.get("client") or (None,))[0]
            bad = self.verdict(headers.get("host"), headers.get("origin"), client)
        if bad is None:
            return await self.app(scope, receive, send)
        status, code, message = bad
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        body = json.dumps({"error": {"message": message, "type": "permission_error", "code": code}}).encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
