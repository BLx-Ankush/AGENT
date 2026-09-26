"""
ANTARDRISHTI — Provider Compatibility Probe

Isolated diagnostic to determine which request field causes HTTP 400
from the configured OpenAI-compatible provider.

Uses the SAME environment variables as production:
  ANTARDRISHTI_LLM_BASE_URL
  ANTARDRISHTI_LLM_MODEL
  ANTARDRISHTI_LLM_API_KEY

Sends 3 probes:
  A: Minimal request (no response_format, no extra params)
  B: Minimal + response_format: {type: "json_object"}
  C: Full production shape WITHOUT response_format

Reports ONLY: test name, HTTP status, latency, success/failure.
Does NOT log: API key, auth header, response body, prompt content.

Run: python apps/planner-server/tests/provider_compatibility_probe.py
"""

import asyncio
import os
import time
import sys


async def run_probes():
    import httpx
    import argparse

    parser = argparse.ArgumentParser(description="Provider compatibility probe")
    parser.add_argument("--llm-url", default=os.environ.get("ANTARDRISHTI_LLM_BASE_URL", ""),
                        help="LLM API base URL")
    parser.add_argument("--model", default=os.environ.get("ANTARDRISHTI_LLM_MODEL", ""),
                        help="Model name")
    args = parser.parse_args()

    base_url = args.llm_url.rstrip("/") if args.llm_url else ""
    model = args.model
    api_key = os.environ.get("ANTARDRISHTI_LLM_API_KEY", "")

    if not base_url or not model:
        print("ERROR: ANTARDRISHTI_LLM_BASE_URL and ANTARDRISHTI_LLM_MODEL must be set")
        sys.exit(1)

    # Normalize /v1
    if "/v1" not in base_url:
        base_url = base_url + "/v1"

    endpoint = f"{base_url}/chat/completions"

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    print(f"\n--- Provider Compatibility Probe ---")
    print(f"Endpoint: {endpoint}")
    print(f"Model: {model}")
    print(f"API key: {'configured' if api_key else 'NOT SET'}")
    print()

    results = {}

    async with httpx.AsyncClient(timeout=45.0) as client:

        # ── PROBE A: Minimal request ──
        payload_a = {
            "model": model,
            "messages": [
                {"role": "user", "content": 'Return exactly {"ok":true}'}
            ],
        }
        results["A"] = await _send_probe(client, "PROBE A (minimal, no response_format)", endpoint, headers, payload_a)

        # ── PROBE B: Minimal + response_format ──
        payload_b = {
            "model": model,
            "messages": [
                {"role": "user", "content": 'Return exactly {"ok":true}'}
            ],
            "response_format": {"type": "json_object"},
        }
        results["B"] = await _send_probe(client, "PROBE B (minimal + response_format)", endpoint, headers, payload_b)

        # ── PROBE C: Full production shape WITHOUT response_format ──
        payload_c = {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": "You are ANTARDRISHTI, a privacy-preserving browser agent planner. Output ONLY valid JSON. Never guess protected token values.",
                },
                {
                    "role": "user",
                    "content": 'Given a page with a search box (id=n-search, role=searchbox), plan actions to type "test". Return JSON: {"actions":[{"kind":"type_text","id":"action-1","targetNodeId":"n-search","text":"test","reason":"Type search query"}]}',
                },
            ],
            "temperature": 0.1,
            "max_tokens": 512,
        }
        results["C"] = await _send_probe(client, "PROBE C (full shape, no response_format)", endpoint, headers, payload_c)

        # ── PROBE D: Full production shape WITH response_format ──
        payload_d = dict(payload_c)
        payload_d["response_format"] = {"type": "json_object"}
        results["D"] = await _send_probe(client, "PROBE D (full shape + response_format)", endpoint, headers, payload_d)

    # ── Analysis ──
    print("\n--- Analysis ---\n")

    a_ok = results["A"]["success"]
    b_ok = results["B"]["success"]
    c_ok = results["C"]["success"]
    d_ok = results["D"]["success"]

    if a_ok and not b_ok and c_ok and not d_ok:
        print("CONCLUSION: response_format is strongly implicated.")
        print("  Minimal works, minimal+response_format fails.")
        print("  Full works without response_format, fails with it.")
    elif a_ok and b_ok and c_ok and not d_ok:
        print("CONCLUSION: response_format alone is NOT the cause.")
        print("  Minimal+response_format works, but full+response_format fails.")
        print("  Investigate prompt size or combined parameter interaction.")
    elif not a_ok:
        print("CONCLUSION: response_format is NOT the primary cause.")
        print("  Even the minimal request fails.")
        print(f"  Minimal HTTP status: {results['A']['status']}")
        print("  Investigate: model name, endpoint URL, API key, or provider contract.")
    elif a_ok and b_ok and c_ok and d_ok:
        print("CONCLUSION: All probes succeeded.")
        print("  The HTTP 400 may be intermittent or caused by")
        print("  production payload content (scene size, specific prompt, etc.).")
    elif a_ok and not b_ok:
        print("CONCLUSION: response_format is strongly implicated.")
        print(f"  Minimal works (HTTP {results['A']['status']}),")
        print(f"  but response_format fails (HTTP {results['B']['status']}).")
    else:
        print("CONCLUSION: Mixed results — manual inspection needed.")
        for k, v in results.items():
            print(f"  {k}: HTTP {v['status']} ({'OK' if v['success'] else 'FAIL'})")


async def _send_probe(client, name, endpoint, headers, payload):
    """Send a single probe and report results. Never logs secrets or body."""
    print(f"{name}:")
    start = time.time()
    result = {"success": False, "status": 0, "latency_ms": 0}

    try:
        resp = await client.post(endpoint, headers=headers, json=payload)
        elapsed = round((time.time() - start) * 1000)
        result["status"] = resp.status_code
        result["latency_ms"] = elapsed
        result["success"] = resp.is_success

        print(f"  HTTP {resp.status_code}")
        print(f"  latency={elapsed}ms")
        print(f"  success={resp.is_success}")

        if not resp.is_success:
            print(f"  category=provider_http_error")

    except Exception as e:
        elapsed = round((time.time() - start) * 1000)
        result["latency_ms"] = elapsed
        print(f"  EXCEPTION: {type(e).__name__}")
        print(f"  latency={elapsed}ms")
        print(f"  success=false")
        print(f"  category=provider_request_failed")

    print()
    return result


if __name__ == "__main__":
    asyncio.run(run_probes())
