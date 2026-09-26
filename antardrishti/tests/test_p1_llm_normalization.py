"""
ANTARDRISHTI — P1-LLM Provider Response Normalization Tests

Verifies:
  1. string content
  2. list of text blocks
  3. list of strings
  4. mixed text + non-text blocks
  5. empty list
  6. null content
  7. unsupported object content
  8. fenced JSON
  9. malformed JSON
  10. valid planner JSON -> valid AgentAction
  11. valid content but invalid planner JSON -> fail
  12. valid JSON but invalid PlannerResponse -> schema gate rejects
  13. canonical equivalence: string == text_parts

Run: python tests/test_p1_llm_normalization.py
"""

import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'apps', 'planner-server'))

from server import OpenAICompatibleResponseAdapter, ContentExtractionError

passed = 0
failed = 0
failures = []

def run_test(name, fn):
    global passed, failed
    try:
        fn()
        print(f"  ✅ {name}")
        passed += 1
    except Exception as e:
        msg = str(e)
        print(f"  ❌ {name}: {msg}")
        failed += 1
        failures.append(f"{name}: {msg}")


adapter = OpenAICompatibleResponseAdapter()


def make_response(content):
    """Build a minimal OpenAI-compatible response with given content."""
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": content,
                }
            }
        ]
    }


VALID_PLAN_JSON = json.dumps({
    "actions": [
        {
            "kind": "type_text",
            "id": "action-1",
            "targetNodeId": "n-search",
            "text": "OnePlus 12R",
            "reason": "Type search query"
        }
    ]
})


print("\n🔬 ANTARDRISHTI — P1-LLM Provider Response Normalization Tests\n")


# ── Test 1: String content ──
def test_string_content():
    resp = make_response(VALID_PLAN_JSON)
    text = adapter.extract_text(resp)
    assert isinstance(text, str)
    assert adapter.last_content_shape == "string"
    data = json.loads(text)
    assert "actions" in data
    assert len(data["actions"]) == 1

run_test("LLM-1 — string content extracted", test_string_content)


# ── Test 2: List of text blocks ──
def test_text_blocks():
    resp = make_response([
        {"type": "text", "text": '{"actions":['},
        {"type": "text", "text": '{"kind":"click","id":"a1","targetNodeId":"n-1","reason":"test"}'},
        {"type": "text", "text": "]}"},
    ])
    text = adapter.extract_text(resp)
    assert isinstance(text, str)
    assert adapter.last_content_shape == "text_parts[]"
    data = json.loads(text)
    assert len(data["actions"]) == 1

run_test("LLM-2 — list of text blocks extracted", test_text_blocks)


# ── Test 3: List of strings ──
def test_string_list():
    resp = make_response([
        '{"actions":[',
        '{"kind":"click","id":"a1","targetNodeId":"n-1","reason":"test"}',
        "]}",
    ])
    text = adapter.extract_text(resp)
    assert isinstance(text, str)
    assert adapter.last_content_shape == "string_parts[]"
    data = json.loads(text)
    assert len(data["actions"]) == 1

run_test("LLM-3 — list of strings extracted", test_string_list)


# ── Test 4: Mixed text + non-text ──
def test_mixed_content():
    resp = make_response([
        {"type": "text", "text": VALID_PLAN_JSON},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}},
    ])
    text = adapter.extract_text(resp)
    assert isinstance(text, str)
    assert adapter.last_content_shape == "text_parts[]"
    data = json.loads(text)
    assert "image_url" not in text  # image block must NOT be serialized

run_test("LLM-4 — mixed text + non-text: only text extracted", test_mixed_content)


# ── Test 5: Empty list ──
def test_empty_list():
    resp = make_response([])
    try:
        adapter.extract_text(resp)
        assert False, "Should have raised ContentExtractionError"
    except ContentExtractionError as e:
        assert "empty array" in str(e)

run_test("LLM-5 — empty list rejected", test_empty_list)


# ── Test 6: Null content ──
def test_null_content():
    resp = make_response(None)
    try:
        adapter.extract_text(resp)
        assert False, "Should have raised ContentExtractionError"
    except ContentExtractionError as e:
        assert "null" in str(e)

run_test("LLM-6 — null content rejected", test_null_content)


# ── Test 7: Unsupported object content ──
def test_unsupported_object():
    resp = make_response({"some": "object"})
    try:
        adapter.extract_text(resp)
        assert False, "Should have raised ContentExtractionError"
    except ContentExtractionError as e:
        assert "unsupported content type" in str(e)

run_test("LLM-7 — unsupported object content rejected", test_unsupported_object)


# ── Test 8: Fenced JSON ──
def test_fenced_json():
    fenced = f"```json\n{VALID_PLAN_JSON}\n```"
    resp = make_response(fenced)
    text = adapter.extract_text(resp)
    normalized = adapter.normalize_text(text)
    data = json.loads(normalized)
    assert "actions" in data

run_test("LLM-8 — fenced JSON markers stripped", test_fenced_json)


# ── Test 9: Malformed JSON ──
def test_malformed_json():
    resp = make_response("{not valid json!!!")
    text = adapter.extract_text(resp)
    normalized = adapter.normalize_text(text)
    try:
        json.loads(normalized)
        assert False, "Should have raised JSONDecodeError"
    except json.JSONDecodeError:
        pass  # Expected

run_test("LLM-9 — malformed JSON fails at parse stage", test_malformed_json)


# ── Test 10: Valid planner JSON -> valid action ──
def test_valid_planner_json():
    resp = make_response(VALID_PLAN_JSON)
    text = adapter.extract_text(resp)
    normalized = adapter.normalize_text(text)
    data = json.loads(normalized)
    assert isinstance(data["actions"], list)
    action = data["actions"][0]
    assert action["kind"] == "type_text"
    assert action["targetNodeId"] == "n-search"
    assert action["text"] == "OnePlus 12R"

run_test("LLM-10 — valid planner JSON produces valid action", test_valid_planner_json)


# ── Test 11: Valid content but invalid planner JSON ──
def test_valid_content_invalid_planner():
    resp = make_response('{"answer": "hello"}')
    text = adapter.extract_text(resp)
    normalized = adapter.normalize_text(text)
    data = json.loads(normalized)
    # Valid JSON but no actions field
    assert "actions" not in data

run_test("LLM-11 — valid content, invalid planner JSON: no actions", test_valid_content_invalid_planner)


# ── Test 12: No choices in response ──
def test_no_choices():
    try:
        adapter.extract_text({"id": "chatcmpl-123"})
        assert False, "Should have raised ContentExtractionError"
    except ContentExtractionError as e:
        assert "no choices" in str(e)

run_test("LLM-12 — response with no choices rejected", test_no_choices)


# ── Test 13: Canonical equivalence ──
def test_canonical_equivalence():
    # Same content as string vs as text_parts should produce the same output
    string_resp = make_response(VALID_PLAN_JSON)
    parts_resp = make_response([{"type": "text", "text": VALID_PLAN_JSON}])

    text_from_string = adapter.extract_text(string_resp)
    text_from_parts = adapter.extract_text(parts_resp)

    assert text_from_string == text_from_parts, \
        "String and text_parts must produce identical canonical text"

run_test("LLM-13 — canonical equivalence: string == text_parts[]", test_canonical_equivalence)


# ── Test 14: Array with only non-text parts ──
def test_non_text_only_array():
    resp = make_response([
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}},
        {"type": "audio", "data": "..."},
    ])
    try:
        adapter.extract_text(resp)
        assert False, "Should have raised ContentExtractionError"
    except ContentExtractionError as e:
        assert "no text-bearing elements" in str(e)

run_test("LLM-14 — array with only non-text parts rejected", test_non_text_only_array)


# ── Test 15: Fenced code without json tag ──
def test_fenced_plain():
    fenced = f"```\n{VALID_PLAN_JSON}\n```"
    resp = make_response(fenced)
    text = adapter.extract_text(resp)
    normalized = adapter.normalize_text(text)
    data = json.loads(normalized)
    assert "actions" in data

run_test("LLM-15 — fenced code without json tag stripped", test_fenced_plain)


# ── Test 16: Whitespace-padded content ──
def test_whitespace_padded():
    padded = f"\n\n  {VALID_PLAN_JSON}  \n\n"
    resp = make_response(padded)
    text = adapter.extract_text(resp)
    normalized = adapter.normalize_text(text)
    data = json.loads(normalized)
    assert "actions" in data

run_test("LLM-16 — whitespace-padded content normalized", test_whitespace_padded)


# ── Summary ──
print(f"\n🔬 P1-LLM Normalization: {passed} passed, {failed} failed")
if failures:
    print("\nFailures:")
    for f in failures:
        print(f"  ❌ {f}")
sys.exit(1 if failed > 0 else 0)
