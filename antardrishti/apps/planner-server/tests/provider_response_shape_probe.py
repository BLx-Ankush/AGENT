"""
ANTARDRISHTI — Provider Response Shape Probe

Diagnoses the structural shape of OpenAI-compatible provider responses
when message.content is null.

Logs ONLY structural metadata — NO raw content, NO secrets, NO reasoning text.

Run:
  python apps/planner-server/tests/provider_response_shape_probe.py
  python apps/planner-server/tests/provider_response_shape_probe.py --llm-url URL --model MODEL
"""

import asyncio
import os
import sys
import time
import argparse


def describe_shape(resp_json: dict, label: str):
    """Print safe structural metadata of an OpenAI-compatible response."""
    print(f"\n  [{label}] Response shape:")

    # Top-level keys
    top_keys = sorted(resp_json.keys()) if isinstance(resp_json, dict) else []
    print(f"    responseKeys={top_keys}")

    choices = resp_json.get("choices") if isinstance(resp_json, dict) else None
    if not choices or not isinstance(choices, list) or len(choices) == 0:
        print(f"    choices=MISSING_OR_EMPTY")
        return

    choice = choices[0]
    choice_keys = sorted(choice.keys()) if isinstance(choice, dict) else []
    print(f"    choiceKeys={choice_keys}")

    finish_reason = choice.get("finish_reason")
    print(f"    finishReason={finish_reason}")

    message = choice.get("message")
    if not message or not isinstance(message, dict):
        print(f"    message=MISSING")
        return

    msg_keys = sorted(message.keys())
    print(f"    messageKeys={msg_keys}")

    # content
    content = message.get("content")
    if content is None:
        print(f"    content=null")
    elif isinstance(content, str):
        print(f"    content=string(len={len(content)})")
    elif isinstance(content, list):
        print(f"    content=list(len={len(content)})")
        # Describe part types without values
        part_types = []
        for p in content:
            if isinstance(p, str):
                part_types.append("string")
            elif isinstance(p, dict):
                part_types.append(f"dict(type={p.get('type', '?')})")
            else:
                part_types.append(type(p).__name__)
        print(f"    contentPartTypes={part_types}")
    else:
        print(f"    content=UNEXPECTED({type(content).__name__})")

    # reasoning
    if "reasoning" in message:
        r = message["reasoning"]
        if r is None:
            print(f"    reasoning=null")
        elif isinstance(r, str):
            print(f"    reasoning=string(len={len(r)})")
        else:
            print(f"    reasoning={type(r).__name__}")
    else:
        print(f"    reasoningPresent=false")

    # reasoning_content (some providers use this)
    if "reasoning_content" in message:
        rc = message["reasoning_content"]
        if rc is None:
            print(f"    reasoningContent=null")
        elif isinstance(rc, str):
            print(f"    reasoningContent=string(len={len(rc)})")
        else:
            print(f"    reasoningContent={type(rc).__name__}")

    # reasoning_details
    if "reasoning_details" in message:
        rd = message["reasoning_details"]
        if rd is None:
            print(f"    reasoningDetails=null")
        elif isinstance(rd, list):
            print(f"    reasoningDetails=list(len={len(rd)})")
        else:
            print(f"    reasoningDetails={type(rd).__name__}")

    # tool_calls
    if "tool_calls" in message:
        tc = message["tool_calls"]
        if tc is None:
            print(f"    toolCalls=null")
        elif isinstance(tc, list):
            print(f"    toolCalls=list(len={len(tc)})")
        else:
            print(f"    toolCalls={type(tc).__name__}")
    else:
        print(f"    toolCallsPresent=false")

    # refusal
    if "refusal" in message:
        ref = message["refusal"]
        if ref is None:
            print(f"    refusal=null")
        elif isinstance(ref, str):
            print(f"    refusal=string(len={len(ref)})")
        else:
            print(f"    refusal={type(ref).__name__}")

    # role
    role = message.get("role")
    print(f"    role={role}")


async def run_probes():
    import httpx

    parser = argparse.ArgumentParser(description="Provider response shape probe")
    parser.add_argument("--llm-url", default=os.environ.get("ANTARDRISHTI_LLM_BASE_URL", ""),
                        help="LLM API base URL")
    parser.add_argument("--model", default=os.environ.get("ANTARDRISHTI_LLM_MODEL", ""),
                        help="Model name")
    args = parser.parse_args()

    base_url = args.llm_url.rstrip("/") if args.llm_url else ""
    model = args.model
    api_key = os.environ.get("ANTARDRISHTI_LLM_API_KEY", "")

    if not base_url or not model:
        print("ERROR: --llm-url and --model (or env vars) must be set")
        sys.exit(1)

    if "/v1" not in base_url:
        base_url = base_url + "/v1"

    endpoint = f"{base_url}/chat/completions"

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    print(f"--- Provider Response Shape Probe ---")
    print(f"Endpoint: {endpoint}")
    print(f"Model: {model}")
    print(f"API key: {'configured' if api_key else 'NOT SET'}")

    async with httpx.AsyncClient(timeout=45.0) as client:

        # ── PROBE A: Minimal request ──
        print(f"\n{'='*50}")
        print(f"PROBE A — Minimal request (no system msg, no params)")
        payload_a = {
            "model": model,
            "messages": [
                {"role": "user", "content": 'Return exactly: {"ok":true}'}
            ],
        }
        start = time.time()
        try:
            resp = await client.post(endpoint, headers=headers, json=payload_a)
            elapsed = round((time.time() - start) * 1000)
            print(f"  HTTP {resp.status_code} | {elapsed}ms")
            if resp.is_success:
                describe_shape(resp.json(), "A")
            else:
                print(f"  FAILED: HTTP {resp.status_code}")
        except Exception as e:
            elapsed = round((time.time() - start) * 1000)
            print(f"  EXCEPTION: {type(e).__name__} | {elapsed}ms")

        # ── PROBE B: Full planner-like request ──
        print(f"\n{'='*50}")
        print(f"PROBE B — Full planner shape (system+user, temp, max_tokens)")
        payload_b = {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": "You are ANTARDRISHTI, a privacy-preserving browser agent planner. Output ONLY valid JSON. Never guess protected token values.",
                },
                {
                    "role": "user",
                    "content": 'Given a search box (id=n-1, role=searchbox), plan: {"actions":[{"kind":"type_text","id":"action-1","targetNodeId":"n-1","text":"test","reason":"Type query"}]}',
                },
            ],
            "temperature": 0.1,
            "max_tokens": 512,
        }
        start = time.time()
        try:
            resp = await client.post(endpoint, headers=headers, json=payload_b)
            elapsed = round((time.time() - start) * 1000)
            print(f"  HTTP {resp.status_code} | {elapsed}ms")
            if resp.is_success:
                describe_shape(resp.json(), "B")
            else:
                print(f"  FAILED: HTTP {resp.status_code}")
        except Exception as e:
            elapsed = round((time.time() - start) * 1000)
            print(f"  EXCEPTION: {type(e).__name__} | {elapsed}ms")

    print(f"\n{'='*50}")
    print("Done.")


if __name__ == "__main__":
    asyncio.run(run_probes())
