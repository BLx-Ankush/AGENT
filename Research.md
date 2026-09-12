# PS SIH26171 — Research Dossier

**Problem statement:** SIH26171 — *On-device Visual Perception for Light-weight Browser Agents*
**Organisation:** Indian Space Research Organisation (ISRO), Department of Space
**Category / Theme:** Software / Smart Automation
**Portal idea-submission deadline:** 30 September 2026 · **Binding internal date: 16 September 2026**

**Published evaluation weights (from the PS itself):**

| # | Metric | Weight |
|---|--------|--------|
| 1 | Accuracy of visual context from screen | 25% |
| 2 | Recall & precision for detection of sensitive/PII data | 20% |
| 3 | Precision of redaction | 20% |
| 4 | Client-side resource utilisation | 20% |
| 5 | Overall end-to-end latency of the provided task | 15% |

**Dataset note (from the PS):** "Any open-source data can be used. Use cases for evaluation will be
provided during the finale." → the system must generalise to unseen sites. Nothing may be hard-coded
to a demo page.

**Purpose of this file.** Establish, from primary sources, what already exists in this space, so the
architecture we propose has a core that cannot be dismissed with *"this already exists"* or *"it's just
a wrapper."* Every claim here carries its source. Findings are added as research progresses.

**Status legend:** ✅ verified from a primary source · 🟡 verified from a secondary source · ❓ not yet checked

---

## Contents

1. Prior art — browser & GUI agents (what already exists)
2. Prior art — on-device screen understanding
3. Prior art — privacy-preserving delegation to a remote model
4. Prior art — PII / sensitive-region detection
5. Feasibility — in-browser model runtimes and measured numbers
6. Feasibility — browser extension capture APIs (Chrome + Firefox)
7. Benchmarks we can score against
8. The gap analysis — what nobody has built
9. Proposed architecture *(v1 — superseded by §15; read §13 first)*
10. Judge-attack table — every hard question and its answer
11. Open risks
12. Sources
13. **Verification pass on the external critique — what checked out and what did not**
14. **Corrected prior-art position (supersedes the "all text-only" framing in §3 and the gap table in §8)**
15. **v2 architecture — the version to pitch**
16. **Benchmark and metric plan, v2**
17. **What the deck must change**
18. **Citation and artifact verification protocol — incl. the retraction, Veil-tiny and Safe-Screen**
19. **Amendments A1–A8 to §15 and §16 (third pass)**
20. **Claim-by-claim prior art, per mechanism M1–M5 — the novelty slide's evidence**
21. **Amended deck plan (supersedes the affected rows of §17)**

> ⚠️ **Reading order as of 2026-09-05 (third research pass).** §1–§12 were written before the 2026
> visual-PII literature was found. Three of their conclusions are now wrong: §3's claim that all
> privacy-preserving delegation work is text-only, §8's four-property gap table, and §9's assumption
> that an extension can read the browser's accessibility tree. **§13–§20 are authoritative where they
> conflict with §1–§12.** Do not pitch from §8 or §9.
>
> ⚠️ **§13.2 has been RETRACTED.** It declared Veil-tiny and Safe-Screen fabricated. Both are real. The
> corrected entries, and the verification protocol that prevents a repeat, are in **§18**. Where §15 or
> §16 conflict with **§19**, §19 wins. The novelty claim to pitch is the one at the end of **§20**, and
> no other.

---

## 1. Prior art — browser & GUI agents

The honest position: **agentic browsers are a crowded, well-funded space.** Anything we pitch as "an AI
that operates your browser" is already shipping. What is *not* shipping is the privacy property. Keep
that distinction sharp — it is the whole defence.

| System | What it is | Where inference happens | Privacy treatment of screen data |
|---|---|---|---|
| OpenAI Operator / ChatGPT agent mode | Hosted agent that drives a remote browser | Cloud | Raw screenshots go to the cloud |
| Anthropic Computer Use / Claude in Chrome | Model sees screenshots, emits clicks/keystrokes | Cloud | Raw screenshots go to the cloud |
| Google Project Mariner / Gemini in Chrome | Agent embedded in Chrome | Cloud | Raw page context to cloud |
| Perplexity Comet, Opera Neon, Dia | Agentic browsers | Cloud | Raw page context to cloud |
| Browser Use / Skyvern / Nanobrowser | OSS frameworks; DOM+screenshot → LLM | Configurable, usually cloud | None by design |
| Microsoft OmniParser V2 | Screen → structured elements, no LLM needed for parsing | Local *desktop* (Python/CUDA), not browser | See §2 — partial, and not redaction |

**Consequence for our pitch:** we must NOT claim "first browser agent." The claim is narrower and
survivable: *the perception and privacy layer runs on the client, and the remote model is structurally
incapable of seeing raw user pixels.* Every system in the table above fails that test.

**Source note:** the specific capability claims for commercial agentic browsers change frequently and
were not re-verified line-by-line for this table; treat the "Cloud" column as the well-documented
general design of hosted agents, and verify any single vendor claim before putting it on a slide.

## 2. Prior art — on-device / pure-vision screen understanding

**Microsoft OmniParser (v1 arXiv:2408.00203, v2 Feb 2025)** is the state of the art for turning a UI
screenshot into structured elements, and it is the strongest "isn't this already done?" challenge to
metric #1 (visual context accuracy). Verified facts:

- It parses UI screenshots into structured, actionable elements so that a general LLM can act on them;
  it pairs a **fine-tuned YOLOv8 interactable-icon detector with an icon-functional-caption model** ✅
- V2 was trained on more interaction-detection and icon-caption data, and **cut latency ~60% vs V1** by
  shrinking the caption model's image size ✅
- **OmniParser + GPT-4o reaches 39.6 average accuracy on ScreenSpot Pro** — state of the art at
  announcement, which also tells us high-resolution GUI grounding is *far from solved* ✅
- On privacy, Microsoft's own note is narrow: the caption model was trained with Responsible AI data so
  it **avoids inferring sensitive attributes (race, religion, etc.) of people appearing in icon
  images** ✅ — that is *attribute-inference hygiene*, NOT redaction, and nothing in OmniParser prevents
  the screenshot itself from being transmitted.

**Why this does not pre-empt us:** OmniParser is a desktop/server Python module with CUDA-class
requirements; it is not an in-browser client, it performs no PII detection, no redaction, and no
network gating. It is a *component we can be compared to*, and arguably a baseline we should cite and
measure against rather than pretend does not exist.

## 3. Prior art — privacy-preserving delegation to a remote model

**This is the most important finding in the dossier.** A real research line exists on "sanitise locally,
then delegate to a strong remote model." It is mature, it is cited, and **it is entirely text-based.**
Nobody in it operates on pixels or on a rendered screen.

| Work | Venue / ID | What it does | Modality |
|---|---|---|---|
| **Casper** — Prompt Sanitization for Protecting User Privacy in Web-Based LLMs | arXiv:2408.07004, IEEE CSCloud 2025 (DOI 10.1109/CSCloud66326.2025.00027) | **Browser extension**, runs entirely on device, strips PII + sensitive topics from the user's prompt before it reaches a web LLM. Three layers: rule-based filter → ML named-entity recognizer → **browser-based local LLM topic identifier**. On 4,000 synthesized prompts: **98.5% PII filtering, 89.9% sensitive-topic accuracy** | Typed text |
| **PAPILLON** — Privacy Preservation from Internet-based and Local Language Model Ensembles | arXiv:2410.17127 | Defines the task **"Privacy-Conscious Delegation"**: chain a trusted local model with an untrusted API model. Best pipeline keeps response quality for **85.5%** of queries while holding leakage to **7.5%** | Text |
| **AirGapAgent** — Protecting Privacy-Conscious Conversational Agents | arXiv:2405.05175 | Contextual-integrity **context minimisation**: restrict the agent to only the data the task needs. Reports **97% protection** against a context-hijacking attack vs 45% for an unprotected agent | Structured user data |
| **ProSan** — The Fire Thief Is Also the Keeper | arXiv:2406.14318 | End-to-end prompt anonymisation balancing privacy against utility | Text |
| **LLM-Redactor** — empirical evaluation of 8 privacy-preserving request techniques | arXiv:2604.12064 | Compares local-only inference, redaction-with-placeholder-restoration, semantic rephrasing, etc. | Text |
| **PrivacyPAD** | arXiv:2510.16054 | RL policy that routes sensitive vs non-sensitive *chunks* to local vs remote, because a static rewriter destroys task-critical information | Text |
| **Beyond Direct Identifiers** | arXiv:2608.09140 | Argues leakage is not only explicit identifiers but **PII-free self-disclosure**; probabilistic risk estimation for delegation | Text |
| **PromptGraph** | arXiv:2607.10709 | Graph-guided span-level sanitisation trading privacy against utility | Text |

**The three things this literature gives us for free — cite them, do not reinvent them:**

1. **"Redaction with placeholder restoration"** is an established, named technique (LLM-Redactor,
   category B). Our `<EMAIL_01>` scheme is not something we invented; saying so *strengthens* us,
   because we can then point at the part that is new.
2. **PrivacyPAD's finding is a warning aimed straight at us:** a static redactor *fails by redacting
   task-critical information*. So "redact more" is not a winning strategy — over-redaction is a real,
   published failure mode. This is the reason our design needs a utility metric alongside the privacy
   metric, and it is the answer to a judge asking "why not just black out everything?"
3. **AirGapAgent's framing — context minimisation under contextual integrity** — is the right vocabulary
   for why we send the *minimum* context rather than a full screenshot.

**The gap, stated precisely:** every system above sanitises **text the user authored**. PS171 requires
sanitising **the rendered screen the user did not author** — pixels containing faces, ID cards, text
baked into images, canvas and PDF content, and cross-origin frames. Casper is the closest match and it
is still a *prompt* sanitiser inside a chat page, with no perception of the screen and no action loop
back into the page. **A visual-context sanitiser with a closed action loop is genuinely unclaimed
territory.** That sentence is our novelty claim, and it is defensible because it is narrow.

## 4. Prior art — PII and sensitive-region detection

Split this into three sub-questions, because a judge will attack each one separately.

### 4.1 Text-side PII detection is a solved, commodity component — do not claim it

On-device PII NER is available off the shelf and runs in a browser today. Claiming novelty here would be
the fastest way to lose credibility. Claim *integration*, not invention.

| Component | What it gives us | Status |
|---|---|---|
| **GLiNER** family (zero-shot NER, arbitrary entity labels at inference) with **GLiNER.js** for JavaScript | Named-entity extraction without training a per-label classifier; new PII types by editing a label list, not retraining | ✅ ONNX ports exist on the Hub (`ineersa/gliner-PII-onnx`, `Sovraine/gliner-pii-onnx` derived from `nvidia/gliner-PII`, `gravitee-io/gliner-pii-detection`) |
| **GLiNER2-PII** — arXiv:2605.09973 | 0.3B params, **42 PII entity types**, character-span resolution, multilingual | ✅ |
| **Piiranha** (fine-tune of `microsoft/mdeberta-v3-base`) | Compact multilingual PII token classifier | ✅ |
| **Microsoft Presidio** (`presidio-analyzer`) | The reference open-source PII framework: recognizer registry, regex + checksum validators (cards, SSNs, IBANs), context enhancement | ✅ |

### 4.2 Image-domain PII redaction already exists — and this is the sharpest "already present" attack

**`presidio-image-redactor`** is the one to name before a judge does. Verified from Microsoft's own repo
and PyPI:

- Presidio "provides fast identification and anonymization modules for private entities in text **and
  images**" ✅
- The module is "a Python based module for detecting and redacting PII **text entities** in images" ✅
- Microsoft's own maintainer thread describes it as developed **as beta** during Presidio V2 (January
  2021) and as "a **simple OCR pipeline** which extracts text, parses it, and sends it to the Presidio
  analyzer" ✅
- **DICOM** image redaction was added later (release note: "Adding DICOM image redacting capability to
  presidio-image-redactor module (#960)") ✅
- Presidio's README carries its own honesty disclaimer: because detection is automated, "there is no
  guarantee that Presidio will find all sensitive information" ✅

**How this constrains our claim.** "Redact PII in an image" is *not* new. What Presidio's image redactor
does **not** do, and what PS171 requires: it is server/desktop **Python**, so nothing about it is
client-side or in-browser; it redacts **only OCR-recovered text**, so faces, ID-card photographs,
signatures, QR codes and non-text sensitive regions are out of scope; it has **no model of the UI**, so
it cannot tell a password field from a heading, or a bank balance from a page number; it has **no network
gate**, so it never asserts that the unredacted original stayed local; and it has **no action loop**.

### 4.3 Faces and non-text regions in the browser

- **MediaPipe Face Detector for Web** runs fully in-browser via the MediaPipe Tasks JS API (Google's own
  docs and sample repo) ✅ — so face localisation needs no research, only integration.
- **Caveat worth stating before a judge finds it:** the MediaPipe/BlazeFace model selector is documented
  as `0` = short-range, best for faces **within 2 m of the camera**, `1` = full-range, within 5 m ✅.
  Those models are tuned for *camera* framing, not for a webpage screenshot where faces appear as
  40-pixel avatars and gallery thumbnails. So small-face recall must be measured, not assumed, and a
  general small-object face detector (SCRFD / YOLO-face class, ONNX) is the fallback.

### 4.4 The second text-only browser extension — reinforces §3

**`dfki-dsa/pii-guardrail-browser-extension`** is a local-first Chrome extension that detects and
anonymises PII **before text is pasted** into ChatGPT / Claude / Gemini, using Rust→WASM recognizers plus
an optional in-browser transformer NER. Architecturally it is the closest existing artefact to our
client: local models, WASM, browser extension, redact-before-send. **It still only sees text the user
types or pastes.** Together with Casper (§3) this is now two independent implementations of the
text-paste sanitiser — which is exactly why the *screen* sanitiser is the open slot, and why we should
cite both rather than pretend the category is empty.

### 4.5 Published metrics on PII models are not trustworthy — use this, it is a weapon

- **arXiv:2504.12308 — "Unmasking the Reality of PII Masking Models: Performance Gaps and the Call for
  Accountability"** ✅ documents that reported PII-masking performance does not survive independent
  evaluation.
- **PII-Bench** (arXiv:2502.18545, "Evaluating Query-Aware Privacy Protection Systems"): **2,842 test
  samples across 55 fine-grained PII categories**, and — critically — evaluates protection *relative to
  the query*, i.e. it scores whether the sanitised input still answers the question ✅
- **arXiv:2512.18608** finds lightweight LMs match frontier LLMs on PII masking under entity-level and
  character-level metrics ✅ — direct support for "small local model is sufficient", which is 20% of our
  score.

**Consequence:** when a judge asks "why not just use an existing PII model and quote its numbers?", the
answer is a citation, not an opinion: published numbers have been shown not to replicate, so we measure
on our own held-out set and publish the harness.

## 5. Feasibility — in-browser model runtimes, with real numbers

The PS names the stack itself (**WebGPU, WebAssembly, ONNX Runtime Web, Transformers.js**), so the risk
is not "is it possible" but "can it hit the latency and resource budgets that are 35% of the score."

### 5.1 A real VLM in a browser tab is already demonstrated by the model vendor

- **Apple FastVLM** (CVPR 2025). Apple's own repo states the smallest variant "outperforms
  LLaVA-OneVision-0.5B with **85× faster Time-to-First-Token (TTFT)** and a **3.4× smaller vision
  encoder**" ✅. The mechanism is **FastViTHD**, a hybrid encoder that emits *fewer visual tokens* for
  high-resolution input — which is exactly the screenshot problem: big canvas, small text.
- **`onnx-community/FastVLM-0.5B-ONNX`** ships ONNX weights and points at an **Apple-owned Hugging Face
  Space, `apple/fastvlm-webgpu`**, described on the card as running **"100% locally in your browser with
  Transformers.js"** ✅. This is the single most useful feasibility citation we have: the *vendor*
  publishes the in-browser WebGPU demo, so "a VLM cannot run client-side" is not arguable.
- The card's recommended in-browser quantisation is explicit and worth copying verbatim as our starting
  configuration ✅:
  `dtype: { embed_tokens: "fp16", vision_encoder: "q4", decoder_model_merged: "q4" }`
  → i.e. **4-bit vision encoder and decoder, fp16 embeddings**. That is the difference between a model
  that fits a laptop's VRAM budget and one that does not, and it is a published default rather than a
  guess of ours.

### 5.2 The grounding/OCR option

- **`onnx-community/Florence-2-base`** — official ONNX weights for Transformers.js, and the model does
  **OCR, OCR-with-region, caption-to-phrase grounding, dense region caption and open-vocabulary
  detection** in one checkpoint. It returns *boxes*, which is what redaction needs. A plain ViT
  classifier does not localise and therefore cannot drive a redactor — this distinction is load-bearing
  (see the triage note in project memory).
- **SmolVLM** also runs in-browser via Transformers.js and is a smaller-footprint alternative if the
  resource budget bites.

### 5.3 Runtime and execution-provider facts

| Fact | Value | Status |
|---|---|---|
| Transformers.js major version (2026) | **v4** | ✅ |
| WebGPU vs WASM speed-up in ONNX Runtime Web | commonly **10–15×**, but strongly model- and hardware-dependent | 🟡 |
| Reference WebGPU throughput data point | a BERT-variant at **~8–9 ms/sample** in Chrome on an NVIDIA T400 (4 GB) | 🟡 |

### 5.4 Firefox is the real portability constraint — and it is sourced

| Platform | WebGPU in Firefox stable | Source |
|---|---|---|
| Windows | shipped in **Firefox 141** (released 2025-07-22) | ✅ Mozilla release notes / MDN |
| macOS, Apple Silicon | shipped in **Firefox 147** (released 2026-01-13) | ✅ Firefox 147 release notes |
| Linux | **not shipped** — enabled by default in Nightly only; "Mozilla expects to ship on Linux in **2026**"; other Mac platforms TBD | ✅ gpuweb Implementation-Status wiki |

**Consequences we must design for, not discover during judging.** The PS asks for Chrome **and** Firefox,
so (a) a **WASM execution-provider fallback is mandatory**, not optional polish; (b) all latency and
resource numbers must be reported **per engine and per backend** (Chrome/WebGPU, Firefox/WebGPU,
WASM-fallback), because a single averaged number will be correctly attacked; (c) the model-size decision
should be driven by the *WASM* budget, since that is the worst case we are guaranteed to hit.

## 6. Feasibility — extension capture and execution APIs (Chrome + Firefox)

### 6.1 Capture: the browsers already treat screen pixels as privileged

From MDN's `tabs.captureVisibleTab()` reference ✅:

- "Creates a data URL encoding the image of an area of the active tab in the specified window. You must
  have the `<all_urls>` or `activeTab` permission."
- "In addition to sites that extensions can normally access, this method allows extensions to capture
  **sensitive sites that are otherwise restricted, including browser UI pages and other extensions'
  pages**. These sensitive sites can only be captured with the `activeTab` permission. Chrome also
  permits file URLs to be captured when the extension has been granted file access."
- "In **Firefox 125 and earlier**, this method was only available with the `<all_urls>` permission."

**Three things follow, and the first one is a pitch line.** (1) The platform vendors themselves classify a
tab screenshot as more sensitive than DOM access — it can cross into browser UI and other extensions —
which is independent, citable support for our threat model instead of us asserting that pixels are
sensitive. (2) We should ship on **`activeTab`**, which is gesture-scoped and revocable, not `<all_urls>`;
that is both a better privacy story and a smaller review surface, and it requires **Firefox ≥ 126**.
(3) Capture returns the **visible viewport only** — not the full page, not offscreen content — so
"read the whole page" is not available, and the trigger policy (§9) has to be viewport-aware.

### 6.2 Where inference can legally run — the portability trap most teams miss

| | Chrome MV3 | Firefox MV3 |
|---|---|---|
| Background context | **Service worker** — Chrome's own docs: "Service workers don't have DOM access" ✅ | **Non-persistent background script or page** (event page): MDN — "In Manifest V3, only non-persistent background scripts or a page are supported" ✅ |
| DOM / canvas host for the model | **Offscreen document** — `chrome.offscreen` + `offscreen` permission, **from Chrome 109**; "allows the extension to use DOM APIs in a hidden document" ✅ | No `chrome.offscreen` equivalent 🟡 — use the background event page or a hidden extension page |
| Sharp edge | Chrome's reference states **`runtime` is the only extensions API available inside an offscreen document** ✅ → the offscreen doc **cannot call `captureVisibleTab` itself**; the service worker must capture and hand the bitmap over via messaging | Non-persistent backgrounds are terminated when idle (~30 s) 🟡 → model **cold-start cost recurs** |

**Design consequence:** one `InferenceHost` abstraction with two implementations (Chrome → offscreen
document; Firefox → background event page). A content script is the *wrong* host: it inherits the page's
CSP, and it would load the model once per tab. Because idle termination is real, latency must be reported
as **cold vs warm separately**, with an explicit keep-alive/eviction policy — that is an honest number
and it protects the 15% latency score from a "you only measured the warm path" attack.

### 6.3 The vision mandate — what the DOM structurally cannot see

This subsection exists to answer the single most dangerous question: **"why do you need a vision model at
all if you can read the DOM?"** Each row is a case where a content script is *structurally* blind while
the captured pixels are complete. This list is the demo script, not a footnote.

| Blind spot | Why the DOM/content script fails | Status |
|---|---|---|
| **Cross-origin iframes** | Same-origin policy: a content script cannot read into another origin's frame. The composited screenshot contains it in full. Embedded payment fields, bank widgets, third-party chat and SSO forms all live here | ✅ |
| **`<canvas>` / WebGL** | The content is pixels; there are no text nodes to read. **Google's own Workspace blog announced (May 2021) that "Google Docs will now use canvas based rendering"** — so the most widely used document editor on earth defeats DOM-only text extraction. Google states assistive-technology support was preserved by other means, so the a11y tree may still help *there*; arbitrary canvas apps, charts, dashboards and games carry no such annotation | ✅ |
| **`<video>` frames** | A shared screen in a video call, a recorded demo replaying credentials — no DOM representation at all | ✅ |
| **The browser's built-in PDF viewer** | Rendered by the browser, not as page DOM; a content script gets no text | 🟡 |
| **Text baked into images** | Scans, ID cards, screenshots pasted into chat threads, invoice photos. Only OCR recovers it | ✅ |
| **Faces in images** | No DOM attribute says "this img contains a human face" | ✅ |
| **Closed shadow roots** | `attachShadow({mode:"closed"})` is not traversable from outside | ✅ |
| **Deliberate or incidental DOM obfuscation** | Div-soup with no semantics, content injected via CSS `::before`, `-webkit-text-security` masking, virtualised lists that only render a window of rows | 🟡 |
| **Visibility itself** | The DOM says an element *exists*; it does not say it is visible. Occlusion, clipping, z-order, modal overlays, `opacity:0`, autofill dropdowns painted by the browser — only the rendered frame knows what a human can actually see, and therefore what actually leaks | ✅ |

**The precise argument to make:** the DOM answers *"what does the page declare?"* The screenshot answers
*"what is on the user's screen?"* PS171's metric #1 is literally "accuracy of visual context **from
screen**", and the leak surface is what is *visible*, not what is declared. So DOM/a11y is our **fast
path and label source**, and vision is the **universal floor plus the arbiter of visibility**. Any system
that reads only the DOM has a hole exactly the size of the list above — and a demo on a
`<canvas>`-rendered editor inside a cross-origin iframe makes that hole visible in ten seconds.

### 6.4 Cross-engine portability checklist (this is where marks are quietly lost)

| Concern | Chrome | Firefox | Our handling |
|---|---|---|---|
| Screenshot | `tabs.captureVisibleTab` ✅ | same API ✅, `activeTab`-only from **126** | `activeTab`, viewport-scoped |
| Inference host | offscreen document (109+) | background event page | `InferenceHost` with two backends |
| WebGPU | shipped | **Windows 141, Apple-Silicon macOS 147, Linux not yet** | WASM fallback is mandatory; report per-backend numbers |
| Namespace | `chrome.*` (+ `browser.*` promises via polyfill) | `browser.*` promise-based | `webextension-polyfill`, single codebase |
| `chrome.debugger` / CDP | exists, needs `debugger` permission, raises a browser-wide "started debugging" banner | **no equivalent** | **Excluded by design** — see §9 |

## 7. Benchmarks and datasets — one per published weight

Because the PS publishes a numeric rubric, the deciding artefact is a **measurement harness**, not a
narrative. Each weight below gets a named public dataset plus an owned metric definition.

### Weight 1 — accuracy of visual context from screen (25%)

- **ScreenSpot-Pro** — arXiv:2504.07981 ✅. Authentic high-resolution screenshots, expert annotations,
  **23 applications across 5 industries and 3 operating systems**. Headline results we must know:
  **existing GUI grounding models reach only 18.9%**, and the paper's own method **ScreenSeekeR reaches
  48.1% with no additional training** by "strategically reducing the search area."
- **Why that 18.9% is the most useful number in this dossier.** It proves high-resolution GUI grounding is
  an *open* problem, so a judge cannot say "grounding is solved, you are wrapping a solved model." It also
  hands us a published justification for a **coarse→fine cascade** (locate a region, then re-run the small
  model on the crop) instead of one big model pass — the same trick, in-browser, is also the cheapest way
  to protect the 20% resource score.
- **OmniParser + GPT-4o = 39.6 average on ScreenSpot Pro** (§2) is the cloud baseline to be measured
  against; the honest framing is "we accept a grounding gap in exchange for zero raw-pixel egress, and
  here is the measured size of that gap."
- **ScreenSpot** (original, includes a web split) is the closer distribution to browser pages than
  ScreenSpot-Pro's desktop professional apps 🟡 — use the web split as the primary set and Pro as the
  stress set. **ScreenSuite** (Hugging Face) aggregates GUI-agent evaluations 🟡.
- **VisualWebArena** — arXiv:2401.13649 ✅ — realistic *visually grounded* web tasks; **WebArena** and
  **Mind2Web** for end-to-end task success. Use a small fixed subset: end-to-end success is a slow metric
  and only a handful of tasks are needed to show the loop closes.

### Weight 2 — recall and precision of sensitive/PII detection (20%)

- **PII-Bench** — arXiv:2502.18545 ✅ — **2,842 samples across 55 fine-grained PII categories**, scored
  *query-aware* (does the sanitised input still answer the question?).
- **`ai4privacy/pii-masking-200k` / `-400k`** — the de-facto open training/eval corpus for PII masking 🟡
  (confirmed indirectly: multiple published PII models cite it as their fine-tuning set).
- **WiderFace** for face detection, with results reported on the **small-face** subset, because webpage
  avatars are small faces 🟡.
- **FUNSD / CORD / SROIE** for form and receipt field extraction — the closest public proxy for
  "documents rendered inside a browser" 🟡.
- Rendering step we own: rasterise text corpora into realistic web layouts so a *text* PII corpus becomes
  a *pixel* PII corpus with exact ground-truth boxes. This is how we get labelled screen data at zero
  annotation cost, and it is a legitimate, explainable synthetic pipeline.

### Weight 3 — precision of redaction (20%)

Three metrics, only the first of which is obvious:

1. **Pixel IoU** of emitted masks against ground-truth PII regions, plus over-redaction area (fraction of
   non-PII pixels destroyed).
2. **Adversarial re-extraction leak test (ours).** Run OCR *and* a PII detector over the sanitised
   artefact that is actually transmitted, and count how many ground-truth PII strings are recoverable.
   Target zero. This converts "we redact" from an assertion into a falsifiable test, and it is what makes
   a network-inspector demo undismissable.
3. **Utility retention.** Task success rate *after* sanitisation vs on raw input. Justified by
   **PrivacyPAD** (arXiv:2510.16054): a static rewriter destroys task-critical information, so a
   redaction score without a utility score is meaningless — and this is the answer to "why not black out
   everything?"

### Weights 4 and 5 — client resource utilisation (20%) and end-to-end latency (15%)

Measure and publish, per engine and per backend (Chrome/WebGPU, Firefox/WebGPU, WASM):

- **Resource:** on-disk model bytes, peak JS heap (`performance.measureUserAgentSpecificMemory()`),
  process RSS, GPU memory against the WebGPU adapter's reported limits, CPU time per invocation, and
  **idle cost** (must be ≈0 — this is where the trigger policy pays off).
- **Latency:** per-stage breakdown (capture → preprocess → local inference → redact → serialise →
  network → server → action), **p50 and p95**, and **cold vs warm** reported separately because
  non-persistent backgrounds are evicted (§6.2). Plus **payload bytes sent**, which doubles as a privacy
  measure: a structured sanitised payload should be orders of magnitude smaller than a PNG screenshot.

## 8. The gap analysis — stated as a table a judge can check

Four properties matter. **No existing system has all four**, and that intersection is the whole entry.

| System | Perception runs on the client | Sanitises the **rendered screen** (not typed text) | Closed **action** loop back into the page | Published per-metric numbers |
|---|---|---|---|---|
| Operator / Computer Use / Mariner / Comet | ✗ cloud | ✗ ships raw screenshots | ✓ | ✗ |
| Browser Use / Skyvern / Nanobrowser | ✗ usually cloud | ✗ | ✓ | partial |
| OmniParser V2 | ✗ desktop Python/CUDA | ✗ parses, does not redact | ✗ (parser only) | ✓ grounding only |
| Casper (arXiv:2408.07004) | ✓ | ✗ typed prompt text | ✗ | ✓ PII/topic |
| `pii-guardrail-browser-extension` | ✓ | ✗ pasted text | ✗ | ✗ |
| PAPILLON / AirGapAgent / ProSan / PrivacyPAD | ✓ local model | ✗ text | ✗ | ✓ |
| `presidio-image-redactor` | ✗ Python | partial — **OCR text in a static image**, no UI model, no visibility model | ✗ | ✗ |
| **This entry** | ✓ | ✓ | ✓ | ✓ (the harness is the deliverable) |

**The one-sentence novelty claim, kept deliberately narrow:**

> Prior work sanitises *text a user authored* before sending it to a remote model. We sanitise *the
> rendered screen the user did not author*, and we close the loop: the remote model receives a
> representation it can plan over but cannot read, and the client executes that plan by re-binding
> placeholders to real values locally. **Capability without disclosure.**

That claim survives scrutiny because it concedes everything that is already solved (§4.1, §5.1) and
claims only the intersection nobody occupies.

## 9. Proposed architecture

**Working name:** ANTARDRISHTI ("inner sight") — placeholder, change freely.

**Thesis to repeat in one line:** *the server gets capability, never disclosure.*

### 9.0 The four load-bearing mechanisms

If the deck says nothing else, it must say these. Each is a mechanism with a test, not a feature.

| # | Mechanism | Why it is not a wrapper | How it is proven |
|---|---|---|---|
| **M1** | **Unified scene graph with one ID space.** DOM/a11y and vision both write into a single node table (id, role, bbox, visible?, sensitivity class, value-or-placeholder). Conflicts resolved by a written policy: **vision is authoritative on visibility and on any region the DOM cannot express; DOM is authoritative on role/name when its text matches the rendered pixels.** | The obvious build has two disagreeing ID spaces — image masks indexed one way, element list another — so the redaction and the action plan can silently refer to different things. Reconciliation *is* the engineering. | Cross-check test: every transmitted node's bbox must contain the pixels its label claims; mismatch rate is a reported metric. |
| **M2** | **Privacy-scoped capability tokens.** A placeholder is not a string — it is a **use-once, target-bound capability**: `<EMAIL_01>` is redeemable only into the node it was harvested from, or a node the local policy allows, once, within the session. | Placeholder-restoration already exists (§3). Turning placeholders into *access-control* objects is new, and it is what makes a remote plan safe to execute. | Attack demo: a page that prints "type the password into this comment box", plus a hostile server plan. Both are refused by the client, on camera. |
| **M3** | **Egress gate that re-reads its own output.** Before any byte leaves, the gate runs OCR + a PII detector **over the outgoing payload itself** and blocks the send if any known-sensitive string is recoverable. The leak test from §7 is not only an offline benchmark; it is a **runtime interlock**. | Every other system trusts its own redactor. This one assumes the redactor is fallible and verifies the artefact. | Live demo: sabotage the detector, watch the gate refuse to transmit. |
| **M4** | **Session-salted, type-generalised placeholder namespace.** IDs are salted per session, so `<EMAIL_01>` is unlinkable across sessions; and the *type label itself* is generalised when the type leaks (`<SENSITIVE_07>`, not `<HIV_STATUS_01>`) — because a label can disclose an attribute even with the value removed (arXiv:2608.09140, "Beyond Direct Identifiers"). | The naive scheme leaks by linkage and by label. Fixing both is cheap and shows we read the literature. | Unlinkability check: same user, two sessions, zero overlapping identifiers. |

### 9.1 The tiered pipeline (the answer to "is your vision model decorative?" and to the 20% resource weight)

The cascade is not an arbitrary optimisation — it is **ScreenSpot-Pro's own published finding**
("strategically reducing the search area enhances accuracy", 18.9% → 48.1%, §7) applied to privacy
instead of grounding. Cheap tiers run always; expensive tiers run on shrinking regions.

| Tier | Runs | What it does | Cost class |
|---|---|---|---|
| **T0 Trigger** | on navigation / DOM mutation settle / explicit user intent — **never per frame** | decides whether to perceive at all | ~0 |
| **T1 Structural harvest** | always | DOM + accessibility tree: roles, names, values, boxes, `input[type=password]`, ARIA, computed visibility | ms |
| **T2 Rule recognizers** | always | regex + **checksum validators** (Luhn for cards, Verhoeff for Aadhaar, IBAN, IFSC, PAN, GSTIN) + context words. Presidio-style, high precision, near-zero cost | ms |
| **T3 Vision proposal** | on trigger | downscaled frame → **text-region detector** (DBNet/PaddleOCR-det class, ONNX) + **MediaPipe face detector** → candidate boxes. No language model involved | tens of ms |
| **T4 Crop recognition** | only on boxes that are **not covered by T1**, or are flagged risky | OCR recognition on crops → **GLiNER-class PII NER** on the recovered text | per-crop |
| **T5 Grounded VLM** | rarely — ambiguous crops, "is this an ID card?", element-purpose questions | **FastVLM-0.5B** (q4, per the vendor's own in-browser recipe) or **Florence-2-base** for OCR-with-region and open-vocabulary detection | expensive, bounded by crop count |
| **T6 Reconcile + gate** | always | build the M1 scene graph, classify sensitivity, apply policy, redact, mint M2 capabilities, run the M3 egress gate | ms |

**The set-difference in T4 is the whole efficiency argument:** vision only pays for what the DOM could not
already explain. That single rule is what makes the vision model load-bearing *and* cheap, and it is
directly reportable — "N% of screen area required vision; the rest was explained structurally."

### 9.2 What actually crosses the network

Default payload is **structured text, not an image.** A crop is attached only when vision found a region
the DOM cannot express *and* that region is judged non-sensitive after redaction.

```json
{
  "scheme": { "version": "1.0", "session_salt": "s7f3…", "placeholder_types": ["PERSON","EMAIL","ID","SECRET","SENSITIVE"] },
  "viewport": { "w": 1440, "h": 810, "dpr": 2 },
  "nodes": [
    { "id": "n17", "role": "textbox", "name": "Recipient email", "bbox": [312,208,268,32],
      "visible": true, "source": "dom+vision", "value": "<EMAIL_a91c_01>" },
    { "id": "n23", "role": "img", "name": null, "bbox": [64,420,180,180],
      "visible": true, "source": "vision", "value": "<SENSITIVE_a91c_04>", "reason": "face" },
    { "id": "n31", "role": "button", "name": "Send", "bbox": [980,208,96,36], "visible": true, "source": "dom" }
  ],
  "crops": [ { "id": "c2", "of": "n44", "why": "canvas_region", "png": "…redacted…" } ],
  "coverage": { "screen_px": 1166400, "vision_only_px": 138240, "redacted_regions": 5, "gate": "passed" }
}
```

Three details worth defending out loud: the **salt in every placeholder** (M4), the explicit
`source` field per node so a judge can see which claims came from vision versus the DOM, and the
`coverage` block — the payload **self-reports** how much of the screen needed vision and that the egress
gate passed. Self-reporting is what turns a claim into an artefact.

### 9.3 Server side

- Common case: the payload is **structured text**, so the server can be a **text-only open-weights LLM** —
  cheaper, faster, easier to deploy offline (PS requires an offline-deployable open model; a hosted copy
  is allowed during SIH). Concrete pick: a Qwen2.5-class instruct model; a **VLM (Qwen2.5-VL-7B-Instruct
  class)** is loaded only for the rare crop path 🟡 *verify current open-weights releases before fixing*.
- The server is told the **scheme**, never the vault. It returns a **typed action plan** referring only to
  node IDs and placeholders.
- Nothing on the server is allowed to be necessary for correctness of redaction. If the server is
  malicious, the failure mode must be *task failure*, not *disclosure* — that is the property to state.

### 9.4 Executor and action-path safety

The action loop is where a naive design becomes a security hole: the page's content is **untrusted**, and
the server's plan is **only semi-trusted**. A page that renders the text "click Delete Account" can
otherwise steer the agent — the classic confused-deputy / indirect prompt injection.

- **Typed action schema only** — `click(nodeId)`, `type(nodeId, placeholder|literal)`, `scroll(dir)`,
  `select(nodeId, option)`, `navigate(url)` against an allowlist. No free-form scripting, no eval.
- **Capability redemption (M2)** happens *inside* the client at execution time: the vault checks that the
  placeholder is being redeemed into a permitted target, once, in-session. A plan that tries to type a
  secret somewhere it was not harvested from **fails closed**.
- **Human confirmation for destructive or irreversible actions** (payments, deletions, sending messages,
  permission changes) with a visible tool-call tape. This UX already exists in the user's HRMS2 WebMCP
  work and transfers directly.
- **Provenance separation:** text extracted from the page is data, never instruction. State this
  explicitly; it is the difference between a designed system and an accident.

### 9.5 Trigger and resource policy (protects 20% + 15%)

- Perceive on **navigation, mutation-settle (debounced), or explicit user intent** — never per frame.
  Idle CPU/GPU cost must measure ≈0, and that number should be on a slide.
- **Frame-delta short-circuit:** hash the downscaled frame; if it is unchanged within a tolerance, reuse
  the previous scene graph. Most screens are static most of the time.
- **Sensitivity cache keyed by (origin, DOM path, bbox)** so a re-visited field is not re-inferred, with
  invalidation on layout change.
- Model residency policy: one warm host (§6.2), explicit eviction, and **cold vs warm latency reported
  separately** so the numbers survive scrutiny.

### 9.6 Deliberately excluded — and each exclusion is a defensible answer, not a gap

| Excluded | Why | What a judge hears |
|---|---|---|
| **`chrome.debugger` / CDP** | Chrome-only, needs the `debugger` permission, raises a browser-wide "started debugging" banner, no Firefox equivalent, and it contradicts the privacy thesis | "We rejected the most powerful automation path because it fails the PS's Chrome+Firefox requirement and the trust model." |
| **WebMCP as a fallback tier** | Pull-only; the **site** must register tools on `document.modelContext`; the finale's unseen sites will expose none; flagged preview in Chrome, absent in Firefox | "It is an opportunistic fast path when a site advertises tools — never the mechanism we depend on." |
| **Per-frame / continuous inference** | Destroys the 20% resource score for near-zero task benefit | "Perception is event-driven; here is idle cost ≈ 0." |
| **Any cloud OCR or cloud PII service** | Would violate the core property in the most embarrassing possible way | "Nothing leaves before the gate. Ever." |
| **Sending the full screenshot by default** | Both a leak surface and a latency cost; structured text is smaller by orders of magnitude | "We send an image only when vision found something the DOM cannot express, and only after redaction." |
| **Training a new foundation model** | 11 days, and the rubric rewards measurement, not model training | "We integrate published models and own the reconciliation, the gate, and the harness." |

### 9.7 Module map

| Module | Owns | Reuse available |
|---|---|---|
| `capture` | trigger policy, `captureVisibleTab`, DPR normalisation, frame hashing | — |
| `harvest` | DOM + a11y walk, computed visibility, password/OTP/autofill heuristics | — |
| `perceive` | T3/T4/T5 model hosting, `InferenceHost` (offscreen ⟷ event page), WASM fallback | Transformers.js / ORT-Web |
| `reconcile` | **M1** scene graph, one ID space, conflict policy, coverage accounting | — |
| `classify` | sensitivity ladder, contextual-integrity policy (AirGapAgent vocabulary) | Presidio-style recognizers |
| `vault` | **M2** capability minting/redemption, **M4** salted namespace | HRMS2 approval-gate UX |
| `gate` | **M3** re-extraction interlock, payload serialisation, the only place `fetch` exists | — |
| `execute` | typed action schema, allowlist, confirmation tape, WebMCP fast path | HRMS2 tool-call tape |
| `harness` | datasets, labelling, per-metric scoring, resource/latency traces, report generation | — |

**Architectural invariant to enforce in code and state on a slide:** `gate` is the **only** module that
can reach the network, and the raw framebuffer never crosses out of `perceive`. The property is then a
*structural* claim about the codebase, testable by inspection, not a promise.

## 10. Judge-attack table

Every row is a question we should *want* to be asked. The answer is one line plus a citation or a number —
never a paragraph.

| Attack | Answer |
|---|---|
| **"Operator / Comet / Claude in Chrome already do this."** | They do the *agent*. All of them send raw page context or raw screenshots to a cloud model. We are not claiming the first browser agent; we claim the perception+privacy layer runs on the client and the remote model is *structurally incapable* of seeing raw pixels (§1, §8). |
| **"It's a wrapper around FastVLM + GLiNER + an LLM."** | Correct, and deliberately so — those are commodity and we cite them (§4.1, §5.1). The parts that are ours: **M1** reconciliation into one ID space, **M2** capability-scoped placeholders, **M3** the self-verifying egress gate, **M4** salted/type-generalised namespace, plus the measurement harness. None of the four exists in any cited system. |
| **"OmniParser already parses screens."** | Yes, and we benchmark against it. It is desktop Python/CUDA, does no PII detection, no redaction, no network gating, and its only privacy provision is avoiding *attribute inference* about people in icon images (§2). |
| **"Presidio already redacts PII in images."** | `presidio-image-redactor` is Python, self-described as a **beta simple OCR pipeline**, covers **OCR text only** — no faces, no UI model, no visibility model, no egress gate, no action loop (§4.2). We reuse its recognizer *ideas* at T2. |
| **"Casper already does this in a browser extension."** | Casper sanitises **the prompt the user typed**, inside a chat page. So does `pii-guardrail`. Neither perceives the screen; neither can act. That is precisely the open slot (§3, §8). |
| **"Why a vision model when you can read the DOM?"** | Nine structural blind spots, each demonstrable: cross-origin iframes, `<canvas>` (**Google Docs itself renders to canvas** — Google's own 2021 announcement), `<video>`, the PDF viewer, text baked into images, faces, closed shadow roots, obfuscated DOM, and **visibility itself** (§6.3). The DOM says what a page *declares*; the frame says what the user can *see* — and the leak is what is visible. |
| **"Why not just black out everything?"** | Because that is a published failure mode: **PrivacyPAD (arXiv:2510.16054)** shows static rewriters destroy task-critical information. We therefore report **utility retention alongside redaction precision** (§7). |
| **"Prove you don't leak."** | Three artefacts: the live network inspector; the **adversarial re-extraction test** (OCR + PII detector over the transmitted payload, target zero recoverable strings); and the **structural invariant** that `gate` is the only module with network access and the framebuffer never leaves `perceive` (§9.7). |
| **"Can a model this size even run in a browser?"** | **Apple publishes the WebGPU browser demo itself** (`apple/fastvlm-webgpu`, "runs 100% locally in your browser with Transformers.js") and the ONNX card's own quantisation recipe is q4 encoder + q4 decoder (§5.1). Plus we run tiers T3/T4 far more often than T5. |
| **"A 0.5B local model will be worse than a cloud model."** | Agreed, and we *measure* the gap: OmniParser+GPT-4o scores 39.6 on ScreenSpot Pro, and even the best specialised grounding models score **18.9%** there — the task is unsolved for everyone (§7). The trade is stated openly: a measured accuracy gap in exchange for zero raw-pixel egress. |
| **"Firefox? No GPU?"** | Sourced platform matrix: WebGPU in Firefox **141 Windows**, **147 Apple Silicon**, **not on Linux — Mozilla expects 2026** (gpuweb wiki). Hence a mandatory **WASM fallback** and per-backend numbers, and model sizing driven by the WASM worst case (§5.4, §6.4). |
| **"Your PII recall will not be 100%."** | Nobody's is — **Presidio's own README** says there is no guarantee it finds everything, and **arXiv:2504.12308** shows published PII-model metrics do not replicate. So: layered detection (rules + NER + vision), **fail-closed** on uncertainty for high-severity classes, the runtime re-extraction interlock, and honest per-class recall/precision curves rather than one number. |
| **"What if the server is malicious?"** | Then the task fails; it does not disclose. The server never receives values, never receives the vault, and cannot redeem a capability. A hostile plan that targets a secret at the wrong node **fails closed** in the client (§9.4). |
| **"What stops a page from hijacking the agent?"** | Typed action schema + allowlist + provenance separation (page text is data, never instruction) + human confirmation for destructive actions — demonstrated with a deliberately hostile page (§9.4). |
| **"The finale uses unseen sites."** | Nothing is site-specific by construction: T1 is generic DOM/a11y, T2 is validator-based, T3–T5 are pixel-domain. The demo must include a site we have never opened before, chosen by the judge. |
| **"Why not accessibility tree only — it's built for this?"** | It is our T1 and it is cheap. But it is *advisory*: it is absent or wrong on canvas apps, custom widgets and div-soup, and it does not encode occlusion. A privacy guarantee cannot rest on a page's voluntary self-description. |
| **"Why does ISRO care?"** | This is the question to answer *first*, not last. Organisations that cannot send screen contents to a foreign-hosted model — space and defence operations, ground-station and telemetry consoles, and anyone under India's DPDP Act — currently cannot use browser agents at all. An offline-deployable open-weights server plus on-device perception is the only shape of agent that is admissible inside such a boundary. |

## 11. Open risks (stated plainly, because unstated risks get found)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **Small-text and small-face recall.** Downscaling the frame for speed is exactly what destroys 11-px form labels and 40-px avatars. MediaPipe's face models are documented for faces within 2–5 m of a *camera*, not webpage thumbnails (§4.3) | High — hits weights 1 and 2 | Detect on the downscaled frame, **recognise on crops at native DPR**; report small-object recall separately; keep a general small-face ONNX detector as fallback |
| R2 | **WASM-only path blowing the latency budget** (Firefox on Linux has no WebGPU) | High — hits weight 5 | Measure the WASM path in the **first** week, not the last; size models to the WASM budget; allow a detector-only degraded mode (T1–T4, no T5) |
| R3 | **Over-redaction destroying task success** (PrivacyPAD) | High — silent failure | Utility-retention metric is mandatory, reported next to redaction precision |
| R4 | **Ground-truth labelling cost** for screen PII | Medium | Synthetic render pipeline for volume + a small **hand-labelled real-page set** as the honest test; never report only synthetic numbers |
| R5 | **First-run model download size**; even a q4 0.5B VLM is large | Medium — first impression | Tiered download: detector tier works immediately, VLM fetched lazily; report bytes on disk; cache in extension storage |
| R6 | **Cross-engine drift**: offscreen-document vs event-page hosts, `activeTab` needing Firefox ≥ 126, `chrome.*` vs `browser.*` | Medium | Single `InferenceHost` abstraction + `webextension-polyfill`; a two-browser smoke test in CI from day one |
| R7 | **Open-weights server model churn** — the concrete pick should be re-verified rather than inherited from this document | Low | Fix the model only when the server path is built; keep the interface model-agnostic |
| R8 | **Demo fragility.** A canvas/cross-origin showcase page we authored looks like a rigged demo | Medium — credibility | Use well-known third-party sites for the blind-spot demo, and invite the judge to name a site |
| R9 | **"On-device" misread as "no server"** | Low | The PS itself mandates a server-side LLM/VLM that knows the redaction scheme — quote it |
| R10 | **11 days to the internal round (2026-09-16)** | High | Fix a cut order early: the four mechanisms (M1–M4) + one blind-spot demo + the harness on a small set beats a broad, unmeasured prototype |
| R11 | **This workspace has no Linux VM** (`VM_DISK_SPACE_INSUFFICIENT`), so no local Python, no python-pptx, no PDF rasterisation | Low, process-level | Deliverables as HTML/Markdown; do not plan on local script execution |

## 12. Sources

Grouped by section. ✅ = read directly in the course of this research; 🟡 = search-result summary only,
re-verify before quoting on a slide.

**Problem statement**
- SIH 2026 PS list mirror, `ps_2026/SIH26171.md` (CC-BY-4.0 scrape of sih.gov.in/sih2026PS) ✅

**§2 On-device / pure-vision screen understanding**
- OmniParser v1 — https://arxiv.org/abs/2408.00203 ✅
- OmniParser V2 announcement, Microsoft Research ✅

**§3 Privacy-preserving delegation (all text-domain)**
- Casper — https://arxiv.org/abs/2408.07004 · IEEE CSCloud 2025, DOI 10.1109/CSCloud66326.2025.00027 ✅
- PAPILLON — https://arxiv.org/abs/2410.17127 ✅
- AirGapAgent — https://arxiv.org/abs/2405.05175 ✅
- ProSan — https://arxiv.org/abs/2406.14318 ✅
- LLM-Redactor — https://arxiv.org/abs/2604.12064 ✅
- PrivacyPAD — https://arxiv.org/abs/2510.16054 ✅
- Beyond Direct Identifiers — https://arxiv.org/abs/2608.09140 ✅
- PromptGraph — https://arxiv.org/abs/2607.10709 ✅

**§4 PII / sensitive-region detection**
- Microsoft Presidio — https://github.com/microsoft/presidio ✅ · docs `docs/index.md` ✅ · README disclaimer ✅
- `presidio-image-redactor` — https://pypi.org/project/presidio-image-redactor/ ✅
- Presidio design discussion #1049 ("beta", "simple OCR pipeline") — https://github.com/microsoft/presidio/discussions/1049 ✅
- Presidio releases (DICOM redaction, #960) — https://github.com/microsoft/presidio/releases ✅
- GLiNER2-PII — https://arxiv.org/abs/2605.09973 🟡
- GLiNER PII ONNX ports: `ineersa/gliner-PII-onnx`, `Sovraine/gliner-pii-onnx` (from `nvidia/gliner-PII`), `gravitee-io/gliner-pii-detection` 🟡
- Piiranha (from `microsoft/mdeberta-v3-base`) 🟡
- `dfki-dsa/pii-guardrail-browser-extension` 🟡
- MediaPipe Face Detector for Web — https://developers.google.com/edge/mediapipe/solutions/vision/face_detector/web_js ✅ · model-selector 2 m / 5 m doc — https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/face_detection.md ✅
- "Unmasking the Reality of PII Masking Models" — https://arxiv.org/abs/2504.12308 ✅
- PII-Bench / "Evaluating Query-Aware Privacy Protection Systems" — https://arxiv.org/abs/2502.18545 ✅
- Lightweight LMs for PII masking — https://arxiv.org/abs/2512.18608 🟡
- `ai4privacy/pii-masking-200k` / `-400k` 🟡

**§5 In-browser runtimes**
- FastVLM, Apple ML Research — https://machinelearning.apple.com/research/fast-vision-language-models ✅
- `apple/ml-fastvlm` README (85× TTFT, 3.4× smaller encoder) — https://github.com/apple/ml-fastvlm ✅
- `onnx-community/FastVLM-0.5B-ONNX` (q4 recipe; links the Apple WebGPU Space) — https://huggingface.co/onnx-community/FastVLM-0.5B-ONNX ✅
- Apple's in-browser demo — https://huggingface.co/spaces/apple/fastvlm-webgpu ✅ (referenced from the card)
- `onnx-community/Florence-2-base` 🟡 · SmolVLM in-browser 🟡
- WebGPU in major browsers — https://web.dev/blog/webgpu-supported-major-browsers 🟡
- Firefox 141 (Windows WebGPU, 2025-07-22) — https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/141 ✅
- Firefox 147 (Apple Silicon WebGPU, 2026-01-13) — https://www.firefox.com/en-US/firefox/147.0/releasenotes/ ✅
- gpuweb Implementation Status ("Mozilla expects to ship on Linux in 2026") — https://github.com/gpuweb/gpuweb/wiki/Implementation-Status ✅

**§6 Extension APIs**
- `tabs.captureVisibleTab()` — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureVisibleTab ✅
- Background scripts ("In Manifest V3, only non-persistent background scripts or a page are supported") — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts ✅
- `chrome.offscreen` reference (`runtime` is the only API available inside) — https://developer.chrome.com/docs/extensions/reference/api/offscreen ✅
- Offscreen documents in MV3 (Chrome 109) — https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3 ✅
- "Google Docs will now use canvas based rendering" — https://workspaceupdates.googleblog.com/2021/05/Google-Docs-Canvas-Based-Rendering-Update.html ✅

**§7 Benchmarks**
- ScreenSpot-Pro — https://arxiv.org/abs/2504.07981 ✅ (18.9% best existing; ScreenSeekeR 48.1%) · leaderboard https://gui-agent.github.io/grounding-leaderboard ✅
- VisualWebArena — https://arxiv.org/abs/2401.13649 ✅
- ScreenSuite — https://huggingface.co/blog/screensuite 🟡
- WiderFace · FUNSD · CORD · SROIE · WebArena · Mind2Web 🟡

**§18–§20 third pass (2026-09-05) — artifacts and platform docs**
- `Parergon/Veil-tiny` model card — https://huggingface.co/Parergon/Veil-tiny ✅ · registry metadata (createdAt/lastModified/downloads/model-index/license) — https://huggingface.co/api/models/Parergon/Veil-tiny ✅
- `thesid42/Safe-Screen` README — https://github.com/thesid42/Safe-Screen ✅ · registry metadata (created_at/pushed_at/stars/license) — https://api.github.com/repos/thesid42/Safe-Screen ✅
- MDN *Content scripts* → **XHR and Fetch** ("In Chrome, starting with version 73, and Firefox, starting with version 101 when using Manifest V3, content scripts are subject to the same CORS policy as the page they are running within. Only backend scripts have elevated cross-domain privileges."; "content scripts can perform cross-origin requests when the destination server opts in using CORS; however, host permissions don't work in content scripts"; "`eval()` not available in Manifest V3") — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts ✅
- MDN *manifest.json/host_permissions* ("XMLHttpRequest and fetch access to those origins without cross-origin restrictions, **but not for requests from content scripts**") — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions ✅
- Chromium, *Changes to Cross-Origin Requests in Chrome Extension Content Scripts* — https://www.chromium.org/Home/chromium-security/extension-content-script-fetches/ ✅ (cited by MDN above)
- MDN restricted-domains list for content scripts (accounts.firefox.com, addons.mozilla.org, …) — same *Content scripts* page ✅ — relevant to the evaluation-page caveat in §11

## 13. Verification pass on the external critique (2026-09-05, second research pass)

A ChatGPT deep-research critique of §9 was supplied. It was **not** taken on trust: every citation in it
was searched independently. Result — most of it is real and consequential.

> ⚠️ **Correction, third pass.** This section originally concluded that part of the critique was
> *fabricated*. **That conclusion was wrong** and §13.2 has been retracted. Both artifacts exist; see
> **§18**. What follows in §13.1 and §13.3 stands.

### 13.1 Confirmed, and consequential

| Work | What it actually is | Verified figures | Status |
|---|---|---|---|
| **WebPII / WebRedact** — [arXiv:2603.17357](https://arxiv.org/abs/2603.17357) | First public benchmark for **visual PII detection in web screenshots**, built for computer-use agents. 44,865 annotated synthetic e-commerce UI images; extended PII taxonomy including transaction-level identifiers; anticipatory detection for partially-filled forms; VLM-based UI reproduction for scalable generation. | **WebRedact 0.753 mAP@50 vs 0.357 baseline, at 20 ms CPU latency** | ✅ abstract read |
| **GUIGuard / GUIGuard-Bench** — [arXiv:2601.18842](https://arxiv.org/abs/2601.18842) | **The critique understated this.** v1/v2 do not merely publish a benchmark — they propose **GUIGuard, a three-stage framework for privacy-preserving GUI agents: (1) privacy recognition, (2) privacy protection, (3) task execution under protection.** The bench: 241 real GUI-agent trajectories, 4,080 screenshots, **Android + PC**, region-level privacy bboxes, semantic category, risk level, and *whether the private information is necessary to complete the task*; supports three evaluations — privacy recognition, offline planning fidelity under protected screenshots, and utility impact of different protection methods. | Models "often detect **whether** a screenshot contains private information, but struggle with fine-grained localization, category recognition, risk assessment, and task-necessity judgment" | ✅ |
| **Anonymization-Enhanced Privacy Protection for Mobile GUI Agents: *Available but Invisible*** — [arXiv:2602.10139](https://arxiv.org/abs/2602.10139v2) | Anonymization framework enforcing **"available-but-invisible"**: sensitive data stays usable for task execution while remaining invisible to the model. Evaluated on **AndroidLab + PrivScreen**. | "substantially reduces privacy leakage across multiple models while incurring only modest utility degradation" | ✅ |
| **CAPED** — [arXiv:2606.12666](https://arxiv.org/abs/2606.12666) *(not in the critique — found here)* | **The closest published system to our design intent.** A **phone-side protection layer**: before screenshots are released to a remote multimodal agent it extracts task requirements, uses screen context as a privacy prior, and parses visible fields. | **success-conditioned weighted seeded leakage 0.766 (raw screenshots) → 0.268, "while preserving high task utility"** | ✅ |
| **CaMeL — *Defeating Prompt Injections by Design*** — [arXiv:2503.18813](https://arxiv.org/abs/2503.18813) | Google DeepMind. A **capability-based sandbox** around the LLM with data-provenance tracking and capability policies enforced at the **tool-call boundary**; privileged-LLM / quarantined-LLM split. Code: [google-research/camel-prompt-injection](https://github.com/google-research/camel-prompt-injection). Follow-ups: [arXiv:2505.22852](https://arxiv.org/abs/2505.22852) (operationalizing), [arXiv:2506.08837](https://arxiv.org/html/2506.08837v3) (design patterns with provable injection resistance). | — | ✅ |
| **Sema — Semantic Transport for Real-Time Multimodal Agents** — [arXiv:2604.20940](https://arxiv.org/abs/2604.20940) *(not in the critique)* | Sends semantics instead of raw media to a remote agent. | **64× uplink reduction for audio, 130–210× for screenshots, task accuracy within 0.7 pp of the raw baseline** | 🟡 |
| **PrivScope — Task-scoped Disclosure Control for Hybrid Agentic Systems** — [arXiv:2605.16630](https://arxiv.org/html/2605.16630v1) *(not in the critique)* | Task-scoped disclosure control; 100 medical-booking workflows across three commercial cloud LLMs. | — | 🟡 |
| **VPI-Bench** — [arXiv:2506.02456](https://arxiv.org/abs/2506.02456) | Visual prompt injection against computer-use agents; 306 cases, 5 platforms. | success up to 51% (and 100% in some settings) | 🟡 |
| **REDACT** — [arXiv:2606.19881](https://arxiv.org/abs/2606.19881) | Multilingual PII benchmark. | 13,427 records, 324,078 entity annotations, 51 entity types, 25 languages, 9 scripts | 🟡 |
| **On-device PII substitution with small LMs** — [arXiv:2605.13538](https://arxiv.org/abs/2605.13538) | Local substitution rather than deletion; notes that bare placeholder tokens like `[PERSON]` **destroy downstream utility**. | — | 🟡 |
| **hivekeep `vault-placeholders.md`** — [MarlBurroW/hivekeep](https://github.com/MarlBurroW/hivekeep) | OSS engineering practice already matching M2's shape: the agent writes `{{secret:KEY}}` in any tool argument and a substitution layer inside the tool executor swaps in the real value. | — | 🟡 |
| **helloveil.com** | Commercial "privacy layer for AI": on-device tokenization of names, amounts, case numbers, identifiers — **text only, 22 M parameters**. | — | 🟡 |

### 13.2 ⚠️ RETRACTED 2026-09-05 — this subsection contained a false negative

**What this subsection originally said:** that "Veil-tiny" and "SafeScreen" were fabricated, on the
grounds that three targeted web searches each returned nothing.

**That was wrong. Both artifacts exist.** They were located by going to the registries directly instead
of to a search engine, and both returned HTTP 200 with full primary-source content:

- **`Parergon/Veil-tiny`** — Hugging Face model repository. Verified via the HF API and the raw model card.
- **`thesid42/Safe-Screen`** — GitHub repository. Verified via the GitHub API and the raw README.

Full verified detail, and what each one does and does not establish, is in **§18**. They are now part of
the prior-art matrix (§14.2), not excluded from it.

**The reasoning error, recorded so it is not repeated.** The inference was:

> searched three times → found nothing → therefore it does not exist

That is invalid. Web search indexes small, new, zero-star repositories poorly, and both of these are
exactly that. The only conclusion a failed search supports is **"not verified by search"**. Non-existence
requires a registry-level check — and a registry-level check is cheap: `huggingface.co/api/models/<id>`
and `api.github.com/repos/<owner>/<repo>` each answer definitively in one request. §18.1 makes that
mandatory.

**The one claim in this subsection that still stands:** WebRedact's *"1280×1280 / ~312 ms / 0.842 mAP@50"*
configuration is not in the WebPII abstract, which states only 0.753 vs 0.357 at 20 ms CPU. ❓ Quote the
0.753 figure only, until the paper body is read.

**A second discrepancy now open.** GUIGuard-Bench's size was given as **241 trajectories / 4,080
screenshots** in the abstract I read, and as **630 trajectories / 13,830 screenshots** in a later
external summary. These conflict; possibly a version revision. **Neither figure goes on a slide until the
current abstract is re-read.** Cite GUIGuard's *finding*, which is stable, not its dataset size.

### 13.3 Platform claims — verified, and two of them make our case *stronger*

| Claim | Verdict | Consequence |
|---|---|---|
| **No extension API exposes the browser's accessibility tree.** `chrome.automation` "is currently only available in kiosk mode for ChromeOS" ([Chrome extensions API index](https://developer.chrome.com/docs/extensions/reference/api); [API ref](https://chrome.jscn.org/docs/extensions/reference/automation)); Firefox has no WebExtension equivalent. | ✅ **the critique is right** | §6/§9's "DOM + accessibility tree" is wrong as written. T1 must be re-specified: the content script **reconstructs** accessible semantics (computed role, accessible name, ARIA attributes, focusability, visibility) from the DOM. We never claim to read the browser's own a11y tree. |
| **`captureVisibleTab` is hard rate-limited.** `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`, default **2 calls/second**, with **"no way to increase this value"** ([chromium-extensions thread](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/sQUlaHXjlhY/m/Ng9yU_5iAgAJ)); the quota was added because rapid capture hung the browser ([crbug 40764505](https://issues.chromium.org/issues/40764505)). | ✅ | **This is a gift.** The event-driven trigger policy is not a design preference we have to defend — the platform *forbids* per-frame capture. Say it out loud: "we could not poll frames even if we wanted to." It also caps the worst case for the 20% resource weight and the 15% latency weight. |
| **MV3 disallows cross-origin `fetch` from content scripts**; they must relay through the extension's own worker ([chromium.org — Changes to Cross-Origin Requests in Chrome Extension Content Scripts](https://chromium.org/Home/chromium-security/extension-content-script-fetches)). | ✅ | **This strengthens the invariant instead of weakening it.** The page-side module physically cannot exfiltrate — not by policy, by the browser. See §15.4. |
| **Extension CSP restricts egress destinations.** `content_security_policy.extension_pages` accepts an explicit `connect-src`, and with no `connect-src` the `default-src 'none'` fallback blocks connections outright ([Chrome CSP manifest docs](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy), [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy)). | ✅ | A **declared, browser-enforced allowlist of exactly one server origin**, visible to anyone who reads our manifest. Second enforced layer. |
| **Indian identifier checksums are not uniform.** GSTIN char 15 is a **mod-36 weighted check** ([indpy-core](https://pypi.org/project/indpy-core/0.1.2/), [ashwinbande/validators](https://github.com/ashwinbande/validators)); **PAN has no published checksum** — its 10-char layout and 4th-character entity code are structural only ([PAN format guide](https://tools.town/learn/india-tools/pan-validator-guide/)); **IFSC is structural** (11 chars, position 5 fixed `0`); Aadhaar is **Verhoeff**; payment cards are **Luhn**; IBAN is **MOD-97-10**. | ✅/🟡 | The v1 wording "checksum recognizers: Luhn, Verhoeff, PAN, GSTIN, IFSC, IBAN" is **wrong and catchable**. T2 must expose two tiers — *checksum-verified* vs *structure-verified* — and that tier must flow into the payload as a confidence value (§15.3). |

### 13.4 Still unverified, and therefore absent from the pitch

FastVLM-0.5B-ONNX total repository footprint (the critique's ≈10.7 GB figure — the per-dtype download is
what matters and has not been measured); PaddleOCR.js maturity in-browser; Firefox MV3 event-page DOM
availability (🟡 in §6). None of these may appear as a number on a slide. Model-footprint numbers are
**budgets** until measured on our own machines (measured-vs-budget rule, §16).

---

## 14. Corrected prior-art position — supersedes §3's framing and §8's gap table

### 14.1 What has to be abandoned

§3 concluded that every privacy-preserving-delegation system is **text-only** (Casper, pii-guardrail,
PAPILLON, AirGapAgent), and §8 built a four-property gap table on top of that. **That is no longer true.**
As of 2026 there is a published field of *screenshot-level* privacy for GUI agents:

- a **framework** with our exact three-stage shape — recognise, protect, execute under protection (GUIGuard, [2601.18842](https://arxiv.org/abs/2601.18842));
- a **browser-screenshot visual-PII benchmark plus a working detector** (WebPII / WebRedact, [2603.17357](https://arxiv.org/abs/2603.17357));
- **placeholder substitution that keeps data "available but invisible"** to the remote model ([2602.10139](https://arxiv.org/abs/2602.10139v2));
- **task-necessity-aware redaction before release to a remote multimodal agent**, with a leakage number (CAPED, [2606.12666](https://arxiv.org/abs/2606.12666));
- **capability enforcement at the tool-call boundary** (CaMeL, [2503.18813](https://arxiv.org/abs/2503.18813));
- **semantics-instead-of-pixels transport** with a 130–210× number (Sema, [2604.20940](https://arxiv.org/abs/2604.20940)).

A pitch built on *"nobody has done this"* is one search away from collapse, and the panel for an ISRO
software problem statement will search. **Delete that claim from every document.**

### 14.2 What replaces it — a stronger position, not a weaker one

> ⚠️ **Superseded framing.** The line below was written before Veil-tiny and Safe-Screen were verified.
> **§18.4 replaces it** with a stronger, number-led version. Keep this paragraph for the reasoning; pitch
> §18.4's wording. The table below has been extended with both newly verified systems.

> ~~"The science is settled. The shipping is not. PS171 asks for the part nobody has shipped."~~

This is a better place to stand than "nobody has done this" for three reasons: it cannot be falsified by a
search, it converts the 2026 literature from a threat into our citation base, and it maps one-to-one onto
the PS's own wording. The corrected gap table, now including the two tier-B− artifacts from §18:

| # | Property | GUIGuard | CAPED | 2602.10139 | WebRedact | CaMeL | Casper / pii-guardrail | Presidio-image | OmniParser V2 | **Veil-tiny** | **Safe-Screen** | **Ours** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Runs **inside the browser** (MV3, WebGPU/WASM, no host runtime) | ✗ Android/PC | ✗ phone-side | ✗ phone-side | ✗ CPU host | ✗ server-side | ✓ (text only) | ✗ Python | ✗ desktop CUDA | ✗ weights only, no runtime | ✗ Node + Playwright, drives browser from outside | **✓** |
| 2 | **Cross-engine** — Chrome *and* Firefox, per-backend numbers | ✗ | ✗ | ✗ | ✗ | ✗ | partial | ✗ | ✗ | n/a | ✗ Chromium only | **✓** |
| 3 | Sanitises the **rendered screen**, not just prompt text | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ | ✓ | **✓** |
| 4 | Egress boundary **enforced by the host**, not by a cooperating stage | ✗ | ✗ | ✗ | n/a | ✓ (tool calls) | ✗ | ✗ | ✗ | n/a — no egress | ✗ **smart mode uploads the raw screenshot to a hosted Qwen-VL** | **✓** |
| 5 | Independent **interlock that re-reads its own output and can refuse the send** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ guards *inbound* actions only | **✓** |
| 6 | Closed action loop with **use-once, target-bound** capability redemption | ✗ | ✗ | ✓ substitution, not bound | ✗ | ✓ not screen-bound | ✗ | ✗ | ✗ | ✗ no loop | **✓ loop, ✗ static global `[MY_SSN]` from `.env`** | **✓** |
| 7 | Reported against **PS171's five published weights**, per engine and per backend | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | partial — P/R/F1 + leak-free only | ✗ no evaluation at all | **✓ (planned)** |

Rows 1, 2, 5 and 7 remain empty across the entire field, and **Safe-Screen is the closest anyone gets** —
it fills row 6's loop and then fails row 4 in the most instructive way possible, by getting its vision from
a remote GPU service.

**Corrected structural sentence** (the original said "every one of these systems assumes a host-side
Python/CUDA runtime" — Safe-Screen is TypeScript, so that was wrong): **none of these systems runs its
perception inside the browser's own sandbox.** They are host processes, mobile frameworks, or — in the one
JavaScript case — external automation that drives the browser from outside and ships the screenshot out for
vision. Moving the pipeline *inside* the sandbox is not repackaging: it means no CUDA, a service worker with
no DOM, a ~2 capture/second ceiling with no override, two different WebGPU maturity levels, and a mandatory
WASM fallback. That is the engineering the PS is asking for.

### 14.3 The negative result that becomes our design justification

GUIGuard-Bench's headline finding — current models detect *whether* a screenshot contains private
information but **fail at fine-grained localization, category recognition, risk assessment and
task-necessity judgment**, and it calls privacy recognition "a critical bottleneck" — is the strongest
single citation we have. It converts our tiered, deterministic-first cascade from a performance
optimisation into a **response to a published failure mode**:

- Localization failure → do not ask a VLM to find PII; use text-region and face **detectors** for boxes and let deterministic recognizers own the identifier classes (§15.3, T2–T3).
- Category-recognition failure → categories come from checksum/structure verification, not from model opinion, wherever a checksum exists.
- Risk-assessment failure → risk level is a **policy table** keyed to category and tier, not an inference.
- Task-necessity failure → necessity is decided from the *task string* and the target node, CAPED-style, and defaults to redact.

Say this in one line when asked why the architecture is shaped this way: *"the 2026 benchmark says
models cannot localise or triage privacy reliably, so we only use the model where nothing deterministic
can reach, and we verify the result twice."*

---

## 15. v2 architecture — the version to pitch

### 15.1 The claim, in one paragraph

A browser extension for Chrome and Firefox in which **perception happens on the device and the planner
is structurally denied the pixels.** A local cascade reads the rendered screen, deterministic recognizers
and small detectors localise sensitive regions, and everything that leaves the machine leaves as
**structured text with target-bound placeholders** — never as a raw framebuffer. The server plans; the
client redeems placeholders and acts. What distinguishes this from the 2026 literature is not the idea —
GUIGuard, CAPED and arXiv:2602.10139 established the idea — it is that **the boundary is enforced by the
browser and re-verified by an independent interlock, inside the runtime the problem statement names, on
both engines, measured against the five weights the problem statement publishes.**

### 15.2 Five mechanisms, with their lineage stated honestly

Each mechanism now carries the prior work it descends from. Stating the lineage *first* is what defuses
"isn't this already present" — a judge cannot land a citation we have already put on the slide.

| | Mechanism | Descends from | Our delta — the part that is actually ours |
|---|---|---|---|
| **M1** | **Unified multimodal scene graph, one ID space.** IDs assigned once and shared by the redaction masks and the element list, so image and text can never disagree. Vision is authoritative on visibility and on non-DOM-expressible regions; DOM is authoritative on role and name **when its text matches the pixels**. | OmniParser V2 ([2408.00203](https://arxiv.org/abs/2408.00203)) for screen parsing; GUIGuard's region-level annotation model. | Reconciliation is a **conflict rule with a defined winner per attribute**, and pixel-vs-DOM disagreement is a *reported* quantity, not a silently resolved one. Fixes the v1 bug where masks and the element list used separate ID spaces. |
| **M2** | **Target-bound privacy capabilities.** A placeholder is not a string, it is a **use-once capability redeemable only into the node it was harvested from.** The server can drive a form fill it can never read. | **CaMeL** ([2503.18813](https://arxiv.org/abs/2503.18813)) — capabilities enforced at the tool-call boundary; **"available but invisible"** ([2602.10139](https://arxiv.org/abs/2602.10139v2)); the `{{secret:KEY}}` executor-substitution pattern in [hivekeep](https://github.com/MarlBurroW/hivekeep); **Safe-Screen** (§18.3), a working browser-agent implementation of the loop. | **[FIX 3rd pass]** *Of the implementations we examined*, placeholders are substituted by static type-name — Safe-Screen's `[MY_SSN]` is global, reusable and category-disclosing — so a leaked placeholder is replayable and informative. Ours is bound to **(node identity, session salt, single use, type-generalised)**, which makes a stolen plan inert. Do not generalise this to the whole literature. See §20's M2 table for the four-property comparison. |
| **M3** | **Verified egress firewall — two channels, checked separately.** The **structured channel** is re-scanned by the recognizers; the **visual channel** (attached crops) is re-OCR'd and re-scanned. Either check failing **blocks the send**. | No published GUI-agent privacy system has this; CaMeL's enforcement point is the nearest analogue, and Safe-Screen's action guard checks the *inbound* action, not the outbound payload. | The redactor and the verifier are **different code paths with different inputs**, so a bug in the redactor is not automatically a bug in the check. Do **not** phrase this as "everyone else trusts their own redactor" — phrase it as "we made the check independent of the thing it checks." Third-party justification: Veil-tiny's 86.83% recall vs **33.32% strict leak-free** (§18.2) and GUIGuard's localisation failure. |
| **M4** | **Necessity- and risk-aware perception scheduler.** Perception fires on navigation, DOM mutation and user intent — never per frame — and *what* gets sent is filtered by task-necessity and a risk-level policy table. | **CAPED** ([2606.12666](https://arxiv.org/abs/2606.12666)) for task-requirement extraction and screen context as a privacy prior; GUIGuard-Bench's risk levels and task-necessity labels; **forced** by `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`. | CAPED's necessity judgement runs on a phone with a host runtime; ours runs under a ~2 capture/second platform ceiling and a 20%-weighted resource budget, which changes the design rather than the idea. Session-salted, type-generalised placeholder naming (`<SENSITIVE_07>`, never `<HIV_STATUS_01>`) is demoted from a mechanism to a **property of M2**. |
| **M5** | **[RENAMED by A4 → *Adversarial Egress Verification*.]** The adversarial re-extraction test is promoted from a metric to a standing mechanism: OCR our own sanitised output, run the recognizers over it, count recoverable ground-truth strings, and publish the number every run. *Residual leakage* is its output metric, not its name. | CAPED's leakage score (0.766 → 0.268) gives a comparable; Veil-tiny's **strict leak-free rate** is a published self-attack in the same spirit and we adopt the metric (§18.2); PrivacyPAD ([2510.16054](https://arxiv.org/abs/2510.16054)) forces utility retention to be reported alongside it. | Makes the privacy claim a **number with an attacker in it** rather than a screenshot of a network inspector — and, per A5.2, a **build gate** rather than a one-off evaluation. **Never report it alone** (A7): a fully blacked-out screen scores zero leakage. |

### 15.3 The corrected cascade T0–T6

Changes from v1 are marked **[FIX]**.

| Stage | What it does | Cost | Notes |
|---|---|---|---|
| **T0 Trigger** | Navigation, DOM mutation, or explicit user intent. **[FIX]** Hard-capped by the platform: `captureVisibleTab` allows ~2 calls/second and the limit cannot be raised, so a per-frame design is impossible by construction, not by choice. | ~0 | Debounce + coalesce mutations; one capture per settled state. |
| **T1 Harvest** | Viewport-clipped structural read: DOM text, form state, and **[FIX] reconstructed** accessible semantics — computed role, accessible name, ARIA attributes, focusability, visibility — assembled in the content script. **We do not claim to read the browser's accessibility tree; no cross-platform extension API exposes it** (`chrome.automation` is ChromeOS-kiosk-only). | ~0, no model | Also records *what it could not explain*, which is the input to T3/T4. |
| **T2 Recognise** | Deterministic recognizers over harvested text, in **[FIX] two explicit confidence tiers**. **Checksum-verified:** payment cards (Luhn), Aadhaar (Verhoeff), IBAN (MOD-97-10), GSTIN (mod-36 weighted). **Structure-verified:** PAN (10-char layout + 4th-char entity code — *no published checksum exists*), IFSC (11 chars, position 5 fixed `0`), email, phone, DOB, and the high-value cases v1 under-specified: **revealed passwords via show-password toggles, OTP/2FA codes in plain text fields, and autofill overlays**. | ~0, no model | The tier is carried into the payload as a confidence value. `input[type=password]` alone is a checkbox, not a finding. |
| **T3 Propose** | Region proposal: a **text-region detector** (PP-OCRv4 det, ONNX — largely language-agnostic) plus a **face detector** (MediaPipe). Proposes boxes; does not read them. | small, fixed | Published justification for coarse→fine: ScreenSeekeR reaches **48.1%** on ScreenSpot-Pro versus the best existing model's **18.9%**, purely by search-area reduction with no extra training ([2504.07981](https://arxiv.org/abs/2504.07981)). Attribute this to the ScreenSpot-Pro authors, not to us. |
| **T4 Read** | OCR + NER **only on regions T1 could not explain**. | proportional to unexplained area | Keeps the model off the 90%+ of the screen the DOM already describes correctly. |
| **T5 Ground** | A grounded VLM, invoked rarely, for regions that need semantics rather than transcription. **[FIX]** Model choice is a **budgeted decision, not a fixed pick**: FastVLM-0.5B q4 if its measured footprint fits, otherwise the detector-only path. **[FIX 3rd pass]** `Parergon/Veil-tiny` **does exist** (§18.2) but is not a candidate here: it is a 384×384 binary segmenter with no license, no eval code and a 33.32% strict leak-free rate — cite it, never depend on it. | rare | Feasibility precedent stands: Apple's own `apple/fastvlm-webgpu` Space runs FastVLM 100% in-browser via Transformers.js. |
| **T6 Reconcile + gate** | Merge into M1's single ID space, apply M4's necessity/risk filter, then **M3 re-reads the outgoing payload on both channels and may refuse the send**. | small | The only stage permitted to touch the network. |

### 15.4 The enforcement stack — four layers, three of which are not ours

> ⚠️ **Layers 1, 2 and 4 are restated by §19 A1/A2/A5 and A1 wins.** Layer 1's wording below is imprecise
> (a content script *can* reach an origin that opts in via CORS); layer 2 must be "declared destination
> policy," not impossibility; layer 4 gains the two machine-checkable invariants from A5. Read A1 before
> putting any of this on a slide.

This replaces v1's single sentence ("`gate` is the only module that can reach the network"). The v1 claim
was an application-level convention; the real platform gives us more than that, and saying so precisely
is what makes the privacy property *inspectable* instead of *promised*.

| Layer | Enforced by | What it prevents | How a judge verifies it in 30 seconds |
|---|---|---|---|
| 1. Content script cannot make cross-origin requests | **The browser.** MV3 disallows cross-origin `fetch` from content scripts; they must relay through the extension's own worker ([chromium.org](https://chromium.org/Home/chromium-security/extension-content-script-fetches)). | The module that touches the page and the framebuffer cannot exfiltrate **even if it is buggy or compromised**. | Read our manifest; then read Chromium's own security page. |
| 2. Egress destinations are a declared allowlist | **The browser.** `content_security_policy.extension_pages` with an explicit `connect-src` naming exactly one server origin; with no `connect-src`, `default-src 'none'` blocks connections outright. | The extension cannot connect anywhere except the one declared server — no analytics, no third party. | `connect-src` is one line in a manifest anyone can read. |
| 3. Host permissions are minimal and capture is user-initiated | **The browser.** `activeTab` rather than `<all_urls>` where possible — and `activeTab` is the only path that reaches restricted pages (needs Firefox ≥ 126, since Firefox ≤ 125 required `<all_urls>`). | Silent background capture of arbitrary tabs. | The permission prompt the user sees. |
| 4. Raw framebuffer never crosses the module boundary; the interlock re-verifies | **Us** — and this is the only layer that is ours, so it is the only one that needs the independent check in M3. | A redactor bug turning into a disclosure. | Network inspector shows placeholders; M5 reports what an attacker could still recover. |

**The line to say:** *"Three of the four layers are enforced by the browser, not by our code. We only had to
build the fourth, and we test it by attacking it."* That sentence is the whole defence against "it's just a
wrapper" — a wrapper adds a layer of code; this adds a layer of *enforcement* and then measures the residue.

### 15.5 Wire contract v2

Structured-text-first, crops only by exception. Sema ([2604.20940](https://arxiv.org/abs/2604.20940))
gives this a published number to cite: sending semantics instead of raw screenshots cut uplink
**130–210×** with task accuracy within **0.7 pp** of the raw baseline. So the common case needs only a
**text-only open-weights server model**; a VLM is required for the crop path alone.

Additions over v1, each traceable to a finding above:

```jsonc
{
  "task": "pay the electricity bill",
  "nodes": [
    { "id": 42, "role": "textbox", "name": "Email",
      "value": "<CONTACT_03>",              // M2 capability: use-once, bound to node 42
      "tier": "structure",                   // T2 fix: checksum | structure | model
      "confidence": 0.86,
      "necessary": true }                    // M4 / CAPED: necessity decided locally
  ],
  "crops": [                                  // only non-DOM-expressible AND task-necessary
    { "id": 77, "reason": "canvas", "px": [x,y,w,h] }
  ],
  "coverage": {                               // self-report, explicitly not a proof
    "screen_px": 2073600, "vision_only_px": 41820,
    "redacted_regions": 6, "risk_max": "high",
    "gate": { "structured": "passed", "visual": "passed" },
    "residual_leak_last_run": 0.0            // M5, measured not asserted
  }
}
```

Two caveats to state before a judge states them: the `coverage` block is **our own report about
ourselves**, so it is evidence of design intent and useful for debugging, not proof — the proof is M5's
adversarial number. And `confidence`/`tier` exist so the server can behave differently on a
checksum-verified Aadhaar than on a regex-matched name.

### 15.6 Executor safety — unchanged in intent, sharpened by VPI-Bench

Server-returned actions plus page-controlled content is a confused-deputy problem, and it is now
quantified: **VPI-Bench** ([2506.02456](https://arxiv.org/abs/2506.02456)) reports visual prompt injection
against computer-use agents succeeding **up to 51%**, and 100% in some settings. So the executor is:
a **typed action allowlist** (no `eval`, no arbitrary script), **capability redemption client-side only**,
**human confirmation for destructive steps**, and **page text treated as data, never as instruction**.
CaMeL's design-pattern paper ([2506.08837](https://arxiv.org/html/2506.08837v3)) is the citation for why
this shape is the one with provable resistance rather than a heuristic filter.

### 15.7 What we explicitly do not claim — say these before you are asked

1. Not the first browser agent. Operator, Claude in Chrome, Gemini in Chrome and Comet ship today.
2. Not the first screenshot PII redactor. WebRedact does it better on a benchmark it built.
3. Not the first privacy-preserving GUI-agent framework. GUIGuard published that shape in January 2026.
4. Not the first placeholder-substitution scheme. arXiv:2602.10139 and CaMeL got there first.
5. Not a new model. We compose published detectors and an open-weights server model.
6. **[3rd pass]** Not the first **visual PII detector for web screenshots** — WebRedact and `Parergon/Veil-tiny` exist, and Veil-tiny's numbers will beat a first-pass detector of ours (§18.2).
7. **[3rd pass]** Not the first to **close the placeholder loop for a browser agent** — `thesid42/Safe-Screen` did it in a weekend, in TypeScript, and we cite it ourselves (§18.3).
8. **[3rd pass, A3]** Not a claim of **zero inferential disclosure.** `PERSON_17` plus age, city and college can re-identify. What we claim: raw protected values never leave the device, and every server-visible representation is a deliberate, enumerable disclosure under an explicit policy.

**What is left after all eight concessions is still the answer to PS171:** in-browser, cross-engine, no
privileged network access on the page side, an independent outbound verifier on two channels, and a
residual-leakage number produced by attacking our own output. **Conceding seven things you did not need is
what makes the eighth land as a fact rather than a boast.**

---

## 16. Benchmark and metric plan, v2 — one instrument per published weight

The 2026 literature supplies datasets and comparables §7 did not have. Every row now has an external
number to be measured against, which is what turns the 20%+20%+25% privacy/perception block from a claim
into a score.

| PS weight | Instrument | External comparable to report beside ours |
|---|---|---|
| Visual context accuracy **25%** | ScreenSpot-Pro + ScreenSpot web split; VisualWebArena subset for end-to-end task success | best existing grounding **18.9%**; ScreenSeekeR **48.1%** via search-area reduction ([2504.07981](https://arxiv.org/abs/2504.07981)) |
| PII detection recall + precision **20%** | **WebPII** (web screenshots — the correct benchmark, and it did not exist when §7 was written); **GUIGuard-Bench** privacy-recognition split; **REDACT** for multilingual coverage | **WebRedact 0.753 mAP@50 vs 0.357 baseline at 20 ms CPU** ([2603.17357](https://arxiv.org/abs/2603.17357)) |
| Redaction precision **20%** | pixel IoU against labelled regions; **over-redaction area**; and **M5 adversarial re-extraction** as the headline | **CAPED: leakage 0.766 → 0.268 with high task utility** ([2606.12666](https://arxiv.org/abs/2606.12666)) |
| Client-side resource utilisation **20%** | VRAM, RSS, CPU%, disk; **four configurations: Chrome+WebGPU, Chrome+WASM, Firefox+WebGPU, Firefox+WASM**, cold vs warm | none published — nobody else runs in a browser, so this is an uncontested row |
| End-to-end latency **15%** | p50 and p95 per configuration, same traces | WebRedact's 20 ms CPU detector is the per-stage reference |
| *(guard-rail, not a weight)* | **Utility retention** reported next to every redaction number, so blacking out the screen cannot look like a win | PrivacyPAD ([2510.16054](https://arxiv.org/abs/2510.16054)); [2504.12308](https://arxiv.org/abs/2504.12308) — published PII metrics do not replicate, so measure ourselves |
| *(guard-rail)* | Injection resistance of the action loop | **VPI-Bench up to 51%** ([2506.02456](https://arxiv.org/abs/2506.02456)) |

**The one metric to lead with:** residual leakage after sanitisation, measured by attacking our own
output. It is the only number that is simultaneously the privacy claim, the redaction-precision score, and
a demo. CAPED's 0.268 gives the audience a scale to read ours against.

**Rule that stays in force:** measured numbers carry a source; anything we have not run is labelled a
**design budget**. On 2026-09-16 we have no measurements, so every number of ours on a slide is a budget
and must be visibly marked as one.

---

## 17. What the deck must change (`content.md` was written pre-critique)

| Slide | Change | Reason |
|---|---|---|
| 2 — Proposed Solution | Replace "every shipping browser agent sends the screen to a remote model" as the *whole* gap with the two-part gap: agents send the screen **and** the 2026 privacy work that fixes it is all host-side, off-browser. Keep the four-step approach. | §14.1 — the sole-novelty framing is falsifiable. |
| 3 — Technical Approach | T1 wording: "DOM + accessibility tree" → "DOM + reconstructed ARIA semantics". T2 wording: split into **checksum-verified** (Luhn, Verhoeff, IBAN, GSTIN) and **structure-verified** (PAN, IFSC) — do not call PAN or IFSC checksums. Add the ~2 capture/second platform ceiling as the reason T0 is event-driven. | §13.3 — all three are catchable errors, and the capture ceiling is an asset. |
| 4 — Feasibility | Keep Apple's in-browser FastVLM precedent. Add the **four-configuration** measurement matrix (Chrome/Firefox × WebGPU/WASM). Replace the generic risk list's first row with the *real* biggest risk: **redaction recall**, mitigated by tiered recognizers + the independent interlock + the M5 attack test. | §16; the critique's closing point, which is correct. |
| 5 — Impact | Unchanged in substance. ISRO relevance is still the strongest framing: organisations forbidden from sending screen contents to an externally hosted model currently cannot use browser automation at all. | — |
| 6 — References | **Rewrite entirely.** The current "nobody does this" tick matrix is the deck's weakest slide and its most attackable. Replace with §14.2's table: nine real systems, seven properties, and the four rows that are empty for everyone. Cite GUIGuard, CAPED, WebPII, 2602.10139 and CaMeL **ourselves**, first. | §14.2 — pre-empting the citation is stronger than being shown it. |
| Prepared answers | Rewrite "Isn't this just a wrapper?" around the four-layer enforcement stack ("three of the four layers are the browser's, not ours"). Add a new answer for **"GUIGuard/CAPED already do this"**. Delete any phrasing like "every other system trusts its own redactor". | §15.4, §15.7. |
| Everywhere | Add nothing whose URL is not in §12, §13.1 or §18, and record its tier (§18.1 Rule 3). | §18.1. |

> ⚠️ **§17 is amended by §21.** Three rows above were written before Veil-tiny and Safe-Screen were
> verified: the row for Slide 6, the "Prepared answers" row, and the "Everywhere" row (which originally
> said those two names *"must never appear"* — the opposite is now true; **we cite them ourselves**).
> Work from §21, then §17.

---

## 18. Citation and artifact verification protocol (added 2026-09-05, third pass)

This section exists because §13.2 got a verdict wrong in the most damaging possible direction — it
declared two real, openable artifacts fabricated. The protocol below is the fix, and §18.2–§18.3 are the
corrected entries. §18.4 is the part that matters strategically: **both artifacts, read properly, argue
*for* this architecture rather than against it.**

### 18.1 The protocol

**Rule 1 — a failed search yields exactly one verdict: "not verified by search."** Never "does not
exist," never "fabricated." Search engines under-index new, zero-star, single-author repositories, and
that is precisely the class of artifact a critique is most likely to surface.

**Rule 2 — before any non-existence claim, hit the registry directly.** One request each, definitive:

| Artifact type | Authoritative endpoint | A 404 here is meaningful; a search miss is not |
|---|---|---|
| Hugging Face model | `huggingface.co/api/models/<owner>/<name>` | ✓ |
| Hugging Face dataset | `huggingface.co/api/datasets/<owner>/<name>` | ✓ |
| GitHub repo | `api.github.com/repos/<owner>/<repo>` | ✓ |
| arXiv paper | `arxiv.org/abs/<id>` | ✓ |
| npm / PyPI package | `registry.npmjs.org/<pkg>` · `pypi.org/pypi/<pkg>/json` | ✓ |

Registry APIs also return the provenance fields that decide how much weight the artifact carries —
`created_at`, `pushed_at`, `lastModified`, `downloads`, `stargazers_count`, `license`, `model-index`.
Fetch the API, not the rendered page: the page is megabytes of HTML, the API is a few kilobytes.

**Rule 3 — provenance tiers. Every cited name carries its tier.**

| Tier | Meaning | Weight in argument | May appear on a slide? |
|---|---|---|---|
| **A** | Peer-reviewed / accepted venue | Load-bearing | Yes |
| **B** | Official artifact — arXiv preprint, vendor doc, standards text, or a real repo/model with adoption signal | Load-bearing, tier stated | Yes |
| **B−** | Real, openable artifact, **no adoption signal** — 0 downloads/stars, single-session history, no license, no evaluation | Existence proof only. May be cited as *evidence* or *baseline candidate*; may **never** be described as established prior art, and may **never** be a dependency | Yes, with the qualifier said aloud |
| **C** | Project page, blog, tech report by the authors | Supporting colour | Only with the source named |
| **D** | Search snippet, secondary summary, another model's claim | Not citable | No |
| **E** | Not verified by search or registry | Not citable, **not refutable either** | No |

**Rule 4 — separate existence from maturity from suitability.** These are three independent questions,
and the §13.2 failure plus the over-correction that followed it both came from collapsing them. An
artifact can be real (existence ✓), abandoned after five hours (maturity ✗), and unusable as a component
because it has no license (suitability ✗) — all at once. That is the actual status of both artifacts below.

**Rule 5 — the slide gate, tightened.** A name goes on a slide only if (a) its URL is recorded in §12,
§13.1 or §18, (b) its tier is recorded, and (c) every number quoted next to it was read in the abstract,
model card, README or doc — not in a summary of one. Figures that exist only in a secondary summary are
tier D and stay off the slide, however plausible. Two live examples of exactly that trap: WebRedact's
"0.842 / 312 ms" and GUIGuard's "630 trajectories / 13,830 screenshots" (§13.2).

### 18.2 `Parergon/Veil-tiny` — REAL. Tier B−. Our best piece of evidence.

**Source:** [huggingface.co/Parergon/Veil-tiny](https://huggingface.co/Parergon/Veil-tiny) ·
API [huggingface.co/api/models/Parergon/Veil-tiny](https://huggingface.co/api/models/Parergon/Veil-tiny)

**What it is (from the model card, verbatim facts):** a **321,305-parameter** binary sensitive-region
segmentation model. Input **384×384 RGB**, output a per-pixel sensitivity probability map. Depthwise-
separable convolutional encoder with a top-down decoder, produced by **knowledge distillation from a
1,224,497-parameter teacher**. Shipped as `veil_tiny.onnx` + `veil_tiny.pt`. Trained on **WebPII's 40,384
training screenshots** plus 10,000 synthetic desktop screenshots generated by the author.

**Its reported results on held-out WebPII — read these carefully, they are the point:**

| Threshold | Precision | Recall | F1 | **Strict leak-free rate** |
|---|---|---|---|---|
| 0.10 (most paranoid, the card's headline) | 74.70% | **86.83%** | 80.31% | **33.32%** |
| 0.50 | 81.19% | 83.82% | 82.48% | 22.38% |

**"Strict leak-free" is the author's own metric and their own definition:** a screenshot counts as
leak-free only when *essentially every* annotated sensitive region is covered — missing a visible part of
even one region fails the whole screenshot. Their justification, quoted: *"A privacy model should not get
credit for blurring most of your API key."*

**So: 86.83% pixel recall coexists with a 33.32% whole-screenshot success rate.** A purpose-built visual
privacy model, trained on the benchmark for this exact task, fully sanitises **one screenshot in three**.

**The author's own two disclaimers, both quoted in the card:**
1. *"Veil-tiny is a research model, not a privacy guarantee. It can miss sensitive content and should not
   currently be used as the sole privacy or security control protecting private information."*
2. Documented failure mode — **over-redaction on unfamiliar dense-text UIs**: it blacks out menu labels,
   documentation, filenames and source code, because *"sometimes a tiny model learns: lots of text =
   suspicious."*

**Provenance (HF API, why it is B− and not B):** `createdAt` **2026-08-07T12:33:17Z**, `lastModified`
**2026-08-07T12:40:25Z** — created and finished **seven minutes apart**, untouched since. **downloads 0,
likes 0.** `model-index: null`. Four files only (`.gitattributes`, `README.md`, and the two weights);
**no config, no preprocessing code, no training code, no eval script.** `usedStorage` 2,723,908 B (≈2.7 MB).
**No license declared** — neither in the card frontmatter nor as an API tag.

**Consequences for us — and this is where I disagree with the critique that surfaced it.** The critique
proposed adopting Veil-tiny as our T3 first-stage detector. Do not:

- **No license = we cannot ship it.** Undeclared license means all rights reserved by default. A
  deliverable extension that redistributes these weights is a legal defect a judge can find in one click.
- **Zero downloads, no training or eval code, abandoned in one session** — unreproducible and unmaintained.
- **384×384 input** on a 1920×1080 screen is a ~5× downsample. Small targets — a 32×32 avatar, an 11 px
  account number — are the first thing destroyed. Wrong operating point for our T3.
- **Its documented failure mode is fatal on our target use case.** "Lots of text = suspicious" applied to
  an ISRO mission-operations console, a telemetry table or a log viewer blacks out the working screen.
  Utility retention goes to zero on precisely the dense-text UI PS171 implies.

**What it is instead: the strongest citation in this document.** Use it as (a) published third-party
evidence that a pixel-only detector cannot be the privacy control — which is the justification for M3 and
M5; (b) published third-party evidence that over-redaction is the real failure mode — which is the
justification for reporting utility retention beside every redaction number; and (c) a **numeric baseline
we reproduce ourselves** on WebPII, if time allows, rather than a component we depend on.

### 18.3 `thesid42/Safe-Screen` — REAL. Tier B−. Concede the loop; it does not touch on-device vision.

**Source:** [github.com/thesid42/Safe-Screen](https://github.com/thesid42/Safe-Screen) ·
API [api.github.com/repos/thesid42/Safe-Screen](https://api.github.com/repos/thesid42/Safe-Screen)

**What it is (from the README):** a TypeScript/Node pipeline that puts a redaction layer between a browser
and a computer-use agent.

```text
Kernel browser screenshot
  -> local DOM-assisted SafeScreen redactor
  -> redacted screenshot with sticky-note labels
  -> Lightcone / Northstar CUA (Tzafon) or mock client
  -> SafeScreen action guard
  -> local placeholder substitution or privacy-safe answer logging
  -> Kernel/local browser execution when an action is needed
```

Placeholders are the fixed set `[MY_NAME]`, `[MY_EMAIL]`, `[MY_PHONE]`, `[MY_SSN]`, `[MY_ADDRESS]`,
`[MY_CARD]`, populated from `.env` (`SAFE_SCREEN_MY_EMAIL=…`). Modules: `redactor.ts`, `actionGuard.ts`,
`vault.ts`, `kernelClient.ts`, `tzafonClient.ts`, `demoScenarios.ts` (`multistep`, `statement`, `profile`,
`health`). Console approval is required before a submit click.

**What we must concede, out loud, on the novelty slide.** Closed-loop placeholder substitution for a
browser agent — redact before the model sees it, substitute the real value locally at execution time,
guard the returned action, keep real values out of logs — **is prior art at the implementation level.**
Anyone claiming to have invented that loop is wrong, and this repo is the proof. Say so first.

**What it does *not* establish — and this is decisive, because it is the whole of PS171:**

1. **It is not a browser extension.** `kernelClient.ts` drives **Kernel's hosted browser or local
   Playwright Chromium** from an external Node process. No MV3, no content script, no WebGPU, no
   in-page perception, no Firefox, no `activeTab`. It is external browser automation — the architecture
   PS171 does not ask for.
2. **Its two modes are exactly the dichotomy we exist to break.** *Local mode* is **rule-based only** —
   Playwright reads visible DOM text plus bounding boxes and `sharp` draws overlays; **there is no local
   vision model at all.** *Smart mode* gets vision by **sending the raw local screenshot plus DOM metadata
   to a Brev-hosted `Qwen/Qwen3-VL-4B-Instruct` service**, which the README declares *"inside the privacy
   boundary."* So it is either **no vision, or vision by trusting a remote GPU with the raw framebuffer.**
   PS171 asks for the third option neither mode provides: **vision, on-device, in the browser.**
3. **Its placeholders are static, global, and type-naming.** `[MY_SSN]` is the same string in every
   session, is not bound to a node, is reusable, and **discloses the category** — it tells the server an
   SSN is on this screen. Values are pre-declared in `.env`, so it protects a known list of the user's own
   values rather than whatever sensitive data happens to be on an arbitrary page. This is precisely the
   linkability and single-use problem M2 addresses, and the type-disclosure problem M4 addresses.
4. **No evaluation of any kind.** No metrics, no benchmark, no dataset — a manual "Verification Checklist"
   of demo steps. It establishes that the *pattern* exists. It establishes no *result*, so it cannot be
   compared against on any of PS171's five weighted criteria.

**Provenance (GitHub API, why it is B−):** `created_at` **2026-05-09T17:46:17Z**, `pushed_at`
**2026-05-09T22:59:58Z** — the entire codebase landed in one ~5-hour window and has not been pushed to
since (`updated_at` 2026-09-03 is metadata only). **0 stars, 0 forks, 0 watchers. No license. No
description, no topics, no releases.** 144 KB, TypeScript. The README itself says *"during the hackathon
demo"* and ships a `SAFE_SCREEN_DEMO_PROGRESS_OVERRIDE` that converts a repeated click into a keystroke
when the real CUA stalls — it self-identifies as hackathon-weekend code.

**Correcting the over-correction.** The critique described this as *"16 commits, with active development
history"* and *"not an abandoned stub."* The registry disagrees: creation and last push are the same
evening. Both readings were wrong in opposite directions — mine said fabricated, the critique's said
established. The verified answer is **real, single-session, zero-adoption**, which is tier B−.

### 18.4 Net effect of the correction: the position gets stronger, not weaker

Two artifacts that were supposed to close the gap turn out to be the two best pieces of evidence for the
architecture. This is not spin — it follows from their own published numbers and their own README.

**Veil-tiny supplies the thesis.** A dedicated visual privacy model, trained on the benchmark for this
exact task, fully sanitises **33.32% of screenshots** at its most paranoid threshold, and its author writes
that it *"should not be used as the sole privacy or security control."* Therefore a pixel-only detector
cannot *be* the privacy control. Therefore you need what §15 specifies: deterministic structural coverage
owning every case it can own (M1), the detector demoted to a *proposer* (T3), and an **independent
verifier that re-reads the outgoing payload and can refuse the send** (M3), with the residual leak measured
by attacking your own output (M5). A third party's numbers now justify the design instead of our assertion.

**Safe-Screen supplies the gap.** Its local mode has no vision; its vision mode ships the raw screenshot
to a hosted Qwen-VL service. **The published state of the art is "no vision, or vision off-device."**
PS171's title is *On-device Visual Perception for Light-weight Browser Agents* — it is asking for the
option that is missing, and the closest real implementation demonstrates its absence by conceding it.

**Replace the "science is settled, shipping is not" line.** That framing was a defensive concession. Lead
with the number instead:

> **"The best purpose-built visual privacy model we could find leaks part of a sensitive region on two out
> of three screenshots — and its own author says it must not be the only control. So we did not try to
> build a better detector. We built the system that makes an imperfect detector safe enough to hand your
> screen to an agent."**

Every clause is third-party-sourced, it concedes the detector race entirely, and it makes the architecture
*necessary* rather than *novel* — which is a far harder claim to attack than novelty.

**Second line, for the "just a wrapper" attack** (replaces the weaker phrasing in §15.4):

> **"The agent acts on your private data without ever receiving it."**

**Scoped novelty claim — say exactly this and nothing broader.** Not "nobody has done this." Instead:

> *"Of the systems we found — GUIGuard, CAPED, WebRedact, Available-but-Invisible, PrivScope, CaMeL,
> Veil-tiny, Safe-Screen — none is a WebExtension-resident privacy boundary on both engines, and none
> reports adversarial re-extraction against its own sanitised output as a standing metric. Two of them are
> mobile, one is a detector with no agent loop, one is external Playwright automation whose vision mode
> uploads the raw screen, and one is a text-only capability system."*

That sentence is checkable line by line, which is the point. It survives a judge with a laptop.

**Two corrections to earlier wording that Safe-Screen forces:**

- §14.1's *"all of these systems assume host-side Python/CUDA"* is **wrong** — Safe-Screen is
  TypeScript/Node. Restate as: *"none of them runs its perception inside the browser's own sandbox; they
  are host processes or mobile frameworks, and where one is JavaScript it drives the browser from outside
  and sends the screenshot out for vision."*
- Any phrasing implying prior work *only* substitutes by type-name is too sweeping. Safe-Screen does use
  type-named globals, but state that as **an observed property of the artifacts examined**, with the delta
  being M2's node-binding, session salt and single use — not as a universal claim about the literature.

---

## 19. Amendments to §15 and §16 (third pass, 2026-09-05)

§15 and §16 stand except where a numbered amendment below replaces text. Each amendment says what it
replaces. Amendments A1–A3 come from new primary-source verification; A4–A9 are accepted refinements.

### A1 — the egress claim, now verified on both engines and stated correctly

**Replaces §15.4 layer (1) and any sentence of the form "MV3 forbids cross-origin fetch from content
scripts."** That phrasing was close but imprecise in a way a judge could break. The verified position is
better, and it is now confirmed for **both** engines from Mozilla's own documentation:

MDN, *Content scripts* → *XHR and Fetch*, verbatim:

> *"In Chrome, starting with version 73, and Firefox, starting with version 101 when using Manifest V3,
> content scripts are subject to the same CORS policy as the page they are running within. **Only backend
> scripts have elevated cross-domain privileges.**"*

MDN, *manifest.json/host_permissions* → the privileges granted by a host permission, verbatim:

> *"XMLHttpRequest and fetch access to those origins without cross-origin restrictions, **but not for
> requests from content scripts.**"*

And the exception that must be said out loud, MDN *Content scripts*, verbatim:

> *"When using Manifest V3, content scripts can perform cross-origin requests **when the destination
> server opts in using CORS**; however, host permissions don't work in content scripts, but they still do
> in regular extension pages."*

**So the correct claim, which is now engine-symmetric:** in MV3 on Chrome ≥ 73 and Firefox ≥ 101, the
page-side module holds **no elevated cross-domain privilege of any kind** — it is confined to the page's
own CORS policy, and our host permissions do not extend to it. It can therefore reach exactly one class of
destination: an origin that explicitly opts in with CORS headers. **Our server does not send permissive
CORS headers.** Consequence: the page-side module physically cannot deliver a payload to our server. All
egress must transit the background/extension-page context, which is where the M3 gate lives, and which is
additionally pinned by `connect-src`.

Say it this way, and the ChatGPT objection ("don't claim browser-enforced, Firefox differs") is answered
with a version number rather than a hedge:

> *"The page-side half of the extension has no privileged network access on either engine — Chrome since
> 73, Firefox since 101 under MV3, documented by Mozilla. Reaching our server at all requires the
> privileged half, and the privileged half is the gate."*

**Amendment to layer (2), CSP.** Do not say CSP "makes exfiltration impossible." Say: *`connect-src`
declares, in a file the judge can read in our submitted manifest, the single network destination our
extension pages are permitted to open* — a declared and enforced destination policy, not a proof of
impossibility. Both statements are defensible; only the second is true.

**Bonus, browser-enforced, supports §15.6.** MDN states plainly that **`eval()` is not available in
Manifest V3**. The "no `eval`, typed action allowlist" property of the executor is therefore partly a
platform guarantee, not only a coding convention.

### A2 — the framebuffer invariant, restated at the boundary that matters

**Replaces** "the raw framebuffer never leaves `perceive`" wherever it appears.

> **The raw framebuffer never crosses the browser→server trust boundary.**

Rationale: the module-boundary version invites a pedantic and winnable attack ("your own decoder holds the
bitmap, so it *did* leave"). The trust-boundary version is the property that actually protects the user, is
the one the four layers enforce, and is testable by inspecting every outbound payload. State the internal
rule separately as an implementation discipline, not as the security claim.

### A3 — the security objective, restated to survive the linkage attack

**Replaces** any phrasing of the form "the server learns nothing" or "capability without disclosure."

Those are false and a sharp judge will say so: `PERSON_17` plus "age 23", "Bengaluru", "third-year ISE" can
re-identify a person with no name present at all. Placeholders defeat *literal* disclosure, not *inferential*
disclosure. The honest and still-strong objective:

> **Raw protected values never leave the device, and every server-visible representation of them is a
> deliberate, enumerable disclosure governed by an explicit policy.**

This is stronger in practice because it is auditable: for any run we can list exactly what the server saw
and why each item was necessary. Add it to §15.7's non-claims: **we do not claim zero inferential
disclosure; we claim the disclosure set is explicit, minimal and inspectable.** Volunteering this before
being asked is worth more than the concession costs — and it is what makes M4's necessity test load-bearing
rather than decorative, since minimising the disclosure set *is* the necessity test.

### A4 — M5 renamed, and the M3/M5 boundary made explicit

**Replaces the M5 row in §15.2.** M5 becomes **Adversarial Egress Verification**; *residual leakage* is
its output metric, not its name. Mechanisms are things that run; metrics are things they emit, and
naming a mechanism after its metric was a category error.

| | **M3 — Verified Egress Firewall** | **M5 — Adversarial Egress Verification** |
|---|---|---|
| Role | **Enforces.** Blocks. | **Attacks.** Quantifies. |
| Runs | Inline, every send, both channels | Offline / in CI, and as a standing regression gate |
| Method | Independent re-read of the outgoing payload by code that is not the redactor | Re-extraction: OCR + NER + template matching run *against our own sanitised output*, as an adversary would |
| Failure output | Refuse the send | A number: residual leakage, plus the specific screenshot that leaked |
| One-liner | *"A different piece of code has to agree before anything leaves."* | *"We attack our own output and publish what we recover."* |

The pairing is the point: M3 without M5 is an unmeasured claim; M5 without M3 is a report with no
remedy. Veil-tiny (§18.2) is the published evidence that the pair is necessary — 86.83% recall and
33.32% strict leak-free from the *same* model on the *same* test set is exactly the gap M3 catches and M5
measures.

### A5 — make two architectural claims machine-checkable

Accepted from the critique, and this is the highest-value cheap addition in it: an architectural claim a
panel can verify beats an architectural claim they must believe.

**A5.1 — a type the raw value cannot enter.** The server-facing payload is built only from a closed union,
so an attempt to place a raw sensitive value into it is a compile error, not a code-review miss:

```ts
type ServerVisibleValue =
  | { kind: "placeholder";   token: string }        // M2 capability, opaque, salted, single-use
  | { kind: "semanticLabel"; label: string }        // e.g. "date, dd/mm/yyyy" — shape without content
  | { kind: "nonSensitive";  literal: string };     // passed T2/T3/T4 and the gate

type PrivateCapability = { token: string; targetNode: NodeId };  // never serialised outbound
// Redemption is client-side only: token + targetNode -> real value, once, in the executor.
```

**A5.2 — a CI check that the gate is the only exit.** A repository rule, run on every commit: no
`fetch(`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `navigator.connection` or `EventSource` outside
`src/gate/`. It fails the build otherwise. Two sentences on the slide, and the answer to *"how do I know
your other module doesn't just POST the screenshot?"* becomes *"the build refuses to produce an artifact
in which it could."*

Both belong in §15.4 as **layer 4's evidence**, since layer 4 is the only one of the four that is ours.

### A6 — T3 detector plan: size bands, and baselines we reproduce rather than depend on

**Amends §15.3 T3 and §13.4.**

**Benchmark by target size band, not in aggregate.** Screen PII is small: a 32×32 avatar, an 11 px account
number, a 14 px email in a form field. A detector's aggregate mAP hides total failure on the smallest band,
and the smallest band is where the leak is. Report three bands separately — **< 16 px, 16–48 px, > 48 px
in the shorter dimension** — for both text regions and faces.

**Faces specifically:** MediaPipe BlazeFace and its relatives are trained for camera-framed faces of
roughly 100–250 px. Web faces are thumbnails. Do not assume transfer — measure it in the < 48 px band
before committing, and if it fails, treat small faces as a structural problem (image elements inside
identity-bearing containers) rather than a detection problem.

**Veil-tiny's 384×384 input is the cautionary case, quantified.** At 384×384 a 1920×1080 screen is
downsampled ~5×; an 11 px digit becomes ~2 px. That, not model capacity, is the likeliest cause of its
33.32% strict leak-free rate. **Design consequence: T3 runs on tiles at native or near-native resolution,
not on a downscaled full screenshot.** Tiling is also what makes the 2/s capture cap survivable — we
re-run T3 only on changed tiles.

**Baselines to reproduce, dependencies to avoid.** Report WebRedact's 0.753 mAP@50 and Veil-tiny's
threshold-sweep numbers as **external comparison points on WebPII**; do not ship either as a component.
Veil-tiny in particular is unlicensed (§18.2), so shipping it is a legal defect, and reproducing its
numbers ourselves is both safer and more impressive. Licensed, maintained options for T3 remain
PP-OCRv4/v5 detection and a small text-region detector we train on WebPII.

### A7 — the privacy metric must be a pair, never a single number

**Amends §16.** Residual leakage alone is gameable in the most obvious way: a redactor that blacks out the
entire screen reports zero leakage and zero utility. Never report it alone.

**The reporting unit is a pair, always adjacent, on the same slide and in the same table:**

| Privacy side | Utility side |
|---|---|
| PII detection recall / precision (20% weight) | Task-success rate under redaction vs unredacted control |
| Redaction pixel IoU (20% weight) | **Over-redaction rate** — non-sensitive pixels destroyed |
| Strict leak-free rate, per Veil-tiny's definition — all regions covered or the screenshot fails | Semantic retention — does the VLM still ground the right node? |
| **Residual leakage after M5 re-extraction** (headline) | Visual-context accuracy (25% weight) on the same runs |

Adopting Veil-tiny's **strict leak-free rate** as one of our own metrics is a deliberate move: it is the
harshest published definition, it is a third party's, and reporting against it invites the comparison
instead of dodging it. Its counterpart, over-redaction, is the metric Veil-tiny's author flags as their
model's failure — so the pair is the exact axis on which we can win.

`gate.residual_leak_last_run` in the §15.5 wire contract stays, but the deck's headline number is the pair
*(residual leakage, task success retained)*, quoted together, e.g. *"leakage X at Y% of unredacted task
success."* One number is a claim; two are a result.

### A8 — accept / reject ledger for the critique's remaining points

**Accepted and now written above:** registry-first verification and the tier scheme (§18.1); both artifacts
added rather than deleted (§18.2–§18.3); per-engine egress precision (A1); CSP as declared policy not
impossibility (A1); trust-boundary restatement (A2); inferential-disclosure honesty (A3); M5 rename and the
M3/M5 split (A4); type-level and CI-level invariants (A5); face and text size bands (A6); privacy–utility
pairing (A7); the scoped novelty sentence and the two wording fixes (§18.4).

**Rejected, with reasons:**

1. **"Adopt Veil-tiny as the T3 model."** Rejected — unlicensed, zero downloads, no training or eval code,
   abandoned after a 7-minute upload session, wrong input resolution, and self-declared unfit as a sole
   control (§18.2). Cite it; do not depend on it.
2. **"Safe-Screen shows placeholder substitution for browser agents is not our novelty."** Partly accepted
   — concede the *loop*. Rejected as to *on-device visual perception*, which Safe-Screen does not implement
   in either mode (§18.3).
3. **"Both are actively developed prior art."** Rejected on registry evidence — single-session, zero
   adoption, tier B− (§18.2–§18.3).
4. **Its GUIGuard dataset figures (630 trajectories / 13,830 screenshots)** conflict with the abstract I
   read (241 / 4,080). Both are now barred from slides until re-read (§13.2).
5. **Continued use of a project name.** The name stays deferred as `[PROJECT NAME]` per the user's
   standing decision. Not a research question.

---

## 20. Claim-by-claim prior art, per mechanism

§14.2 compares whole systems, which is the wrong granularity — a judge attacks a *mechanism*, not a system.
This section does it per mechanism: exact overlap, exact non-overlap, and the sentence to say when
challenged. **Two of the five are derivative and are marked so.** Conceding those is what makes M2 and M3
believable; the concession is deliberate, not an oversight.

### M1 — Unified multimodal scene graph, one ID space · **derivative, concede it**

**Already published.** Turning a screen into a structured element list: OmniParser, and Sema
([arXiv:2604.20940](https://arxiv.org/abs/2604.20940)) which sends semantics instead of pixels for a
**130–210× uplink reduction at 0.7 pp accuracy cost**. Region-level privacy annotation over screenshots:
GUIGuard ([arXiv:2601.18842](https://arxiv.org/abs/2601.18842)), with bounding boxes, category, risk level
and task-necessity. Fusing DOM text with bounding boxes: Safe-Screen (§18.3) does it with Playwright.

**Exactly ours.** Two narrow things. (i) A **conflict-resolution policy with a defined winner per
attribute**, where DOM and vision disagreeing is a *reported signal* rather than one source silently
overwriting the other — because a disagreement between what the DOM says a field contains and what is
painted on it is itself evidence of a masked or overlaid value. (ii) **One namespace shared by all four
consumers** — the redaction decision, the placeholder capability, the gate's verdict and the executor's
action all address the identical node ID. In the surveyed systems, detection and action live in separate
coordinate systems and are re-matched heuristically.

**Say:** *"Scene-graph construction is solved and we use the known approach. What we add is what happens
when the two sources disagree, and a single ID that the capability, the gate and the executor all share."*

### M2 — Target-bound privacy capabilities · **real delta, and it is a composition**

**Already published.** Capability- and provenance-based mediation at the tool-call boundary: **CaMeL**
([arXiv:2503.18813](https://arxiv.org/abs/2503.18813), DeepMind, with code). Placeholder substitution that
keeps data usable while invisible to the model: **Available but Invisible**
([arXiv:2602.10139](https://arxiv.org/abs/2602.10139)), mobile. Working implementation of the full loop for
a browser agent: **Safe-Screen**. Evidence that naive placeholders wreck utility:
[arXiv:2605.13538](https://arxiv.org/abs/2605.13538).

**Exactly ours — four properties, none individually exotic, not found combined:**

| Property | Why it matters | Safe-Screen | CaMeL | 2602.10139 |
|---|---|---|---|---|
| Bound to a **node identity** in the M1 graph | A token is only redeemable at the field it came from | ✗ global | partial (tool args) | partial |
| **Session-salted** | Tokens don't correlate across sessions or users | ✗ static | — | not stated |
| **Single-use** | A captured plan cannot be replayed | ✗ reusable | — | not stated |
| **Type-generalised, not type-naming** | `[MY_SSN]` announces that an SSN exists | ✗ discloses | — | — |

Combined effect, which is the actual claim: **an intercepted plan is inert.** The token cannot be replayed,
cannot be correlated, and does not reveal its category.

**Say:** *"Placeholder substitution is prior art — there is a working GitHub implementation and a published
mobile system, and we cite both. Ours differs in four properties that together make a stolen plan useless
rather than merely anonymised."*

### M3 — Verified egress firewall, two channels, independent code · **strongest delta**

**Already published.** A policy check at a boundary, separate from the model: **CaMeL** — the nearest
relative. Guarding the *action the model returns*: Safe-Screen's `actionGuard.ts`. Redaction itself:
WebRedact, Veil-tiny, GUIGuard stage 2 — all detectors, none with a second verifier.

**Exactly ours — four properties:** (i) the check is on the **outbound** payload, not the inbound action;
(ii) the **structured channel and the visual channel are verified separately**, because a value can leak in
JSON while the pixels are clean, or survive in a crop while the text is scrubbed; (iii) the verifier is
**not the redactor** — different code path, so a redactor bug cannot silently self-approve; (iv) it
**refuses the send**, making it an enforcement point rather than a monitor.

**The justification is now third-party, which is why this is the strongest delta.** Veil-tiny reports
**86.83% recall with a 33.32% strict leak-free rate on the same test set**, and its author writes that it
*"should not be used as the sole privacy or security control"* (§18.2). GUIGuard independently reports that
models fail at localisation, category and risk — *"privacy recognition is a critical bottleneck."* Two
independent sources say a detector cannot be trusted as the control. M3 is the answer to their own finding.

**Wording discipline:** never say *"everyone else trusts their own redactor."* Say *"none of the systems we
examined reports an independent outbound verifier on both channels."* The first is unfalsifiable bravado;
the second is a checkable statement about a named list.

### M4 — Necessity- and risk-aware perception scheduler · **derivative in idea, forced in form**

**Already published, with better numbers than we will have.** **CAPED**
([arXiv:2606.12666](https://arxiv.org/abs/2606.12666)) extracts task requirements and uses screen context as
a privacy prior, cutting leakage **0.766 → 0.268** with high task utility. GUIGuard supplies risk levels and
task-necessity labels. Sema cuts transmitted data 130–210×. ScreenSeekeR
([arXiv:2504.07981](https://arxiv.org/abs/2504.07981)) lifts grounding **18.9% → 48.1%** purely by reducing
search area. Concede all of it: necessity-aware disclosure is CAPED's contribution, not ours.

**Exactly ours.** Necessity and risk driving a **capture-and-compute schedule under a hard platform
ceiling**. `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` defaults to **2 per second** with, in Chromium's own
words, *"no way to increase this value"* (§13.3). No prior system has this constraint because no prior
system runs inside a browser extension — the mobile and host-process systems capture freely. So the
scheduler is **not a design preference we chose, it is the only shape the platform permits**, and its
policy — which tiles, at what resolution, how often, and escalate to the grounded VLM only when structure
leaves a node unexplained *and* the node is task-necessary — follows from that ceiling. Second point:
necessity is decided **locally** and travels as a field the server cannot influence.

**Say:** *"Necessity-aware redaction is CAPED's, and CAPED's numbers are better than ours will be at this
stage. What is ours is scheduling perception against a two-frames-per-second cap that no prior system has
had to respect, because none of them lived in the browser."*

### M5 — Adversarial egress verification · **modest as science, strong as engineering**

**Already published.** Adversarial evaluation of privacy systems is standard practice. Veil-tiny's **strict
leak-free rate** is itself a harsher self-attack than F1 and deserves credit as such. VPI-Bench
([arXiv:2506.02456](https://arxiv.org/abs/2506.02456)) attacks the input side, with visual prompt injection
succeeding up to **51%**. [arXiv:2504.12308](https://arxiv.org/abs/2504.12308) shows PII metrics don't
replicate across settings — which is the argument for measuring on our own output rather than trusting a
reported number.

**Exactly ours.** Re-extraction against our own sanitised output as a **standing gate in CI** whose number
ships beside every result and which can fail a build — rather than an evaluation section computed once for
a paper. Nothing here is a scientific advance; the claim is that the measurement is continuous and
adversarial rather than one-shot and self-reported.

**Say:** *"We turned the evaluation section into a build step. Every commit re-attacks our own output, and
the number we quote is the one that survived."*

### Net novelty statement — the only version to put on a slide

> **M2's four-property composition, M3, and M5-as-a-build-gate, running inside a WebExtension on two
> engines under a 2-frames-per-second capture ceiling.** M1 and M4 are necessary plumbing built on
> OmniParser, Sema, CAPED and GUIGuard, and we say so first.

---

## 21. Amended deck plan (supersedes the affected rows of §17)

`content.md` is still untouched by decision. When it is unblocked, apply §21 first, then the unaffected
rows of §17.

| Slide | Amended instruction | Source |
|---|---|---|
| 2 — Proposed Solution | **Open with the number, not the gap.** *"The best purpose-built visual privacy model we could find fully sanitises one screenshot in three, and its own author says it must not be the only control."* Then the gap in one line: the closest working browser implementation has two modes — **no vision, or vision by uploading the raw screen to a hosted GPU**. Then our line: *"The agent acts on your private data without ever receiving it."* | §18.2, §18.3, §18.4 |
| 3 — Technical Approach | Keep §17's three wording fixes. **Add:** T3 runs on **tiles at near-native resolution**, not a downscaled full frame — with the 384×384 → ~2 px digit arithmetic as the one-sentence reason. **Replace** any "MV3 forbids cross-origin fetch" phrasing with A1's version (*no elevated cross-domain privilege on either engine — Chrome ≥ 73, Firefox ≥ 101, per MDN; our server does not opt in via CORS*). **Add** the two machine-checkable invariants from A5 as two lines: the closed `ServerVisibleValue` union, and the CI rule that fails the build if a network primitive appears outside `gate/`. | A1, A5, A6 |
| 4 — Feasibility | Keep the four-configuration matrix. **Adopt Veil-tiny's strict leak-free rate as one of our own metrics** and say why: it is the harshest published definition and it is a third party's. Report every privacy number **paired** with its utility counterpart (A7); headline is *(residual leakage, task success retained)*. Biggest-risk row stays **redaction recall** — now with third-party evidence rather than our own worry. | A7, §18.2 |
| 6 — References / Novelty | **Use the extended §14.2 table — eleven systems, seven properties — with Veil-tiny and Safe-Screen included and their rows filled in honestly.** Cite both ourselves, first, and name their tier out loud: *"real, single-session research artifacts, zero adoption."* Close with **§20's net novelty statement** and nothing broader. Never the words "nobody has done this." | §14.2, §18, §20 |
| Prepared answers | Replace the wrapper answer with A1's version. **Add four:** (a) *"Veil-tiny already detects visual PII"* → yes, and its 33.32% strict leak-free rate is why we built a verifier instead of a better detector; (b) *"Safe-Screen already does placeholder substitution for browser agents"* → yes, we cite it; it is external Playwright automation whose vision mode uploads the raw screenshot, and its placeholders are static globals from `.env` — the four properties in §20's M2 table are the difference; (c) *"how do I know another module doesn't just POST the screenshot?"* → the build refuses to produce an artifact in which it could (A5.2); (d) *"a placeholder doesn't stop re-identification"* → correct, and we don't claim it does — A3's objective. | A1, A3, A5, §20 |
| Everywhere | Every named system carries its **tier** (§18.1 Rule 3). Barred from slides until re-read: WebRedact's 0.842/312 ms, and **both** GUIGuard dataset sizes. | §18.1, §13.2 |

**The five concessions to make out loud, updated.** Previously five; now seven, and the two additions are
the strongest ones because they are the two a judge is most likely to find:

1. We are not the first browser agent.
2. We are not the first redactor.
3. We are not the first privacy framework for GUI agents — GUIGuard's three stages predate our pipeline shape.
4. We are not the first placeholder scheme.
5. We do not train a new foundation model.
6. **We are not the first to build a visual PII detector for web screenshots** — WebRedact and Veil-tiny exist, and Veil-tiny's numbers are better than a first-pass detector of ours will be.
7. **We are not the first to close the placeholder loop for a browser agent** — Safe-Screen did it in a weekend, in TypeScript, and we cite it.

Conceding six you did not have to is what makes the seventh — *"and none of them is a WebExtension-resident
privacy boundary with an independent outbound verifier on two engines"* — land as a fact rather than a boast.

<!-- RESEARCH-APPEND-POINT -->


