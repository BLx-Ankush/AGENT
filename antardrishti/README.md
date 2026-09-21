<p align="center">
  <img src=".github/banner.jpg" alt="ANTARDRISHTI — Privacy Control Plane for Browser Agents" width="100%"/>
</p>

<p align="center">
  <strong>Browser-native privacy control plane for hybrid browser agents</strong>
</p>

<p align="center">
  <a href="#architecture"><img src="https://img.shields.io/badge/architecture-monorepo-blue?style=flat-square" alt="Monorepo"></a>
  <a href="#security-hardening"><img src="https://img.shields.io/badge/security_layers-10-brightgreen?style=flat-square" alt="Security Layers"></a>
  <a href="#test-suite"><img src="https://img.shields.io/badge/tests-659_passing-success?style=flat-square" alt="Tests"></a>
  <a href="#on-device-ml"><img src="https://img.shields.io/badge/ML_models-4_ONNX-orange?style=flat-square" alt="Models"></a>
  <a href="#targets"><img src="https://img.shields.io/badge/targets-Chrome_%7C_Firefox-yellow?style=flat-square" alt="Targets"></a>
  <a href="https://sih.gov.in"><img src="https://img.shields.io/badge/SIH_2026-Finals-red?style=flat-square" alt="SIH 2026"></a>
</p>

<p align="center">
  <em>SIH Problem Statement ID: <strong>SIH26171</strong></em>
</p>

---

## 🔍 What is Antardrishti?

**Antardrishti** (अंतर्दृष्टि — "inner sight") is a browser-native **privacy control plane** that sits between an AI browser agent and the web page it operates on. It ensures that when an AI agent browses the web on behalf of a user, it **never leaks sensitive data** — passwords, PII, payment info, or biometric data — to external servers.

The system provides:

- 🔒 **Real-time privacy enforcement** — PII is detected, tokenized, and vault-sealed before any data leaves the browser
- 👁️ **On-device multimodal perception** — Face detection, OCR, UI region detection running entirely in-browser via ONNX
- 🛡️ **10-layer security hardening** — Defense-in-depth from confirmation to TOCTOU prevention
- 🎯 **Visual grounding** — Links visual perception to DOM targets while maintaining strict execution authority
- 📦 **Zero-server-dependency privacy** — All privacy decisions happen client-side; the remote planner is untrusted

### The Problem

Browser agents powered by LLMs can see and act on web pages. But **they have unrestricted access to everything on screen** — login credentials, bank accounts, medical records, Aadhaar numbers, faces. Current solutions either:

1. **Trust the agent blindly** — sending raw page data to cloud LLMs
2. **Restrict the agent entirely** — making it useless for real tasks

### Our Solution

Antardrishti is a **transparent privacy layer** that:

1. **Harvests** the DOM into a structured scene graph
2. **Detects** sensitive content using on-device ML (faces, text, payment UIs, identifiers)
3. **Sanitizes** the scene — replacing raw values with opaque `<SENSITIVE_XXXX>` tokens
4. **Verifies** the sanitized payload through an egress verifier before transmission
5. **Enforces** strict execution constraints — the AI can plan, but the browser decides what's executable

The AI sees `<SENSITIVE_FACE_001>` instead of your photo. It sees `<SENSITIVE_AADHAAR_002>` instead of your ID number. **It can still do its job, but it never sees your data.**

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        BROWSER EXTENSION                            │
│                                                                     │
│  ┌───────────────┐   ┌──────────────────┐   ┌───────────────────┐  │
│  │ Content Script │   │  Service Worker   │   │ Offscreen Document│  │
│  │               │   │  (Coordinator)    │   │ (ONNX Inference)  │  │
│  │ • DOM Harvest  │   │                  │   │                   │  │
│  │ • Node Registry│◄─►│ • Session Mgmt   │◄─►│ • Face Detection  │  │
│  │ • Action Exec  │   │ • Pipeline Orch   │   │ • OCR Engine      │  │
│  │ • TOCTOU Check │   │ • Vault + Tokens  │   │ • Text Detection  │  │
│  │ • Role Enforce │   │ • Privacy Sanitize│   │ • UI Region Det.  │  │
│  │               │   │ • Egress Verify   │   │                   │  │
│  └───────────────┘   │ • Plan Validate   │   └───────────────────┘  │
│                      │ • 10-Layer SecHard │                         │
│                      └────────┬──────────┘                         │
│                               │ Sealed Transport                   │
└───────────────────────────────┼─────────────────────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │   Planner Server      │
                    │   (UNTRUSTED)         │
                    │                       │
                    │  • LLM / Deterministic│
                    │  • Receives ONLY      │
                    │    sanitized scene    │
                    │  • Returns action plan│
                    │  • NEVER sees raw PII │
                    └───────────────────────┘
```

### Monorepo Structure

```
antardrishti/
├── apps/
│   ├── extension/           # Chrome/Firefox browser extension (MV3)
│   │   ├── src/
│   │   │   ├── background/  # Service worker + Coordinator orchestration
│   │   │   ├── content/     # DOM harvester + action executor
│   │   │   ├── offscreen/   # ONNX inference document (MV3)
│   │   │   └── ui/          # Extension popup UI
│   │   └── build.mjs        # Multi-target build system
│   ├── demo-page/           # Interactive demo page for evaluation
│   └── planner-server/      # FastAPI planner (Python + LLM adapter)
│
├── packages/
│   ├── protocol-v2/         # Typed protocol schemas + action language
│   ├── scene-graph/         # DOM → SceneNode transformation
│   ├── privacy/             # PII sanitizer + token vault
│   ├── pii-rules/           # PII detection rule engine
│   ├── semantic-sensitivity/ # Semantic sensitivity classification
│   ├── egress-verifier/     # Payload verification before transmission
│   ├── planner/             # Planner client + action validator
│   ├── model-runner/        # ONNX Runtime adapter + ML pipeline
│   └── visual-grounding/    # Visual region ↔ DOM reconciliation
│
├── tests/                   # 26 adversarial test suites (659+ tests)
├── eval/                    # SIH evaluation harness + benchmarks
└── scripts/                 # Build + utility scripts
```

---

## 🧠 On-Device ML Models

All inference runs **entirely in the browser** via ONNX Runtime Web — zero cloud dependency for privacy-critical operations.

| Model | Purpose | Format | Runtime |
|-------|---------|--------|---------|
| **Face Detector** | Detect faces in screenshots to redact biometric data | ONNX | WASM/WebGL |
| **Text Detector** (PaddleOCR) | Locate text regions in page screenshots | ONNX | WASM/WebGL |
| **OCR Recognizer** (PaddleOCR) | Recognize text content for PII detection | ONNX | WASM/WebGL |
| **UI Region Detector** | Identify interactive controls (buttons, inputs, payment forms) | ONNX | WASM/WebGL |

The **offscreen document** architecture (MV3-compliant) runs inference in a separate context, preventing service worker termination issues.

---

## 🛡️ Security Hardening

Antardrishti implements **10 independent, defense-in-depth security layers**, each with dedicated adversarial test suites:

| Layer | Code | Description | Tests |
|-------|------|-------------|-------|
| **P0-A** | Confirmation Enforcement | High-risk actions require explicit user approval | 18 |
| **P0-B** | Exact Node Identity | `nodeId → HTMLElement` binding — no selector re-targeting | 8 |
| **P1-C** | Freshness / TOCTOU | Stale observation prevention + execution-boundary TOCTOU defense | 89 |
| **P1-D** | Role Mismatch | Live DOM role must match harvested role — fail closed | 24 |
| **P1-E** | Sender Authentication | Message origin validation across all extension channels | 27 |
| **P1-F** | Session/Tab Binding | Actions bound to session+tab — stale pipeline invalidation | 55 |
| **P1-G** | Observation Invalidation | State-changing actions invalidate prior observations — persistent | 39 |
| **P1-H** | Visual Execution Authority | Visual perception ≠ execution authority — explicit boundary | 35 |
| **P1-I** | Planner Response Trust | Plan expiry, observation binding, semantic validation gate | 41 |
| **Egress** | Egress Verifier | Final payload verification before any network transmission | 38+ |

### Key Security Invariants

> **"Visual perception can discover and describe interface elements, but visual evidence alone never authorizes browser execution."** — P1-H

> **"Planner output is untrusted proposal data. Schema validity does not imply execution validity."** — P1-I

> **"A user approval MUST NOT substitute for freshness validation."** — P1-C

> **"An action observed, planned, authorized, confirmed, or capability-bound for Tab A MUST NEVER execute against Tab B."** — P1-F

---

## 🧪 Test Suite

The project includes **659+ passing tests** across **26 adversarial test suites**, covering every security boundary:

```
✅ P1-C type_token Redemption Order:       11 passed
✅ P1-C Execution-Boundary TOCTOU:         20 passed
✅ P1-C DOM Consistency + TOCTOU:          17 passed
✅ P1-C Execution-Path Freshness:          12 passed
✅ P1-C Freshness Prevention:              29 passed
✅ P0-A Confirmation Enforcement:          18 passed
✅ P0-B Node Identity:                      8 passed
✅ P1-E Sender Authentication:             27 passed
🔒 Security Tests:                         38 passed
⚔️  Attack Tests:                           16 passed
   Routing / Race / Backend / Trust:       120 passed
   Smoke Tests (Init/Routing/Timing):       63 passed
✅ E2E Perception:                          19 passed
🔒 P1-D Role Mismatch:                     24 passed
🔒 P1-F Tab Binding + Stale Pipeline:      55 passed
🔒 P1-G Observation Invalidation:          39 passed
🔒 P1-H Visual Execution Authority:        35 passed
🔒 P1-I Planner Response Trust:            41 passed
   Egress Verification:                     ✅ passed
─────────────────────────────────────────────────────
TOTAL:                                    659 passed, 0 failed
```

### Running Tests

```bash
# Run all tests
npm test

# Run specific security suite
npx tsx tests/test-visual-authority.mts
npx tsx tests/test-planner-response.mts
npx tsx tests/test-tab-binding.mts

# Run full regression
npx tsx tests/test-security.mjs
npx tsx eval/test-attacks.mts
npx tsx eval/test-e2e-demo.mts
```

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** ≥ 20.0.0
- **Python** ≥ 3.10 (for planner server)
- **Chrome** or **Firefox** (latest)

### Installation

```bash
# Clone the repository
git clone https://github.com/BLx-Ankush/AGENT.git
cd AGENT/antardrishti

# Install dependencies
npm install

# Build the extension (Chrome)
npm run build

# Build for Firefox
node apps/extension/build.mjs --target=firefox
```

### Loading the Extension

**Chrome:**
1. Navigate to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select `apps/extension/dist/chrome`

**Firefox:**
1. Navigate to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `apps/extension/dist/firefox/manifest.json`

### Starting the Planner Server

```bash
cd apps/planner-server

# Install Python dependencies
pip install -r requirements.txt

# Start with deterministic planner (development)
python server.py

# Start with LLM adapter (production)
python server.py --adapter=llm --model=llama3.1
```

---

## 📋 Protocol v2

Antardrishti uses a typed, strict protocol for all agent-planner communication:

### Action Language

| Action | Description | Target Required |
|--------|-------------|-----------------|
| `click` | Click a DOM element | ✅ |
| `focus` | Focus a DOM element | ✅ |
| `type_text` | Type plaintext into a field | ✅ |
| `type_token` | Type a vault-sealed sensitive value | ✅ |
| `select` | Select an option from a dropdown | ✅ |
| `scroll` | Scroll the viewport or a container | ❌ |
| `wait` | Wait for a specified duration (≤30s) | ❌ |
| `request_observation` | Request a fresh observation | ❌ |
| `finish` | Complete the task | ❌ |

### Privacy Tokens

Sensitive values are replaced with opaque tokens:

```
Raw: "1234-5678-9012-3456"  →  Token: "<SENSITIVE_CARD_001>"
Raw: "john@example.com"     →  Token: "<SENSITIVE_EMAIL_002>"
Raw: [Face Region]          →  Token: "<SENSITIVE_FACE_003>"
```

The planner **never sees raw values**. Only vault-sealed tokens cross the trust boundary.

---

## 🏛️ Privacy Pipeline

```
      Page Load
         │
    ┌────▼────┐
    │ Capture  │ Screenshot + DOM snapshot
    └────┬────┘
         │
    ┌────▼────┐
    │ Harvest  │ DOM → SceneNode[] with stable IDs
    └────┬────┘
         │
    ┌────▼────────┐
    │ Perception   │ ONNX face/OCR/text/region detection
    └────┬────────┘
         │
    ┌────▼────────┐
    │ Sanitize     │ PII → <SENSITIVE_xxx> tokens
    └────┬────────┘    Values sealed in local vault
         │
    ┌────▼────────┐
    │ Egress Verify│ Validates no raw PII leaks
    └────┬────────┘
         │
    ┌────▼────────┐
    │ Plan         │ LLM receives ONLY sanitized data
    └────┬────────┘
         │
    ┌────▼─────────────┐
    │ Validate + Confirm│ P1-I gate → P0-A confirm → P1-C fresh
    └────┬─────────────┘
         │
    ┌────▼────┐
    │ Execute  │ Against P0-B exact DOM node
    └─────────┘
```

---

## 📊 Evaluation Results

Benchmarked on the **SIH Final Evaluation Harness** across 30 independent runs:

| Metric | Result |
|--------|--------|
| PII Recall | **100%** — all PII instances detected |
| PII Precision | **95%+** — minimal false positives |
| Face Detection | ✅ Functional (ONNX) |
| OCR Pipeline | ✅ Functional (PaddleOCR ONNX) |
| UI Region Detection | ✅ Functional (ONNX) |
| Security Tests | **659/659** (0 failures) |
| Chrome Build | ✅ Clean |
| Firefox Build | ✅ Clean |
| npm Audit | **0 vulnerabilities** |

---

## 🗂️ What Has Been Completed

### ✅ Core Infrastructure (Phases 1-8)
- [x] DOM harvester with stable node identity system
- [x] Scene graph transformation (`SceneNode` → `PlannerSceneNode`)
- [x] PII rule engine with 12+ sensitivity categories
- [x] Token vault with secure lifecycle management
- [x] Privacy sanitizer with redaction declarations
- [x] Egress verifier for payload integrity
- [x] Protocol v2 with typed action language and Zod schemas
- [x] Planner client with server + deterministic adapters
- [x] Multi-target build system (Chrome MV3 / Firefox)

### ✅ On-Device ML (Phase 9)
- [x] ONNX Runtime Web integration (WASM + WebGL backends)
- [x] Offscreen document architecture for MV3 inference
- [x] Face detection model (real-time, in-browser)
- [x] PaddleOCR text detection + recognition pipeline
- [x] UI region detector for interactive controls
- [x] Visual grounding and DOM ↔ visual reconciliation
- [x] Model manifest system for reproducible deployments
- [x] Backend selection override (WASM / WebGL / auto)

### ✅ Security Hardening (P0-A through P1-I)
- [x] **P0-A**: User confirmation for high-risk actions (submit, payment, delete)
- [x] **P0-B**: Exact `nodeId → HTMLElement` identity through P0-B registry
- [x] **P1-C**: Freshness/TOCTOU prevention with execution-boundary verification
- [x] **P1-C**: Two-phase type_token redemption (TOCTOU before vault)
- [x] **P1-D**: Role mismatch detection with fail-closed enforcement
- [x] **P1-E**: Sender authentication across all message channels
- [x] **P1-F**: Session/tab binding with stale-pipeline invalidation
- [x] **P1-G**: Permanent observation invalidation with persistence across SW restart
- [x] **P1-H**: Visual execution authority boundary (vision ≠ execution)
- [x] **P1-I**: Planner response trust boundary (expiry, observation binding, shape)

### ✅ Evaluation & Testing
- [x] 659+ adversarial tests across 26 test suites
- [x] SIH evaluation harness with 30-run benchmark
- [x] Attack simulation suite (16 adversarial scenarios)
- [x] E2E perception pipeline tests
- [x] Demo page for live evaluation

### ✅ Planner Server
- [x] FastAPI server with CORS, health check, metrics endpoints
- [x] Deterministic planner (dev/test fallback)
- [x] LLM adapter integration (Ollama/OpenAI-compatible)
- [x] Protocol v2 Pydantic models for request/response validation

---

## 🚧 What Remains (Roadmap)

### 🔲 P2 — Advanced Security (Future)
- [ ] **P2-A**: Cross-origin frame isolation — iframe-based PII boundaries
- [ ] **P2-B**: Navigation-aware observation — detect and handle SPA route changes
- [ ] **P2-C**: Multi-tab coordination — session state across parallel tabs
- [ ] **P2-D**: Service worker cold-start attestation — verify SW integrity on restart
- [ ] **P2-E**: Content Security Policy enforcement — CSP-aware action validation

### 🔲 Perception Improvements
- [ ] **Neural NER**: On-device Named Entity Recognition for PII beyond regex
- [ ] **Document layout analysis**: Structured document understanding
- [ ] **Video/canvas content**: Real-time privacy for dynamic visual content
- [ ] **Multi-language OCR**: Extended language support beyond English/ASCII

### 🔲 Production Readiness
- [ ] **Chrome Web Store packaging**: Production CRX with signing
- [ ] **Firefox AMO submission**: Production XPI with review-ready documentation
- [ ] **Performance profiling**: Memory/CPU optimization for low-end devices
- [ ] **Telemetry dashboard**: Privacy-respecting usage analytics
- [ ] **User settings panel**: Configurable sensitivity thresholds
- [ ] **Accessibility audit**: WCAG compliance for extension UI

### 🔲 Research Extensions
- [ ] **Federated learning**: Privacy-preserving model fine-tuning
- [ ] **Differential privacy**: Formal privacy guarantees for aggregated data
- [ ] **Formal verification**: Mechanized proofs for security invariants
- [ ] **Adversarial robustness**: Defense against evasion attacks on ML models

---

## 🤝 Contributing

This project was built for the **Smart India Hackathon 2026 Finals** (Problem Statement: SIH26171).

### Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run security tests
npx tsx tests/test-security.mjs

# Run full regression
npx tsx eval/test-e2e-demo.mts
```

### Code Standards

- **TypeScript** strict mode with no implicit any
- **Zod schemas** with `.strict()` for all protocol boundaries
- **Defense-in-depth**: Every security boundary has at least 2 independent checks
- **Fail-closed**: All security checks default to rejection on error
- **No selector-based targeting**: Actions target exact DOM references, never CSS selectors

---

## 📄 License

This project is developed as part of the **Smart India Hackathon 2026** initiative by the Government of India.

---

<p align="center">
  <strong>Built with 🔒 for the Smart India Hackathon 2026 Finals</strong>
  <br/>
  <em>Problem Statement: SIH26171 — Privacy Control Plane for Hybrid Browser Agents</em>
</p>
