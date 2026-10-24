# SPDX-License-Identifier: Apache-2.0
"""
Who may use a model server's HTTP port: the same rules as MLX Harness's
gateway (panel/src/main/gatewaySecurity.ts), as plain ASGI middleware.

- Host: names a web page cannot rebind to this Mac (DNS rebinding): this
  Mac's own names, any IP address, and private names (.local, .internal,
  .localhost, so Docker's host.docker.internal works), plus --trusted-hosts.
  Public DNS names are refused.
- Origin: native clients send none and pass. Web pages may call only from
  this Mac (localhost, any port), from desktop app webviews (app://, tauri://,
  vscode-webview://, vscode-file://), or from --allowed-origins ("*" = any).
- A page's background GET (no-cors, no Origin) from another site is refused
  by its Sec-Fetch-Site header.
- Other devices: when no API key is set, a client that is not this Mac is
  refused, so a server on 0.0.0.0 is never open to the network by accident.
  A connection to this Mac's own LAN address counts as this Mac.

The idea and the shape follow Rapid-MLX's browser_security middleware
(Apache-2.0); this is our own implementation.
"""

from __future__ import annotations

import ipaddress
import json
import socket
import time
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


_PRIVATE_SUFFIXES = (".local", ".internal", ".home.arpa")
_identity: tuple[float, set[str], set[str]] = (0.0, set(), set())


def own_identity() -> tuple[set[str], set[str]]:
    """This Mac's host names and interface addresses (refreshed every 30 s)."""
    global _identity
    at, names, addresses = _identity
    if time.monotonic() - at < 30 and at:
        return names, addresses
    names, addresses = set(), set()
    try:
        host = socket.gethostname().lower().rstrip(".")
        base = host[:-6] if host.endswith(".local") else host
        names = {host, base, base + ".local"}
    except Exception:  # noqa: BLE001
        pass
    try:
        import psutil

        for entries in psutil.net_if_addrs().values():
            for entry in entries:
                if entry.family in (socket.AF_INET, socket.AF_INET6):
                    addresses.add(entry.address.split("%", 1)[0].lower())
    except Exception:  # noqa: BLE001 - psutil missing: loopback only
        pass
    _identity = (time.monotonic(), names, addresses)
    return names, addresses


def host_allowed(header: str | None, bind_host: str = "127.0.0.1", trusted: Iterable[str] = (),
                 own_names: Iterable[str] | None = None) -> bool:
    name = host_name(header)
    if not name:
        return False
    if _is_loopback_name(name) or _ip(name) is not None or name.endswith(_PRIVATE_SUFFIXES):
        return True
    own = own_identity()[0] if own_names is None else set(own_names)
    return name in own or _matches_trusted(name, trusted)


def is_this_mac(address: str | None, own_addresses: Iterable[str] | None = None) -> bool:
    if is_loopback_address(address):
        return True
    if not address:
        return False
    a = address.strip().lower().strip("[]").split("%", 1)[0]
    if a.startswith("::ffff:") and "." in a:
        a = a[7:]
    own = own_identity()[1] if own_addresses is None else {o.lower() for o in own_addresses}
    return a in own


def _normalize_origin(origin: str) -> str | None:
    try:
        u = urlsplit(origin.strip())
    except ValueError:
        return None
    if u.scheme in APP_SCHEMES:
        return f"{u.scheme}://{u.netloc}"
    if u.scheme not in ("http", "https") or not u.hostname:
        return None
    try:
        port = f":{u.port}" if u.port else ""
    except ValueError:  # a port out of range
        return None
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
    r"(?i)^(https?://(localhost|127(\.\d{1,3}){3}|\[::1\]|[a-z0-9.-]+\.localhost)(:\d{1,5})?"
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

    def verdict(self, host: str | None, origin: str | None, client: str | None,
                fetch_site: str | None = None) -> tuple[int, str, str] | None:
        if not host_allowed(host, self.bind_host, self.trusted_hosts):
            return 400, "invalid_host", "Invalid Host header. This server only answers requests addressed to this Mac."
        blind_page = not origin and (fetch_site or "").lower() == "cross-site" and "*" not in self.allowed_origins
        if blind_page or not origin_allowed(origin, self.allowed_origins):
            return 403, "origin_not_allowed", "Cross-origin requests from this site are not allowed (see --allowed-origins)."
        if not self.api_key_set and client and not is_this_mac(client):
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
            elif name in ("host", "origin", "sec-fetch-site"):
                headers[name] = v.decode("latin-1")
        if "host" in headers and headers["host"] is None:
            bad = (400, "invalid_host", "Duplicate Host header.")
        elif "origin" in headers and headers["origin"] is None:
            bad = (403, "origin_not_allowed", "Duplicate Origin header.")
        else:
            client = (scope.get("client") or (None,))[0]
            bad = self.verdict(headers.get("host"), headers.get("origin"), client, headers.get("sec-fetch-site"))
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
