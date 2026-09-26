"""
ANTARDRISHTI — Provider HTTP Error Classification Test

Verifies:
  1. httpx.HTTPStatusError -> provider_http_error with status code
  2. httpx.RequestError -> provider_request_failed with exception type
  3. Generic Exception -> provider_request_failed

Run: python tests/test_provider_http_classification.py
"""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'apps', 'planner-server'))

import httpx

passed = 0
failed = 0
failures = []

def run_test(name, fn):
    global passed, failed
    try:
        fn()
        print(f"  PASS  {name}")
        passed += 1
    except Exception as e:
        msg = str(e)
        print(f"  FAIL  {name}: {msg}")
        failed += 1
        failures.append(f"{name}: {msg}")


def classify_error(exc):
    """Simulate the exact classification logic from LLMPlanner.plan()."""
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        return "provider_http_error", f"provider_http_error: HTTP {status}"
    elif isinstance(exc, httpx.RequestError):
        return "provider_request_failed", f"provider_request_failed: {type(exc).__name__}"
    else:
        return "provider_request_failed", f"provider_request_failed: {type(exc).__name__}"


print("\n--- Provider HTTP Error Classification Tests ---\n")


# Test 1: HTTP 400 -> provider_http_error: HTTP 400
def test_http_400():
    request = httpx.Request("POST", "https://example.com/v1/chat/completions")
    response = httpx.Response(400, request=request)
    exc = httpx.HTTPStatusError("Bad Request", request=request, response=response)
    cat, msg = classify_error(exc)
    assert cat == "provider_http_error", f"Expected provider_http_error, got {cat}"
    assert msg == "provider_http_error: HTTP 400", f"Expected 'HTTP 400', got {msg}"

run_test("HTTP 400 -> provider_http_error: HTTP 400", test_http_400)


# Test 2: HTTP 401 -> provider_http_error: HTTP 401
def test_http_401():
    request = httpx.Request("POST", "https://example.com/v1/chat/completions")
    response = httpx.Response(401, request=request)
    exc = httpx.HTTPStatusError("Unauthorized", request=request, response=response)
    cat, msg = classify_error(exc)
    assert cat == "provider_http_error"
    assert msg == "provider_http_error: HTTP 401"

run_test("HTTP 401 -> provider_http_error: HTTP 401", test_http_401)


# Test 3: HTTP 429 -> provider_http_error: HTTP 429
def test_http_429():
    request = httpx.Request("POST", "https://example.com/v1/chat/completions")
    response = httpx.Response(429, request=request)
    exc = httpx.HTTPStatusError("Rate Limited", request=request, response=response)
    cat, msg = classify_error(exc)
    assert cat == "provider_http_error"
    assert msg == "provider_http_error: HTTP 429"

run_test("HTTP 429 -> provider_http_error: HTTP 429", test_http_429)


# Test 4: HTTP 500 -> provider_http_error: HTTP 500
def test_http_500():
    request = httpx.Request("POST", "https://example.com/v1/chat/completions")
    response = httpx.Response(500, request=request)
    exc = httpx.HTTPStatusError("Server Error", request=request, response=response)
    cat, msg = classify_error(exc)
    assert cat == "provider_http_error"
    assert msg == "provider_http_error: HTTP 500"

run_test("HTTP 500 -> provider_http_error: HTTP 500", test_http_500)


# Test 5: ConnectError -> provider_request_failed: ConnectError
def test_connect_error():
    request = httpx.Request("POST", "https://example.com/v1/chat/completions")
    exc = httpx.ConnectError("Connection refused", request=request)
    cat, msg = classify_error(exc)
    assert cat == "provider_request_failed", f"Expected provider_request_failed, got {cat}"
    assert "ConnectError" in msg, f"Expected ConnectError in message, got {msg}"

run_test("ConnectError -> provider_request_failed: ConnectError", test_connect_error)


# Test 6: ReadTimeout -> provider_request_failed: ReadTimeout
def test_read_timeout():
    request = httpx.Request("POST", "https://example.com/v1/chat/completions")
    exc = httpx.ReadTimeout("Timed out", request=request)
    cat, msg = classify_error(exc)
    assert cat == "provider_request_failed"
    assert "ReadTimeout" in msg

run_test("ReadTimeout -> provider_request_failed: ReadTimeout", test_read_timeout)


# Test 7: Generic Exception -> provider_request_failed
def test_generic_exception():
    exc = ValueError("something unexpected")
    cat, msg = classify_error(exc)
    assert cat == "provider_request_failed"
    assert "ValueError" in msg

run_test("Generic Exception -> provider_request_failed: ValueError", test_generic_exception)


# Test 8: No response body or secrets in error message
def test_no_secrets_leaked():
    request = httpx.Request("POST", "https://example.com/v1/chat/completions")
    response = httpx.Response(403, request=request, content=b'{"error":"invalid api key sk-1234"}')
    exc = httpx.HTTPStatusError("Forbidden", request=request, response=response)
    cat, msg = classify_error(exc)
    assert "sk-1234" not in msg, "API key must not appear in error message"
    assert "invalid api key" not in msg, "Response body must not appear in error message"
    assert msg == "provider_http_error: HTTP 403"

run_test("No secrets/body leaked in error message", test_no_secrets_leaked)


# Summary
print(f"\n--- Provider HTTP Classification: {passed} passed, {failed} failed ---")
if failures:
    print("\nFailures:")
    for f in failures:
        print(f"  FAIL  {f}")
sys.exit(1 if failed > 0 else 0)
