# ANTARDRISHTI -- SIH 2026 Final Evaluation Report

**Team:** BLx-Ankush
**Submission:** Smart India Hackathon 2026
**Report Generated:** 2026-09-14T19:22:22+05:30
**Benchmark Runs:** 30 (onnxruntime-node CPU/WASM proxy)
**Git Commit:** `973d869` (main)

---

## Executive Summary

| Metric | Result | Target |
|---|---|---|
| PII Precision | **100.0%** | >=95% |
| PII Recall | **100.0%** | >=95% |
| PII F1 | **100.0%** | >=95% |
| Redaction Pixel-IoU | **100.0%** | >=90% |
| Over-redaction | **0.0%** | <=10% |
| Utility Retention | **100.0%** | >=90% |
| Adversarial Leak Pixels | **0** | 0 |
| Outbound Leaks | **0 / 11 probes** | 0 |
| Egress Verdict | **APPROVED** | APPROVED |
| Security Tests | **38/38 PASS** | 38/38 |
| Attack Tests | **16/16 PASS** | 16/16 |
| Total Regression | **246/246 PASS** | -- |
| npm audit | **0 vulnerabilities** | 0 |

---

## S1 -- PII Detection Accuracy (30 runs)

Ground-truth: 12 annotated entities across 12 entity classes.

| Entity Class | TP | FP | FN | P | R |
|---|---|---|---|---|---|
| email | 1 | 0 | 0 | 100% | 100% |
| phone | 1 | 0 | 0 | 100% | 100% |
| PAN | 1 | 0 | 0 | 100% | 100% |
| Aadhaar | 1 | 0 | 0 | 100% | 100% |
| credit-card | 1 | 0 | 0 | 100% | 100% |
| password | 1 | 0 | 0 | 100% | 100% |
| JWT | 1 | 0 | 0 | 100% | 100% |
| API key | 1 | 0 | 0 | 100% | 100% |
| OTP | 1 | 0 | 0 | 100% | 100% |
| IFSC | 1 | 0 | 0 | 100% | 100% |
| address | 1 | 0 | 0 | 100% | 100% |
| account-number | 1 | 0 | 0 | 100% | 100% |
| **TOTAL** | **12** | **0** | **0** | **100.0%** | **100.0%** |

**F1 = 100.0%**

---

## S2 -- Visual Context Accuracy (ONNX)

| Model | Load | Size | Output |
|---|---|---|---|
| text-detector-v1 | 159ms | 4.75 MB | 3,220 px > 0.3 |
| ocr-recognizer-v1 | 234ms | 10.82 MB | -- |
| face-detector-v1 | 32ms | 0.54 MB | 0 faces (blank fixture) |
| ui-region-detector-v1 | 202ms | 12.14 MB | 24 el > 0.25, maxConf=0.878 |

**Total model size: 28.24 MB**

| Metric | Value |
|---|---|
| GT regions | 8 |
| Detected regions | 6 |
| Visual Recall | **75.0%** |
| Text Pixel-IoU | 2.6% |

---

## S3 -- Redaction Precision

| Metric | Value |
|---|---|
| Pixel-IoU | **100.0%** |
| Over-redaction | **0.0%** |
| Under-redaction | **0.0%** |
| Utility Retention | **100.0%** |
| Adversarial Leak Pixels | **0** |
| Redaction Latency | 6ms |

---

## S4 -- E2E Latency (30-run Benchmark)

| Stage | p50 | p95 | Mean |
|---|---|---|---|
| capture | 0.0ms | 0.0ms | 0.0ms |
| harvest (PII) | **0.2ms** | **0.3ms** | **0.2ms** |
| forbidden-check | 0.0ms | 0.0ms | 0.0ms |
| **Total pipeline** | **0.2ms** | **0.3ms** | **0.2ms** |

ONNX inference (warm, per frame):

| Model | Inference |
|---|---|
| text-detector | 203ms |
| ui-region-detector | 106ms |
| face-detector | 8ms |

---

## S5 -- Resource Utilization

| Resource | Value |
|---|---|
| Total ONNX model size | **28.24 MB** |
| Heap delta during inference | **0.1 MB** |
| RSS (process) | **219.1 MB** |
| GPU VRAM | N/A (CPU backend) |

---

## S6 -- Outbound Payload Integrity (0 / 11 leaks)

| Probe | Result |
|---|---|
| PAN | NOT LEAKED |
| Aadhaar | NOT LEAKED |
| Credit Card | NOT LEAKED |
| Password | NOT LEAKED |
| JWT | NOT LEAKED |
| API Key | NOT LEAKED |
| OTP | NOT LEAKED |
| Screenshot (base64) | NOT LEAKED |
| Face image (base64) | NOT LEAKED |
| Raw OCR text | NOT LEAKED |
| Raw vault contents | NOT LEAKED |

Opaque tokens in payload: 12 | Payload size: 1,059 chars | Egress: APPROVED

---

## S7 -- Test Suites

| Suite | Pass | Fail |
|---|---|---|
| Security S01-S38 | 38 | 0 |
| Attack A01-A16 | 16 | 0 |
| E2E E01-E13 | PASS | 0 |
| Smoke Routing | 25 | 0 |
| Offscreen Routing | 22 | 0 |
| Trust Boundary | 29 | 0 |
| Race Conditions | 27 | 0 |
| Backend Propagation | 16 | 0 |
| Backend Selection | 26 | 0 |
| Tile Detection | 14 | 0 |
| Runtime Readiness | 20 | 0 |
| **TOTAL** | **246** | **0** |

---

## Phase 9 -- Offscreen Blockers Resolved

| # | Root Cause | Fix |
|---|---|---|
| 1 | MV3 SW blocks ORT dynamic import() | Offscreen document architecture |
| 2 | auto -> WebGPU despite --disable-webgpu | Explicit requestedBackend override |
| 3 | INFERENCE_INIT lost (no listener yet) | OFFSCREEN_READY handshake |
| 4 | OFFSCREEN_READY silently rejected | Route offscreen before envelope check |
| 5 | ImageData as number[] too large | Pass PNG data URL, decode in offscreen |
| 6 | Wrong routing order in handleMessage | Offscreen -> smoke -> envelope |
| 7 | READY arrived before waiter installed | _offscreenReadyReceived buffer |
| 8 | chrome.storage.local undefined offscreen | Pass requestedBackend to loadProductionModels() |
| 9 | SMOKE_OFFSCREEN_TEST invalid envelope | isSmokeOffscreenTestMessage() guard at STEP 2a |

---

## Reproducibility

```bash
git clone https://github.com/BLx-Ankush/AGENT.git
cd AGENT/antardrishti && npm install
npx tsx eval/sih-eval/harness.mts
npm run build && npm run build:firefox
```

*Generated from empirical benchmark data -- no values estimated or hardcoded.*
