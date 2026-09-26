"""
ANTARDRISHTI — JSON Trailing Data Classifier Tests

Verifies the structural diagnostic that classifies trailing content
after the first valid JSON object.

Run: python tests/test_json_trailing_classifier.py
"""

import json
import sys

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


def classify_trailing(raw_text: str) -> dict:
    """Classify trailing content after first JSON value — safe, no raw values."""
    decoder = json.JSONDecoder()
    try:
        _obj, _end = decoder.raw_decode(raw_text)
    except (json.JSONDecodeError, ValueError):
        return {"firstJsonEnd": None, "trailingCategory": "no_valid_json"}

    trailing = raw_text[_end:]
    trailing_stripped = trailing.strip()
    trailing_ws_only = len(trailing) > 0 and len(trailing_stripped) == 0
    trailing_first_nw = next((c for c in trailing if not c.isspace()), None)

    result = {
        "rawLen": len(raw_text),
        "firstJsonEnd": _end,
        "trailingLen": len(trailing),
        "trailingWsOnly": trailing_ws_only,
        "trailingFirstNonWs": trailing_first_nw,
        "trailingCategory": "none",
        "secondJsonValue": False,
    }

    if len(trailing) == 0:
        result["trailingCategory"] = "none"
    elif trailing_ws_only:
        result["trailingCategory"] = "whitespace_only"
    elif trailing_stripped:
        ws_count = len(trailing) - len(trailing.lstrip())
        try:
            _, _ = decoder.raw_decode(raw_text, _end + ws_count)
            result["secondJsonValue"] = True
            result["trailingCategory"] = "second_json_value"
        except (json.JSONDecodeError, ValueError):
            if trailing_first_nw and trailing_first_nw.isalpha():
                result["trailingCategory"] = "trailing_prose_or_text"
            else:
                result["trailingCategory"] = "malformed_trailing_data"

    return result


print("\n--- JSON Trailing Data Classifier Tests ---\n")


# Test 1: Exact JSON object, no trailing
def test_exact_json():
    r = classify_trailing('{"actions":[{"kind":"click"}]}')
    assert r["trailingLen"] == 0
    assert r["trailingCategory"] == "none"
    assert r["secondJsonValue"] == False

run_test("JT-1 — exact JSON, no trailing", test_exact_json)


# Test 2: JSON + trailing whitespace
def test_json_whitespace():
    r = classify_trailing('{"actions":[]}   \n  ')
    assert r["trailingLen"] > 0
    assert r["trailingWsOnly"] == True
    assert r["trailingCategory"] == "whitespace_only"

run_test("JT-2 — JSON + whitespace", test_json_whitespace)


# Test 3: JSON + second JSON object
def test_json_second_value():
    r = classify_trailing('{"actions":[]} {"extra":true}')
    assert r["trailingLen"] > 0
    assert r["secondJsonValue"] == True
    assert r["trailingCategory"] == "second_json_value"

run_test("JT-3 — JSON + second JSON value", test_json_second_value)


# Test 4: JSON + trailing prose
def test_json_prose():
    r = classify_trailing('{"actions":[]}Here is an explanation of the plan')
    assert r["trailingCategory"] == "trailing_prose_or_text"
    assert r["trailingFirstNonWs"] == "H"

run_test("JT-4 — JSON + trailing prose", test_json_prose)


# Test 5: JSON + trailing prose after whitespace
def test_json_prose_ws():
    r = classify_trailing('{"actions":[]}  \nThis is extra text')
    assert r["trailingCategory"] == "trailing_prose_or_text"
    assert r["trailingFirstNonWs"] == "T"

run_test("JT-5 — JSON + whitespace + prose", test_json_prose_ws)


# Test 6: Malformed trailing data (non-alphabetic start)
def test_malformed_trailing():
    r = classify_trailing('{"actions":[]}!@#$')
    assert r["trailingCategory"] == "malformed_trailing_data"
    assert r["trailingFirstNonWs"] == "!"

run_test("JT-6 — malformed trailing data", test_malformed_trailing)


# Test 7: No valid JSON at all
def test_no_json():
    r = classify_trailing("This is not JSON at all")
    assert r["firstJsonEnd"] is None
    assert r["trailingCategory"] == "no_valid_json"

run_test("JT-7 — no valid JSON", test_no_json)


# Test 8: Two JSON objects newline-separated
def test_two_json_newline():
    r = classify_trailing('{"a":1}\n{"b":2}')
    assert r["secondJsonValue"] == True
    assert r["trailingCategory"] == "second_json_value"

run_test("JT-8 — two JSON objects newline-separated", test_two_json_newline)


# Test 9: JSON followed by a lone closing brace
def test_trailing_brace():
    r = classify_trailing('{"actions":[]}}')
    # The extra } is not alphabetic → malformed
    assert r["trailingCategory"] == "malformed_trailing_data"

run_test("JT-9 — trailing extra brace", test_trailing_brace)


# Test 10: Empty string
def test_empty():
    r = classify_trailing("")
    assert r["firstJsonEnd"] is None
    assert r["trailingCategory"] == "no_valid_json"

run_test("JT-10 — empty string", test_empty)


# Summary
print(f"\n--- JSON Trailing Classifier: {passed} passed, {failed} failed ---")
if failures:
    print("\nFailures:")
    for f in failures:
        print(f"  FAIL  {f}")
sys.exit(1 if failed > 0 else 0)
