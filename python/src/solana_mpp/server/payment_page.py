"""HTML payment page and service worker helpers."""

from __future__ import annotations

import html
import importlib.resources
import json
from typing import Any
from urllib.parse import parse_qs, urlparse

from solana_mpp._types import PaymentChallenge

SERVICE_WORKER_PARAM = "__mpp_worker"

_TEMPLATE: str | None = None
_SERVICE_WORKER: str | None = None


def _load_resource(filename: str) -> str:
    """Load a resource file from the server/html package."""
    return importlib.resources.files("solana_mpp.server.html").joinpath(filename).read_text("utf-8")


def challenge_to_html(challenge: PaymentChallenge, rpc_url: str, network: str) -> str:
    """Render a self-contained HTML payment page for the given challenge.

    The page embeds the challenge data so that a browser can complete
    the Solana payment flow.
    """
    challenge_dict: dict[str, Any] = {
        "id": challenge.id,
        "realm": challenge.realm,
        "method": challenge.method,
        "intent": challenge.intent,
        "request": challenge.request,
    }
    if challenge.expires:
        challenge_dict["expires"] = challenge.expires
    if challenge.description:
        challenge_dict["description"] = challenge.description
    if challenge.digest:
        challenge_dict["digest"] = challenge.digest
    if challenge.opaque is not None:
        challenge_dict["opaque"] = challenge.opaque

    challenge_json = json.dumps(challenge_dict, separators=(",", ":"))
    escaped_challenge_json = html.escape(challenge_json)

    test_mode = network in ("devnet", "localnet")

    embedded_data = json.dumps(
        {
            "challenge": json.loads(challenge_json),
            "network": network,
            "rpcUrl": rpc_url,
            "testMode": test_mode,
        },
        separators=(",", ":"),
    )

    # Build description line
    description_line = ""
    try:
        request_data = challenge.decode_request()
        desc = request_data.get("description", "")
        if desc:
            description_line = f'<p style="color:#4a5568;text-align:center">{html.escape(str(desc))}</p>'
    except Exception:
        pass

    # Load payment UI JS
    global _TEMPLATE  # noqa: PLW0603
    if _TEMPLATE is None:
        try:
            _TEMPLATE = _load_resource("template.gen.html")
        except Exception:
            _TEMPLATE = ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payment Required</title>
<style>
body {{ font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: #f7fafc; }}
pre {{ background: #edf2f7; padding: 16px; border-radius: 8px; font-size: 13px; }}
</style>
</head>
<body>
{description_line}
<details style="max-width:600px;margin:0 auto 20px">
<summary style="cursor:pointer;color:#718096;font-size:14px">Challenge details</summary>
<pre>{escaped_challenge_json}</pre>
</details>
<div id="root"></div>
<script type="application/json" id="__MPP_DATA__">{embedded_data}</script>
</body>
</html>"""


def service_worker_js() -> str:
    """Return the embedded service worker JavaScript content."""
    global _SERVICE_WORKER  # noqa: PLW0603
    if _SERVICE_WORKER is None:
        try:
            _SERVICE_WORKER = _load_resource("service_worker.gen.js")
        except Exception:
            _SERVICE_WORKER = ""
    return _SERVICE_WORKER


def accepts_html(accept: str | None) -> bool:
    """Return True if the Accept header includes text/html."""
    if accept is None:
        return False
    return "text/html" in accept


def is_service_worker_request(url: str) -> bool:
    """Return True if the URL contains the service worker query parameter."""
    parsed = urlparse(url)
    params = parse_qs(parsed.query)
    return SERVICE_WORKER_PARAM in params
