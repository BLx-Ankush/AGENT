"""
ANTARDRISHTI — Planner Prompt Generation Tests

Verifies:
  1. Wait constraints are present in generated prompt
  2. JSON example includes milliseconds field
  3. Direct-action preference is stated
  4. No-wait-for-forms rule is stated
  5. Return-only-JSON instruction is present

Run: python tests/test_planner_prompt_constraints.py
"""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'apps', 'planner-server'))

from server import LLMPlanner, PlannerRequest, SessionInfo, TaskInfo, Scene, SceneNode, Viewport

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


# Build a minimal planner request for prompt generation
def make_request():
    return PlannerRequest(
        protocolVersion="2.0",
        session=SessionInfo(
            id="test-session",
            step=1,
            observationId="obs-1",
            origin="https://example.com",
            documentGeneration="doc-1",
            viewport=Viewport(width=1920, height=1080, devicePixelRatio=1),
        ),
        task=TaskInfo(sanitized="Search for OnePlus 12R", risk="low"),
        scene=Scene(nodes=[
            SceneNode(id="n-1", role="searchbox", name="Search", actionability="typable"),
            SceneNode(id="n-2", role="button", name="Submit"),
        ]),
        redactions=[],
        allowedActions=["click", "focus", "type_text", "type_token", "select", "scroll", "wait", "request_observation", "finish"],
    )


planner = LLMPlanner(model="test-model", base_url="https://example.com/v1", api_key="test")
request = make_request()
prompt = planner._build_prompt(request)


print("\n--- Planner Prompt Constraint Tests ---\n")


# Test 1: Wait constraint present
def test_wait_constraint():
    assert 'Do NOT use "wait" for ordinary page interactions' in prompt, \
        "Wait constraint not found in prompt"

run_test("PC-1 -- wait constraint present", test_wait_constraint)


# Test 2: milliseconds bounds stated
def test_milliseconds_bounds():
    assert "milliseconds" in prompt.lower()
    assert "<= 30000" in prompt or "30000" in prompt

run_test("PC-2 -- milliseconds bounds stated", test_milliseconds_bounds)


# Test 3: Direct action preference
def test_direct_action_preference():
    assert "Prefer direct actions" in prompt

run_test("PC-3 -- direct action preference stated", test_direct_action_preference)


# Test 4: No wait for forms rule
def test_no_wait_for_forms():
    assert "search/form/click" in prompt.lower() or "normal search/form/click" in prompt.lower()

run_test("PC-4 -- no-wait-for-forms rule stated", test_no_wait_for_forms)


# Test 5: JSON example has milliseconds
def test_json_example_milliseconds():
    assert '"milliseconds": 1000' in prompt or '"milliseconds":1000' in prompt

run_test("PC-5 -- JSON example includes milliseconds", test_json_example_milliseconds)


# Test 6: Return only JSON instruction
def test_return_only_json():
    assert "Return ONLY valid JSON" in prompt

run_test("PC-6 -- return-only-JSON instruction present", test_return_only_json)


# Test 7: No fenced code blocks instruction
def test_no_fenced_blocks():
    assert "no fenced code blocks" in prompt.lower() or "no markdown" in prompt.lower()

run_test("PC-7 -- no-fenced-blocks instruction present", test_no_fenced_blocks)


# Test 8: Wait integer requirement
def test_wait_integer():
    assert "MUST be an integer" in prompt

run_test("PC-8 -- wait milliseconds integer requirement", test_wait_integer)


# Test 9: Scene nodes present in prompt
def test_scene_nodes_present():
    assert "n-1" in prompt
    assert "searchbox" in prompt

run_test("PC-9 -- scene nodes included in prompt", test_scene_nodes_present)


# Test 10: Task present in prompt
def test_task_present():
    assert "Search for OnePlus 12R" in prompt

run_test("PC-10 -- task included in prompt", test_task_present)


# Summary
print(f"\n--- Planner Prompt Constraints: {passed} passed, {failed} failed ---")
if failures:
    print("\nFailures:")
    for f in failures:
        print(f"  FAIL  {f}")
sys.exit(1 if failed > 0 else 0)
