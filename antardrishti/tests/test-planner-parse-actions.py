"""
ANTARDRISHTI — Planner _parse_actions Regression Test

Focused test for LLMPlanner._parse_actions() covering:
  - valid click action accepted
  - invalid targetNodeId is discarded
  - unknown action kind is discarded
  - malformed (non-dict) array entry is discarded
  - valid action fields are preserved

Run: python tests/test-planner-parse-actions.py
"""

import sys
import os

# Add planner-server to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "planner-server"))

from server import (
    LLMPlanner,
    PlannerRequest,
    SessionInfo,
    TaskInfo,
    Scene,
    SceneNode,
    Viewport,
    AgentAction,
)

passed = 0
failed = 0
failures = []


def run_test(name, fn):
    global passed, failed
    try:
        fn()
        print(f"  PASS {name}")
        passed += 1
    except Exception as e:
        print(f"  FAIL {name}: {e}")
        failed += 1
        failures.append(f"{name}: {e}")


# ── Helpers ──────────────────────────────────────────────────

def make_request(node_ids=None):
    """Create a minimal PlannerRequest with given node IDs."""
    nodes = [SceneNode(id=nid, role="button") for nid in (node_ids or ["n1", "n2"])]
    return PlannerRequest(
        protocolVersion="2.0",
        session=SessionInfo(
            id="test-session",
            step=1,
            observationId="obs-1",
            origin="https://example.com",
            documentGeneration="gen-1",
            viewport=Viewport(width=1024, height=768),
        ),
        task=TaskInfo(sanitized="Click the button", risk="low"),
        scene=Scene(nodes=nodes),
    )


planner = LLMPlanner(model="test", base_url="http://test", api_key="test")

# ── Tests ────────────────────────────────────────────────────

print("\n[PARSE] ANTARDRISHTI -- _parse_actions Regression Test\n")

# 1. Valid click action
def test_valid_click():
    req = make_request(["n1", "n2"])
    plan_data = {
        "actions": [
            {"kind": "click", "id": "action-1", "targetNodeId": "n1", "reason": "Click button"},
        ]
    }
    actions = planner._parse_actions(plan_data, req)
    assert len(actions) == 1, f"Expected 1 action, got {len(actions)}"
    assert actions[0].kind == "click"
    assert actions[0].targetNodeId == "n1"
    assert actions[0].reason == "Click button"
    assert actions[0].id == "action-1"

run_test("PARSE-1 — valid click action accepted", test_valid_click)


# 2. Invalid targetNodeId is discarded
def test_invalid_target():
    req = make_request(["n1", "n2"])
    plan_data = {
        "actions": [
            {"kind": "click", "id": "action-1", "targetNodeId": "NONEXISTENT"},
        ]
    }
    actions = planner._parse_actions(plan_data, req)
    assert len(actions) == 0, f"Expected 0 actions (invalid target), got {len(actions)}"

run_test("PARSE-2 — invalid targetNodeId is discarded", test_invalid_target)


# 3. Unknown action kind is discarded
def test_unknown_kind():
    req = make_request(["n1"])
    plan_data = {
        "actions": [
            {"kind": "hack_the_planet", "id": "action-1", "targetNodeId": "n1"},
            {"kind": "navigate", "id": "action-2", "targetNodeId": "n1"},
        ]
    }
    actions = planner._parse_actions(plan_data, req)
    assert len(actions) == 0, f"Expected 0 actions (unknown kinds), got {len(actions)}"

run_test("PARSE-3 — unknown action kind is discarded", test_unknown_kind)


# 4. Malformed (non-dict) entry is discarded
def test_malformed_entry():
    req = make_request(["n1"])
    plan_data = {
        "actions": [
            "not a dict",
            42,
            None,
            {"kind": "click", "id": "action-1", "targetNodeId": "n1"},
        ]
    }
    actions = planner._parse_actions(plan_data, req)
    assert len(actions) == 1, f"Expected 1 action (3 malformed skipped), got {len(actions)}"
    assert actions[0].kind == "click"

run_test("PARSE-4 — malformed array entry is discarded", test_malformed_entry)


# 5. Valid action fields are preserved
def test_fields_preserved():
    req = make_request(["n1"])
    plan_data = {
        "actions": [
            {
                "kind": "type_token",
                "id": "action-1",
                "targetNodeId": "n1",
                "token": "<SENSITIVE_ABC123>",
                "expectedRole": "textbox",
                "reason": "Fill PAN field",
                "text": None,
                "milliseconds": 500,
            },
        ]
    }
    actions = planner._parse_actions(plan_data, req)
    assert len(actions) == 1
    a = actions[0]
    assert a.kind == "type_token"
    assert a.token == "<SENSITIVE_ABC123>"
    assert a.expectedRole == "textbox"
    assert a.reason == "Fill PAN field"
    assert a.milliseconds == 500

run_test("PARSE-5 — valid action fields are preserved", test_fields_preserved)


# 6. Max 5 actions enforced
def test_max_5_actions():
    req = make_request(["n1"])
    plan_data = {
        "actions": [
            {"kind": "click", "targetNodeId": "n1"} for _ in range(10)
        ]
    }
    actions = planner._parse_actions(plan_data, req)
    assert len(actions) == 5, f"Expected 5 actions (max enforced), got {len(actions)}"

run_test("PARSE-6 — max 5 actions enforced", test_max_5_actions)


# 7. No targetNodeId is valid for finish/wait/request_observation
def test_no_target_valid():
    req = make_request(["n1"])
    plan_data = {
        "actions": [
            {"kind": "finish", "id": "action-1", "reason": "Task complete"},
            {"kind": "wait", "id": "action-2", "milliseconds": 1000},
            {"kind": "request_observation", "id": "action-3"},
        ]
    }
    actions = planner._parse_actions(plan_data, req)
    assert len(actions) == 3, f"Expected 3 actions (no target needed), got {len(actions)}"

run_test("PARSE-7 — actions without targetNodeId are valid", test_no_target_valid)


# 8. Empty actions list returns empty
def test_empty_actions():
    req = make_request(["n1"])
    actions = planner._parse_actions({"actions": []}, req)
    assert len(actions) == 0
    actions2 = planner._parse_actions({}, req)
    assert len(actions2) == 0

run_test("PARSE-8 — empty actions list returns empty", test_empty_actions)


# ── Summary ──────────────────────────────────────────────────

print(f"\n[PARSE] _parse_actions: {passed} passed, {failed} failed")

if failures:
    print("\nFailures:")
    for f in failures:
        print(f"  ❌ {f}")

sys.exit(1 if failed > 0 else 0)
