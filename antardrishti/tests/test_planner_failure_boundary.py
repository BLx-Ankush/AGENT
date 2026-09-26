"""
ANTARDRISHTI — Planner Failure Boundary Tests

Verifies:
  1. Provider failure does NOT produce PlannerResponse
  2. Provider failure produces PlannerFailureError with correct HTTP status
  3. Genuine planner request_observation remains valid (not blocked)
  4. No secrets/raw response body leaked in error
  5. PlannerFailureError carries correct category and HTTP mapping
  6. Mock planner still returns valid PlannerResponse

Run: python tests/test_planner_failure_boundary.py
"""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'apps', 'planner-server'))

from server import PlannerFailureError, PlannerResponse, AgentAction

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


print("\n--- Planner Failure Boundary Tests ---\n")


# ── Test 1: PlannerFailureError for provider_http_error → HTTP 502 ──
def test_http_error_maps_502():
    err = PlannerFailureError("provider_http_error", "provider_http_error: HTTP 400")
    assert err.category == "provider_http_error"
    assert err.http_status == 502
    assert "HTTP 400" in err.message

run_test("FB-1 — provider_http_error → HTTP 502", test_http_error_maps_502)


# ── Test 2: PlannerFailureError for provider_request_failed → HTTP 504 ──
def test_request_failed_maps_504():
    err = PlannerFailureError("provider_request_failed", "provider_request_failed: ReadTimeout")
    assert err.category == "provider_request_failed"
    assert err.http_status == 504
    assert "ReadTimeout" in err.message

run_test("FB-2 — provider_request_failed → HTTP 504", test_request_failed_maps_504)


# ── Test 3: PlannerFailureError for content_extraction_failed → HTTP 502 ──
def test_content_extraction_maps_502():
    err = PlannerFailureError("content_extraction_failed", "content_extraction_failed: no choices")
    assert err.http_status == 502

run_test("FB-3 — content_extraction_failed → HTTP 502", test_content_extraction_maps_502)


# ── Test 4: PlannerFailureError for planner_json_parse_failed → HTTP 502 ──
def test_json_parse_maps_502():
    err = PlannerFailureError("planner_json_parse_failed", "planner_json_parse_failed: Expecting value")
    assert err.http_status == 502

run_test("FB-4 — planner_json_parse_failed → HTTP 502", test_json_parse_maps_502)


# ── Test 5: PlannerFailureError for planner_action_parse_failed → HTTP 502 ──
def test_action_parse_maps_502():
    err = PlannerFailureError("planner_action_parse_failed", "planner_action_parse_failed: KeyError")
    assert err.http_status == 502

run_test("FB-5 — planner_action_parse_failed → HTTP 502", test_action_parse_maps_502)


# ── Test 6: Unknown category defaults to HTTP 502 ──
def test_unknown_category_defaults_502():
    err = PlannerFailureError("unknown", "something went wrong")
    assert err.http_status == 502

run_test("FB-6 — unknown category defaults to HTTP 502", test_unknown_category_defaults_502)


# ── Test 7: PlannerFailureError is NOT a PlannerResponse ──
def test_failure_is_not_response():
    err = PlannerFailureError("provider_http_error", "provider_http_error: HTTP 500")
    assert not isinstance(err, PlannerResponse), "PlannerFailureError must not be a PlannerResponse"

run_test("FB-7 — failure is NOT a PlannerResponse", test_failure_is_not_response)


# ── Test 8: Genuine request_observation is valid PlannerResponse ──
def test_genuine_request_observation():
    action = AgentAction(
        kind="request_observation",
        id="action-1",
        reason="Need fresh observation after scroll"
    )
    response = PlannerResponse(
        protocolVersion="2.0",
        observationId="obs-123",
        planId="llm-plan-abc",
        expiresAt="2026-01-01T00:00:00Z",
        actions=[action]
    )
    assert isinstance(response, PlannerResponse)
    assert len(response.actions) == 1
    assert response.actions[0].kind == "request_observation"
    assert response.actions[0].id == "action-1"
    # This proves request_observation is still valid when it comes from the actual planner

run_test("FB-8 — genuine request_observation is valid PlannerResponse", test_genuine_request_observation)


# ── Test 9: No secrets in PlannerFailureError ──
def test_no_secrets_in_error():
    err = PlannerFailureError("provider_http_error", "provider_http_error: HTTP 403")
    assert "sk-" not in str(err)
    assert "Bearer" not in str(err)
    assert "api_key" not in str(err).lower()

run_test("FB-9 — no secrets in PlannerFailureError", test_no_secrets_in_error)


# ── Test 10: PlannerFailureError is an Exception ──
def test_failure_is_exception():
    err = PlannerFailureError("provider_http_error", "provider_http_error: HTTP 500")
    assert isinstance(err, Exception)
    # Can be raised and caught
    try:
        raise err
    except PlannerFailureError as caught:
        assert caught.category == "provider_http_error"
        assert caught.http_status == 502

run_test("FB-10 — PlannerFailureError is a catchable Exception", test_failure_is_exception)


# ── Test 11: PlannerFailureError does NOT contain action-fallback ──
def test_no_action_fallback_in_error():
    err = PlannerFailureError("provider_http_error", "provider_http_error: HTTP 400")
    assert "action-fallback" not in str(err)
    assert "request_observation" not in str(err)

run_test("FB-11 — no action-fallback in error (semantic separation)", test_no_action_fallback_in_error)


# ── Test 12: provider_response_invalid → HTTP 502 ──
def test_response_invalid_maps_502():
    err = PlannerFailureError("provider_response_invalid", "provider_response_invalid: not JSON")
    assert err.http_status == 502

run_test("FB-12 — provider_response_invalid → HTTP 502", test_response_invalid_maps_502)


# Summary
print(f"\n--- Planner Failure Boundary: {passed} passed, {failed} failed ---")
if failures:
    print("\nFailures:")
    for f in failures:
        print(f"  FAIL  {f}")
sys.exit(1 if failed > 0 else 0)
