# SPDX-License-Identifier: Apache-2.0
"""vmlx_engine.browser_security: the model server's Host/Origin/device rules."""

import asyncio
import json

from vmlx_engine.browser_security import (
    BrowserSecurityMiddleware,
    host_allowed,
    host_name,
    is_loopback_address,
    origin_allowed,
)


def test_host_names_on_this_mac_only():
    for h in ["localhost:8000", "127.0.0.1:8000", "[::1]:8000", "LOCALHOST", "x.localhost:1"]:
        assert host_allowed(h, "127.0.0.1"), h
    for h in ["evil.test:8000", "192.168.1.5:8000", "localhost.evil.com", "127.0.0.1.nip.io", "", None, "a b"]:
        assert not host_allowed(h, "127.0.0.1"), h
    assert host_allowed("192.168.1.5:8000", "0.0.0.0")
    assert host_allowed("macbook.local", "0.0.0.0")
    assert not host_allowed("evil.test", "0.0.0.0")
    assert host_allowed("gpu.example.com", "0.0.0.0", ["*.example.com"])
    assert host_name("[::1]:8000") == "::1"
    assert is_loopback_address("::ffff:127.0.0.1") and not is_loopback_address("10.0.0.2")


def test_origins():
    assert origin_allowed(None, [])
    for o in ["http://localhost:3000", "http://127.0.0.1:5173", "vscode-webview://x", "app://obsidian.md"]:
        assert origin_allowed(o, []), o
    for o in ["https://evil.test", "null", "http://localhost.evil.com"]:
        assert not origin_allowed(o, []), o
    assert origin_allowed("https://chat.example.com", ["https://chat.example.com"])
    assert origin_allowed("https://any.test", ["*"])


def _call(mw, headers, client=("127.0.0.1", 5000), kind="http"):
    sent = []
    reached = []

    async def app(scope, receive, send):
        reached.append(True)

    async def send(msg):
        sent.append(msg)

    async def receive():
        return {"type": "http.request"}

    m = BrowserSecurityMiddleware(app, **mw)
    scope = {"type": kind, "headers": [(k.encode(), v.encode()) for k, v in headers], "client": client}
    asyncio.run(m(scope, receive, send))
    return reached, sent


def test_middleware_refuses_and_passes():
    ok, _ = _call({}, [("host", "127.0.0.1:8000")])
    assert ok
    _, sent = _call({}, [("host", "attacker.test:8000")])
    assert sent[0]["status"] == 400 and json.loads(sent[1]["body"])["error"]["code"] == "invalid_host"
    _, sent = _call({}, [("host", "localhost:8000"), ("origin", "https://evil.test")])
    assert sent[0]["status"] == 403
    _, sent = _call({}, [("host", "localhost:8000"), ("host", "evil.test")])
    assert sent[0]["status"] == 400
    # Another device: refused without an API key, let through with one set.
    _, sent = _call({"bind_host": "0.0.0.0"}, [("host", "192.168.1.5:8000")], client=("192.168.1.9", 1))
    assert sent[0]["status"] == 403
    ok, _ = _call({"bind_host": "0.0.0.0", "api_key_set": True}, [("host", "192.168.1.5:8000")], client=("192.168.1.9", 1))
    assert ok
    _, sent = _call({}, [("host", "evil.test")], kind="websocket")
    assert sent == [{"type": "websocket.close", "code": 1008}]
