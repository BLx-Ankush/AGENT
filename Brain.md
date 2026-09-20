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
| 35 | 2026-09-13 13:01 | Phase 7 | ✅ 26/26 security tests pass. Chrome 148ms, Firefox 150ms. Full pipeline builds clean. |
| 36 | 2026-09-12 13:08 | Phase 8 | Planner server: FastAPI POST /v1/plan with MockPlanner (deterministic) + LLMPlanner (Ollama/vLLM, Llama3.1/Mistral/Qwen). JSON-constrained output |
| 37 | 2026-09-12 13:12 | Phase 8 | Advanced demo fixture: canvas-rendered face avatar, canvas-rendered account number (visual-only), canvas-rendered Pay Now button, prompt injection banner, 15+ PII types |
| 38 | 2026-09-12 13:13 | Phase 8 | Evaluation framework: V2 §12 metrics (visual 25%, PII P/R/F1 20%, redaction 20%, resources 20%, latency 15%), 4 ablation configs, demo ground truth with 14 entities |
| 39 | 2026-09-12 13:14 | Phase 8 | Popup evidence panel: 7-step demo overlay (perception, redaction scheme, planner proposal, redemption, attack defense, metrics grid), planner config (deterministic/server) |
| 40 | 2026-09-12 13:16 | Phase 8 | Attack test suite: 16 tests — stale plan, replay, wrong-target/origin/session/nonce, prompt injection, forbidden actions (eval/navigate/script), raw value egress, doc gen mismatch |
| 41 | 2026-09-12 13:20 | Phase 8 | ✅ 42/42 total tests pass (26 security + 16 attack). Chrome 168ms, Firefox 145ms. Planner server ready. |
| 42 | 2026-09-12 13:33 | Repository | ✅ Pushed full codebase to GitHub (`https://github.com/BLx-Ankush/AGENT.git`) on `main` branch with clean `.gitignore` (all 42 tests passing, extensions built). |
| 43 | 2026-09-13 10:21 | Phase 9-10 | Complete SIH-ready implementation: final GO/NO-GO audit, presentation deck, demo scripts, and architecture lock |
| 44 | 2026-09-13 10:38 | Security | Update esbuild to patched version (GHSA-67mh-4wv8-2f99) — 0 npm vulnerabilities across monorepo |
| 45 | 2026-09-13 12:55 | Evaluation | Automated SIH Final Evaluation Harness + Report generator (`eval/test-configuration-comparison.mts`, ablation matrix across 5 scoring axes) |
| 46 | 2026-09-13 13:40 | Hardening | Hardening: PII recall boosted from 66.7% to 100%, IoU ground truth harness bug fixed, evaluation report v2 published |
| 47 | 2026-09-13 17:16 | Privacy | Privacy generalization pass: created `@antardrishti/semantic-sensitivity` package for generalized semantic boundary detection beyond static regexes |
| 48 | 2026-09-13 17:26 | Build | Build pipeline update: copy ONNX models directly into `dist/{target}/models/` for extension runtime access |
| 49 | 2026-09-13 18:41 | Runtime | Pre-Phase 9 runtime integration fixes: asset path resolution and Chrome/Firefox manifest web-accessible declarations |
| 50 | 2026-09-13 19:18 | Runtime | Fix ORT WASM MV3 Service Worker: resolved `XMLHttpRequest is not defined` in worker context via custom fetch fetcher |
| 51 | 2026-09-13 19:45 | Runtime | WASM-only ORT entry + object wasmPaths configuration + CSP-clean smoke test harness |
| 52 | 2026-09-14 12:36 | Runtime | Fix SW bundling: eliminated dynamic `import()` from MV3 service worker via static bundling in esbuild (Blocker #3 resolution) |
| 53 | 2026-09-14 13:17 | Phase 9 | Deterministic backend selection override (`webgpu`, `wasm`, `cpu`) with auto-fallback and test harness (Phase 9 §1-8) |
| 54 | 2026-09-14 14:38 | Phase 9 | Offscreen Document ONNX inference (`offscreen.html`, `offscreen.ts`): isolates WebGPU/WASM, Canvas, and ONNX execution from MV3 Service Worker (Phase 9 §1-17) |
| 55 | 2026-09-14 17:32 | Hardening | Fix offscreen handshake race condition: established bidirectional ping/ack handshake between SW and offscreen document (Blocker #5) |
| 56 | 2026-09-14 17:54 | Hardening | Fix message routing: route `OFFSCREEN_READY` before envelope validation to avoid dropping un-enveloped initialization messages (Blocker #6) |
| 57 | 2026-09-14 18:06 | Hardening | Fix SW wake-up race: buffer `OFFSCREEN_READY` notifications so late-arriving listeners never miss readiness signals (Blocker #7) |
| 58 | 2026-09-14 18:29 | Hardening | Fix backend selection propagation: pass `requestedBackend` directly into `loadProductionModels` (Blocker #8) |
| 59 | 2026-09-14 18:48 | Hardening | Fix smoke test UI: resolve contract mismatch between test HTML and JS controller causing blank test status |
| 60 | 2026-09-14 19:06 | Hardening | Fix smoke test routing: route `SMOKE_OFFSCREEN_TEST` prior to envelope validator (Blocker #9) |
| 61 | 2026-09-14 19:25 | Evaluation | 30-run SIH benchmark evaluation: validated statistical stability, zero memory leaks, and sub-100ms perception latencies |
| 62 | 2026-09-14 23:24 | Hardening | Fix smoke test timeout: reuse production offscreen document initialization path in S2 smoke test (Blocker #10) |
| 63 | 2026-09-14 23:35 | Hardening | Fix timing instrumentation: resolve full `InferenceResult` with real wall-clock `transferDecodeMs`, `inferenceMs`, and `totalMs` (17 tests) |
| 64 | 2026-09-18 19:59 | Remediation | **P0-B**: Fix node identity mismatch between harvester and executor — harvester builds authoritative single-pass `nodeId -> HTMLElement` map; executor consumes exact references via `setNodeRegistry` (8 tests) |
| 65 | 2026-09-19 17:43 | Remediation | **P0-A**: Confirmation enforcement for high-risk actions (payment, auth, deletion) — 60s fail-closed timeout, pending action registry, popup approval modal; unapproved actions execute ZERO times (18 tests) |
| 66 | 2026-09-19 18:54 | Remediation | **P1-E**: Trusted message sender authentication — validate Chrome `MessageSender` (`sender.id`, `sender.url`, `sender.tab`) instead of untrusted payload claims; content script cannot authorize high-risk actions (16 tests) |
| 67 | 2026-09-19 19:07 | Remediation | **P1-E**: Close offscreen / USER_TASK / SESSION_CONTROL sender gaps — complete sender authorization matrix enforced across all extension entry points (11 tests, 27 total) |
| 68 | 2026-09-19 19:53 | Remediation | **P1-C**: Target freshness & stale-plan prevention — `TargetFingerprint` binding (role, name, ancestry, bbox, frameId, documentGeneration); `checkActionFreshness` fail-closed pre-execution gate (29 tests) |
| 69 | 2026-09-19 20:24 | Remediation | **P1-C CORRECTION**: Close execution-path gap — added live target verification (`VERIFY_TARGET`, `queryTargetCurrentState`) to query current DOM target state immediately before coordinator dispatch (12 tests) |
| 70 | 2026-09-20 00:16 | Remediation | **P1-C FINAL**: Shared DOM ancestry consistency & execution-boundary defense — exported canonical `getAncestorTags`, `computeAccessibleName`, `inferRole` from harvester for consistent fingerprinting + content-side execution TOCTOU check (17 tests) |
| 71 | 2026-09-20 00:41 | Remediation | **P1-C MICRO-CORRECTION**: True execution-boundary TOCTOU inside each action handler immediately before DOM mutation (`click`, `type_text`, `select`, `focus`) + fail-closed on missing fingerprint + `'toctou_rejected'` protocol outcome (20 tests) |
| 72 | 2026-09-20 10:52 | Remediation | **P1-C MICRO-FIX**: Two-phase deferred vault redemption for `type_token` — Phase 1 TOCTOU check occurs BEFORE vault token redemption; only upon TOCTOU pass is token redeemed and raw value delivered via `DELIVER_TOKEN_VALUE` (11 tests). Full regression: 465/465 passing |

---

## Phase Status

| Phase | Name | Status |
|-------|------|--------|
| 1 | Extension Shell & Capture | ✅ Complete |
| 2 | Scene Graph & Grounding | ✅ Complete |
| 3 | Visual Perception Pipeline | ✅ Complete |
| 4 | Privacy & Redaction | ✅ Complete |
| 5 | Verifier & Egress | ✅ Complete |
| 6 | Planner & Execution | ✅ Complete |
| 7 | Demo, Attacks & Polish | ✅ Complete |
| 8 | Planner Server, Eval & Presentation | ✅ Complete |
| 9 | Offscreen Document ONNX Runtime (WebGPU/WASM) | ✅ Complete (Blockers #1-#10 resolved, zero MV3 SW runtime violations) |
| 10 | Evaluation, Hardening & 30-Run Benchmark | ✅ Complete (100% PII recall, statistical stability across 30 runs) |
| Remediation | Security Invariants: P0-A, P0-B, P1-E, P1-C | ✅ Complete (465/465 regression green, zero leaks, fail-closed execution) |

---

## Package Map (8 packages + 3 apps)

| Package | Purpose | Files | Lines | Key Contract |
|---------|---------|-------|-------|--------------|
| `protocol-v2` | Typed protocol, Zod schemas, message envelopes, TargetFingerprint, TOCTOU outcomes | 8 | ~786 | §2, §8, P1-C |
| `scene-graph` | SceneNode, harvester, authoritative node IDs, hit-test, canonical ancestry | 5 | ~874 | §8, §9, P0-B, P1-C |
| `visual-grounding` | VisualGrounding records, IoU/LCS reconciliation engine | 3 | ~347 | §6, §7, §9 |
| `model-runner` | ONNX wrapper, perception pipeline, metrics collector, offscreen bridge | 11 | ~3,282 | §3, §4, §28 |
| `pii-rules` | Deterministic PII/secret detection (Luhn, Verhoeff, MOD-97, regexes) | 1 | ~418 | §11 |
| `privacy` | Token vault, policy engine, full-envelope sanitizer | 5 | ~841 | §10, §12, §13 |
| `semantic-sensitivity` | Generalization layer, semantic keywords and context pattern matching | 6 | ~973 | §11, §14 |
| `egress-verifier` | Independent verifier, canonical JSON serializer, sealed transport | 3 | ~413 | §15, §16 |
| `planner` | Planner client, action validator, freshness gates, deterministic fallback | 3 | ~416 | §17, §18, §19, P1-C |
| `apps/extension` | Chrome MV3 (SW + Offscreen) & Firefox MV3 extension, popup UI, coordinator | 25 | ~54,400+ | §1, P0-A, P0-B, P1-E, P1-C |
| `apps/demo-page` | Controlled PII test fixture with DOM + canvas-rendered PII entities | - | ~250 | §25 |
| `apps/planner-server` | FastAPI mock & LLM planner backend with JSON constraints | - | ~300 | §17 |

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
| Offscreen Document for ONNX inference | Chrome MV3 SW lacks DOM/Canvas/Image and WebGPU worker support. Offscreen document provides complete WebGPU/WASM environment while adhering strictly to MV3 CSP |
| Handshake protocol & message buffering | SW lifecycle suspension can race offscreen initialization. Pre-envelope routing and notification buffering eliminate handshake races |
| Deterministic backend selection override | Explicit backend forcing (`webgpu`, `wasm`, `cpu`) provides repeatable benchmarking and graceful hardware degradation |
| Authoritative single-pass node registry (P0-B) | Harvester registers DOM elements during initial TreeWalker traversal. Executor binds directly to stored references (`setNodeRegistry`), preventing retargeting and identity drift |
| Fail-closed confirmation for high-risk actions (P0-A) | Financial/auth/destructive actions require explicit user approval via extension UI. Pending actions fail closed on rejection, 60s timeout, or session change |
| Runtime `MessageSender` authentication (P1-E) | Messages are authenticated via platform `MessageSender` (`sender.id`, `sender.url`, `sender.tab`). Content scripts cannot spoof UI, offscreen, or confirmation messages |
| Execution-boundary TOCTOU verification (P1-C) | Target fingerprints are validated immediately before DOM mutation (`click`, `type_text`, `select`, `focus`), closing the window between planning and action |
| Two-phase deferred token redemption (P1-C) | In `type_token`, target TOCTOU validation occurs *before* vault redemption. Token is redeemed and secret delivered via `DELIVER_TOKEN_VALUE` only after the DOM target is verified |

---

## Non-Negotiable Requirement Status

| # | Requirement | Status | Implementation |
|---|-------------|--------|----------------|
| 1 | Semantic visual recognition (not just DOM overlap) | ✅ | `model-runner/pipeline.ts` — classifyTextSemantics() |
| 2 | Real server-side LLM for SIH demo | ✅ | `planner/planner-client.ts` — ServerPlannerAdapter |
| 3 | No raw screenshots to planner | ✅ | Capture stays in memory only, never serialized to network |
| 4 | redactions[] in every planner request | ✅ | `privacy/sanitizer.ts` always produces redactions[] |
| 5 | Independent egress verification of exact bytes | ✅ | `egress-verifier/verifier.ts` — re-scans ALL outgoing strings |
| 6 | Local capability redemption only | ✅ | `privacy/token-vault.ts` — 13-step binding check |
| 7 | Typed actions, no eval/JS/selectors | ✅ | `protocol-v2/action.ts` — closed union of safe actions |
| 8 | Re-observe after every action | ✅ | Coordinator invalidates cache on action completion |
| 9 | Chrome primary, Firefox smoke-only | ✅ | Separate manifests, IIFE fallback for Firefox |
| 10 | Fail-closed on ambiguity | ✅ | `privacy/policy.ts` — OMIT on high ambiguity |
| 11 | No unsupported claims (zero leakage) | ✅ | Never claimed anywhere in documentation or code |
| 12 | Deterministic planner is fallback only | ✅ | Flagged `isDeterministic=true`, separate from server adapter |
| 13 | **High-Risk Confirmation Enforcement (P0-A)** | ✅ | Coordinator `requestConfirmation` with 60s fail-closed timeout and trusted popup approval dialog |
| 14 | **Authoritative Node Identity (P0-B)** | ✅ | Single-pass harvester `nodeRegistry` mapping, zero selector re-targeting |
| 15 | **Trusted Sender Authentication (P1-E)** | ✅ | Coordinator enforces Chrome platform `MessageSender` verification across all entry points |
| 16 | **Execution-Boundary TOCTOU Verification (P1-C)** | ✅ | Content-side `verifyTargetBeforeExecution` immediately preceding DOM mutation; missing/mismatched fingerprint = `toctou_rejected` |
| 17 | **Deferred Token Redemption (P1-C Micro-Fix)** | ✅ | Content TOCTOU validation precedes `vault.redeem()`; secrets delivered via two-phase `DELIVER_TOKEN_VALUE` protocol |

---

## Verification & Test Suite Summary

Total Automated Regression: **465 / 465 Passing (100% Green)** across 22 suites:

- `test-type-token-redemption-order.mts`: 11 passed, 0 failed
- `test-freshness-toctou-boundary.mts`: 20 passed, 0 failed
- `test-freshness-dom-consistency.mts`: 17 passed, 0 failed
- `test-freshness-execution-path.mts`: 12 passed, 0 failed
- `test-freshness.mts`: 29 passed, 0 failed
- `test-confirmation-enforcement.mts`: 18 passed, 0 failed
- `test-node-identity.mts`: 8 passed, 0 failed
- `test-sender-authentication.mts`: 27 passed, 0 failed
- `test-security.mjs`: 38 passed, 0 failed
- `test-attacks.mts`: 16 passed, 0 failed
- `test-offscreen-routing.mts`: 22 passed, 0 failed
- `test-offscreen-ready-race.mts`: 27 passed, 0 failed
- `test-offscreen-backend.mts`: 16 passed, 0 failed
- `test-backend-selection.mts`: 26 passed, 0 failed
- `test-offscreen-trust-boundary.mts`: 29 passed, 0 failed
- `test-tile-change-detection.mts`: 14 passed, 0 failed
- `test-runtime-readiness.mts`: 20 passed, 0 failed
- `test-smoke-init.mts`: 21 passed, 0 failed
- `test-smoke-routing.mts`: 25 passed, 0 failed
- `test-smoke-timing.mts`: 17 passed, 0 failed
- `test-perception-e2e.mts`: 19 passed, 0 failed
- `test-e2e-demo.mts`: E13 egress verifier approves sanitized payload

**Build & Audit Status:**
- Chrome MV3 build: **Clean**
- Firefox MV3 build: **Clean**
- npm audit: **0 vulnerabilities** (patched esbuild)
