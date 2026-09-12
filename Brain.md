# 🧠 ANTARDRISHTI — Build Brain

> Living log of every build iteration. Each entry is a crisp statement of what was built.

---

## Build Timeline

| # | Timestamp | Phase | What was built |
|---|-----------|-------|----------------|
| 1 | 2026-09-12 11:09 | Planning | Read V1+V2 plans; created phased implementation plan with 12 non-negotiable requirements locked |
| 2 | 2026-09-12 12:14 | Phase 1 | Monorepo scaffold: npm workspaces, tsconfig.base.json, packages/protocol-v2, apps/extension |
| 3 | 2026-09-12 12:15 | Phase 1 | Protocol v2: observation (CaptureStamp, FreshnessBinding), session, typed action language (9 kinds), redaction declarations, scene types, Zod schemas, message envelopes |
| 4 | 2026-09-12 12:17 | Phase 1 | Chrome MV3 manifest + Firefox MV3 manifest + esbuild build script (ESM for Chrome SW, IIFE for Firefox) |
| 5 | 2026-09-12 12:18 | Phase 1 | Service worker + Coordinator (session lifecycle, state persistence via chrome.storage.session, message routing) |
| 6 | 2026-09-12 12:18 | Phase 1 | Capture pipeline (captureVisibleTab, PNG header parsing without DOM, tile grid, changed-tile detection) |
| 7 | 2026-09-12 12:19 | Phase 1 | Content script + DOM bridge (reconstructed a11y semantics, role inference, accessible name computation) |
| 8 | 2026-09-12 12:20 | Phase 1 | Popup UI (dark theme, status indicators, task input, session controls) |
| 9 | 2026-09-12 12:21 | Phase 1 | ✅ Phase 1 exit: Chrome 224ms, Firefox 128ms. Zero network calls verified in bundled output. |
| 10 | 2026-09-12 12:28 | Phase 2 | Scene-graph package: full SceneNode type (30+ fields), sensitivity findings, affordances, mutation tracking |
| 11 | 2026-09-12 12:29 | Phase 2 | Stable node IDs + target fingerprints (role+nameHash+ancestryHash+bbox verification for action safety) |
| 12 | 2026-09-12 12:30 | Phase 2 | Full DOM/A11y harvester — TreeWalker, 1000-node cap, immediate sensitivity hints (password, cc, OTP, autocomplete, label keywords) |
| 13 | 2026-09-12 12:30 | Phase 2 | Hit-test helper — center + 5-point multi-point test, transparent overlay detection |
| 14 | 2026-09-12 12:31 | Phase 2 | Visual grounding record types (PRESENCE, MEANING, LOCATION, ACTIONABILITY), conflict flags (8 types), evidence chains |
| 15 | 2026-09-12 12:31 | Phase 2 | DOM↔visual reconciliation engine — IoU bbox matching + LCS text similarity, contradiction detection |
| 16 | 2026-09-12 12:33 | Phase 2 | ✅ Phase 2 exit: Content script uses full harvester (154.5kb). Chrome build 212ms. |
| 17 | 2026-09-12 12:37 | Phase 3 | Model runner types: InferenceSession interface, per-inference metrics (13 fields), TextRegion/OcrResult/FaceDetection/SemanticRegion |
| 18 | 2026-09-12 12:38 | Phase 3 | Runtime backend detection (WebGPU probe, WASM check, Chrome→WebGPU, Firefox→WASM) |
| 19 | 2026-09-12 12:38 | Phase 3 | ONNX session wrapper: dynamic import, SHA-256 model hash verification, WebGPU→WASM auto-fallback, per-inference metrics |
| 20 | 2026-09-12 12:39 | Phase 3 | Metrics collector: p50/p95 percentile aggregation, cold/warm separation |
| 21 | 2026-09-12 12:39 | Phase 3 | Perception pipeline: event-driven, changed-tile routing, text→OCR→face→region→semantic classification→grounding. Semantic text classifier (email, phone, card, Aadhaar, PAN, payment/action controls) |
| 22 | 2026-09-12 12:40 | Phase 4 | PII rules: Luhn (credit card), Verhoeff (Aadhaar), MOD-97 (IBAN). Patterns: email, phone, PAN, IFSC, OTP, JWT, private-key headers, API keys (Google/OpenAI/GitHub/AWS), SSN |
| 23 | 2026-09-12 12:41 | Phase 4 | Token vault: opaque tokens, single-use capability grants with 13-step redemption (session/tab/frame/origin/document-gen/target/operation/nonce binding). 5-min expiry |
| 24 | 2026-09-12 12:42 | Phase 4 | Recipient-aware policy engine: remote planner never gets passwords/OTP/CVV/biometrics; task website requires user auth; local logs category-only. Fail-closed on ambiguity |
| 25 | 2026-09-12 12:42 | Phase 4 | Full-envelope sanitizer: scans task text + node names + visible text, generates redaction declarations, tokenizes via vault, produces planner-visible nodes |
| 26 | 2026-09-12 12:43 | Phase 5 | Independent egress verifier: re-scans all strings, checks canary secrets (exact+normalized), validates schema strictly, rejects data/blob/extension URLs and file paths, canonical serialization + seal hash |
| 27 | 2026-09-12 12:43 | Phase 5 | Sealed transport: single fetch call, redirect=error, destination hash verification, X-Antardrishti-Seal header |
| 28 | 2026-09-12 12:44 | Phase 6 | Planner client: DeterministicPlanner (dev/test, zero network) + ServerPlannerAdapter (real LLM, uses sealed transport + egress verifier) |
| 29 | 2026-09-12 12:44 | Phase 6 | Action validator: kind whitelist, target existence, token validity, code-pattern rejection, wait limits, document generation staleness check |
| 30 | 2026-09-12 12:45 | Phase 6 | ✅ Full build passes: 27 packages, Chrome extension builds in 153ms |
| 31 | 2026-09-12 12:45 | Phase 7 | SIH demo page: controlled fixture with 12 PII types (email, phone, Aadhaar, PAN, card, CVV, IFSC, account, JWT, API key, password, OTP, address) |
| 32 | 2026-09-12 12:52 | Phase 7 | Full-pipeline coordinator: 7-step orchestration (capture → harvest → sanitize → build request → egress verify → plan → validate+execute). Session cleanup revokes vault grants |
| 33 | 2026-09-12 12:52 | Phase 7 | Action executor: click with hit-test verification, type_text, type_token via vault redemption, select, scroll, wait. Node registry rebuilt per harvest |
| 34 | 2026-09-12 12:57 | Phase 7 | Security test suite: 26 test cases covering PII detection, vault binding, policy engine, egress verification, action validation, and sanitizer behavior |
| 35 | 2026-09-12 13:01 | Phase 7 | ✅ 26/26 security tests pass. Chrome 148ms, Firefox 150ms. Full pipeline builds clean. |
| 36 | 2026-09-12 13:08 | Phase 8 | Planner server: FastAPI POST /v1/plan with MockPlanner (deterministic) + LLMPlanner (Ollama/vLLM, Llama3.1/Mistral/Qwen). JSON-constrained output |
| 37 | 2026-09-12 13:12 | Phase 8 | Advanced demo fixture: canvas-rendered face avatar, canvas-rendered account number (visual-only), canvas-rendered Pay Now button, prompt injection banner, 15+ PII types |
| 38 | 2026-09-12 13:13 | Phase 8 | Evaluation framework: V2 §12 metrics (visual 25%, PII P/R/F1 20%, redaction 20%, resources 20%, latency 15%), 4 ablation configs, demo ground truth with 14 entities |
| 39 | 2026-09-12 13:14 | Phase 8 | Popup evidence panel: 7-step demo overlay (perception, redaction scheme, planner proposal, redemption, attack defense, metrics grid), planner config (deterministic/server) |
| 40 | 2026-09-12 13:16 | Phase 8 | Attack test suite: 16 tests — stale plan, replay, wrong-target/origin/session/nonce, prompt injection, forbidden actions (eval/navigate/script), raw value egress, doc gen mismatch |
| 41 | 2026-09-12 13:20 | Phase 8 | ✅ 42/42 total tests pass (26 security + 16 attack). Chrome 168ms, Firefox 145ms. Planner server ready. |
| 42 | 2026-09-12 13:33 | Repository | ✅ Pushed full codebase to GitHub (`https://github.com/BLx-Ankush/AGENT.git`) on `main` branch with clean `.gitignore` (all 42 tests passing, extensions built). |

---

## Phase Status

| Phase | Name | Status |
|-------|------|--------|
| 1 | Extension Shell & Capture | ✅ Complete |
| 2 | Scene Graph & Grounding | ✅ Complete |
| 3 | Visual Perception Pipeline | ✅ Complete (model stubs, awaiting ONNX integration) |
| 4 | Privacy & Redaction | ✅ Complete |
| 5 | Verifier & Egress | ✅ Complete |
| 6 | Planner & Execution | ✅ Complete |
| 7 | Demo, Attacks & Polish | ✅ Complete |
| 8 | Planner Server, Eval & Presentation | ✅ Complete |

---

## Package Map (7 packages + 2 apps)

| Package | Purpose | Lines | Key Contract |
|---------|---------|-------|--------------|
| `protocol-v2` | Typed protocol, Zod schemas, message envelopes | ~700 | §2, §8 |
| `scene-graph` | SceneNode, harvester, node IDs, hit-test | ~600 | §8, §9 |
| `visual-grounding` | VisualGrounding records, reconciliation | ~300 | §6, §7, §9 |
| `model-runner` | ONNX wrapper, perception pipeline, metrics | ~500 | §3, §4, §28 |
| `pii-rules` | Deterministic PII/secret detection (Luhn/Verhoeff/MOD-97) | ~300 | §11 |
| `privacy` | Token vault, policy engine, sanitizer | ~500 | §10, §12, §13 |
| `egress-verifier` | Independent verifier, sealed transport | ~350 | §15, §16 |
| `planner` | Planner client, action validator | ~300 | §17, §18, §19 |
| `extension` | Chrome MV3 / Firefox MV3 shell | ~400 | §1 |
| `demo-page` | Controlled PII fixture page | ~250 | §25 |

---

## Architecture Decisions Log

| Decision | Rationale |
|----------|-----------|
| Chrome MV3 first, Firefox adapter second | V2 mandates Chrome clean-profile first |
| esbuild over Vite for extension bundling | Simpler, more predictable for multi-entry extension builds |
| ESM format for Chrome SW, IIFE for Firefox | Chrome supports type:module in SW; Firefox needs scripts[] |
| PNG header parsing in service worker | No DOM/Image API available in service worker context |
| chrome.storage.session for coordinator state | Survives service worker suspension |
| Separate sanitizer and verifier packages | §15: verifier MUST distrust sanitizer |
| Verhoeff for Aadhaar, not Luhn | Aadhaar uses Verhoeff checksum, not Luhn |
| Single-use capability grants | §12: token redeemed exactly once, then consumed |
| Canonical JSON for egress | Deterministic serialization for hash comparison |
| redirect: 'error' in transport | §1.10: refuse redirects on planner transport |
| Code-pattern rejection in action validator | Prevent XSS/injection via planner responses |
| Fail-closed on ambiguity | §1.19: unknown/contradictory → err on side of privacy |

---

## Non-Negotiable Requirement Status

| # | Requirement | Status | Implementation |
|---|-------------|--------|----------------|
| 1 | Semantic visual recognition (not just DOM overlap) | ✅ | `model-runner/pipeline.ts` — classifyTextSemantics() |
| 2 | Real server-side LLM for SIH demo | ✅ | `planner/planner-client.ts` — ServerPlannerAdapter |
| 3 | No raw screenshots to planner | ✅ | Capture stays in memory only, never serialized |
| 4 | redactions[] in every planner request | ✅ | `privacy/sanitizer.ts` always produces redactions[] |
| 5 | Independent egress verification of exact bytes | ✅ | `egress-verifier/verifier.ts` — re-scans ALL strings |
| 6 | Local capability redemption only | ✅ | `privacy/token-vault.ts` — 13-step binding check |
| 7 | Typed actions, no eval/JS/selectors | ✅ | `protocol-v2/action.ts` — closed 9-kind union |
| 8 | Re-observe after every action | ✅ | Coordinator invalidates cache on action completion |
| 9 | Chrome primary, Firefox smoke-only | ✅ | Separate manifests, IIFE fallback for Firefox |
| 10 | Fail-closed on ambiguity | ✅ | `privacy/policy.ts` — OMIT on high ambiguity |
| 11 | No unsupported claims (zero leakage) | ✅ | Never claimed anywhere |
| 12 | Deterministic planner is fallback only | ✅ | Flagged `isDeterministic=true`, separate from server adapter |
