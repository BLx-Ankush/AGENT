# PS SIH26171 — Deck copy (official SIH template, 6 slides incl. title)

**Source of truth for facts:** `Research.md` (§1–§12). Nothing here may contradict it.
**Name:** the project name is undecided — every occurrence is written as `[PROJECT NAME]`.
Search-and-replace once decided.
**Slide discipline:** if a slide overflows, **cut content — never shrink the type**. Each slide below
carries a word budget; stay inside it.

Format per slide:
- **PASTE** — the exact text that goes on the slide.
- **VISUAL** — what the diagram/table must show.
- **SAY** — the spoken line, not printed on the slide.

---

## Slide 1 — Title

**PASTE**

```
[PROJECT NAME]
On-device visual perception for light-weight browser agents

Problem Statement ID: SIH26171
Organisation: Indian Space Research Organisation (ISRO), Department of Space
Theme: Smart Automation   |   Category: Software

Team Name: [TEAM NAME]
[MEMBER 1] · [MEMBER 2] · [MEMBER 3] · [MEMBER 4] · [MEMBER 5] · [MEMBER 6]
[INSTITUTE NAME]
```

**VISUAL** — nothing beyond the wordmark. Keep it clean; the title slide is not a place to spend budget.

**SAY** — "Browser agents work today by sending your screen to somebody else's model. We remove that
requirement."

---

## Slide 2 — Proposed Solution

Word budget: ≤ 150 words of body text. This slide must land the *problem* and the *one-line difference*.

**PASTE**

```
THE GAP
Every shipping browser agent — Operator, Claude in Chrome, Gemini in Chrome, Comet —
sends the screen, or the page, to a remote model. So the users who most need automation
cannot use it: mission-operations and telemetry consoles, defence workstations, hospital
and banking front-ends, anything under the DPDP Act.

OUR APPROACH — capability without disclosure
1. Perception is local. A vision model runs inside the browser, over WebGPU, and reads
   the rendered screen — including what the DOM cannot describe.
2. Nothing leaves un-sanitised. Faces, IDs, OTPs, revealed passwords and PII are found
   and replaced with placeholders BEFORE the network is touched.
3. The server plans; the client acts. It returns "type <EMAIL_01> into node 42". The real
   value is substituted locally, at execution time. The server never sees it.
4. The privacy claim is structural, not a promise: one module can reach the network, and
   the raw framebuffer never leaves the perception module.
```

**VISUAL** — a single horizontal band, left to right: `SCREEN → LOCAL PERCEPTION → SANITISE → ⛔ EGRESS
GATE → SERVER (plans) → CLIENT (executes)`. Draw the gate as the only opening in an otherwise solid
boundary around the client, and put a small lock glyph on the return arrow labelled "placeholders only".
Colour the client side one colour and the server side another so the boundary is unmistakable at a glance.

**SAY** — "The distinction is not that we use a smaller model. It is that the model that plans your
actions is structurally incapable of reading your data."

---

## Slide 3 — Technical Approach

The densest slide. Word budget: ≤ 130 words of body text, because the diagram carries the load.

**PASTE**

```
STACK
Client   Chrome MV3 + Firefox MV3 extension · ONNX Runtime Web · Transformers.js v4
         WebGPU where available, WASM fallback mandatory (Firefox has no Linux WebGPU yet)
Server   Offline-deployable open-weights model. Structured text is enough in the common
         case, so a text-only LLM suffices; a VLM is used only for image crops.

PERCEPTION CASCADE — cheap stages first, the model last
T0 Trigger    navigation / mutation / user intent — never per frame
T1 Harvest    DOM + accessibility tree, viewport-clipped
T2 Recognise  deterministic recognizers: Luhn, Verhoeff (Aadhaar), PAN, GSTIN, IFSC, IBAN
T3 Propose    vision proposes regions: text detector + face detector
T4 Read       OCR + NER, only on regions T1 could not explain
T5 Ground     grounded VLM, invoked rarely
T6 Reconcile  merge into one ID space → egress gate re-reads its own output → send
```

**VISUAL** — the cascade as a funnel with a cost axis: T0/T1/T2 wide and marked "≈0 ms, no model", T3/T4
narrower, T5 a thin sliver marked "rare". Beside it, a two-line wire-format excerpt showing a `nodes` entry
with `"value": "<EMAIL_01>"` and a `coverage` block with `"gate": "passed"`.

**SAY** — "Search-area reduction is not our idea; ScreenSpot-Pro shows it lifting grounding from eighteen
to forty-eight percent with no extra training. We use it because it is the published result, and because
it is also what makes twenty-percent resource utilisation achievable."

---

## Slide 4 — Feasibility & Viability

Word budget: ≤ 140 words. Every number on this slide is either sourced or explicitly labelled a budget.

**PASTE**

```
FEASIBILITY IS DEMONSTRATED, NOT ASSUMED
Apple publishes FastVLM running 100% inside a browser tab on WebGPU via Transformers.js
(apple/fastvlm-webgpu). FastVLM reports 85x faster time-to-first-token and a 3.4x smaller
vision encoder than the comparable 0.5B baseline. The ONNX build ships a q4 recipe. So an
in-tab vision-language model is a vendor-demonstrated fact.

RISKS AND WHAT WE DO ABOUT THEM
Firefox WebGPU: Windows since 141, Apple Silicon since 147, Linux still pending
   -> WASM fallback is in scope from day one; we report numbers per engine and per backend.
Over-redaction destroys the task (PrivacyPAD)
   -> we report utility retention alongside redaction precision, so blacking out the screen
      cannot look like a win.
Published PII metrics do not replicate (arXiv 2504.12308)
   -> we measure on labelled data ourselves and publish the harness.
Recall is never 100%
   -> a second, independent gate re-reads the outgoing payload and blocks the send.
```

**VISUAL** — a 5-row table, one row per PS weight, three columns: *Weight · How it is measured · Instrument*.
Rows: visual-context accuracy 25% / ScreenSpot-Pro + ScreenSpot web split / grounding harness · PII
detection 20% / recall+precision on labelled PII regions / PII-Bench-style query-aware scoring · redaction
precision 20% / pixel IoU + over-redaction area + adversarial re-extraction (OCR the sanitised image, count
recoverable strings) / leak test · resource use 20% / VRAM, RSS, CPU%, disk / per-backend trace, cold vs
warm · latency 15% / p50 and p95 end-to-end / same trace. Add a footer: *targets are design budgets until
measured*.

**SAY** — "The rubric is published, so we treated it as the requirements list. Every one of the five weights
has an instrument, and the redaction one has an attacker in it: we OCR our own sanitised output and count
what is still recoverable."

---

## Slide 5 — Impact & Benefits

Word budget: ≤ 130 words. This is the ISRO-relevance slide; do not let it become generic.

**PASTE**

```
WHO THIS UNLOCKS
Organisations that are forbidden from sending screen contents to an externally hosted
model currently cannot use browser automation at all:
  · mission-operations, ground-station and telemetry consoles
  · defence and public-sector workstations on regulated networks
  · hospital, insurance and banking front-ends under the DPDP Act, 2023
For them the choice today is "no agent". We change the choice to "an agent that cannot
see your data".

SECONDARY BENEFITS
Accessibility  the same local perception layer describes canvas apps, video and scanned
               PDFs that screen readers cannot reach.
Cost           the expensive frames never leave the device, so per-task server cost falls.
Auditability   the outgoing payload is human-readable and self-reporting: it declares how
               much of the screen was vision-only and how many regions were redacted.
Portability    open weights, ONNX, offline-deployable server — no vendor lock-in.
```

**VISUAL** — a before/after pair. Left: a console screenshot with an arrow to a cloud, the whole screen
tinted red, captioned "today: send everything, or automate nothing". Right: the same screenshot with faces
and fields masked, a thin arrow carrying `<SENSITIVE_03>`, captioned "the payload a judge can read". If a
real ops-console image is not usable, use any dense dashboard — the point is density, not the specific app.

**SAY** — "The reason this problem statement comes from a space agency and not a browser vendor is that
browser vendors already solved automation. They solved it in a way that a mission-operations network is not
allowed to adopt."

---

## Slide 6 — Research & References

Word budget: ≤ 120 words. Its real job is to prove we surveyed the field and know exactly what we are not.

**PASTE**

```
WHAT ALREADY EXISTS, AND WHERE IT STOPS
Operator · Claude in Chrome · Gemini in Chrome · Comet   cloud inference on raw screens
OmniParser V2 (Microsoft)      parses screens locally on a desktop GPU — parsing only,
                               no redaction, not in a browser
presidio-image-redactor        image PII redaction, but a self-described beta "simple OCR
                               pipeline": OCR text only, no faces, no action loop
Casper (arXiv 2408.07004)      local-first browser extension redactor — prompt text only
pii-guardrail extension        same shape, also text only
=> Local perception exists. Local redaction exists. Nobody sanitises the RENDERED SCREEN
   and closes the action loop with published per-metric numbers. That is our slice.

KEY REFERENCES
ScreenSpot-Pro 2504.07981 (best existing grounding 18.9%) · VisualWebArena 2401.13649 ·
PII-Bench 2502.18545 · PII masking metrics do not replicate 2504.12308 · PrivacyPAD
2510.16054 · PAPILLON 2410.17127 · AirGapAgent 2405.05175 · FastVLM (Apple, CVPR 2025) ·
MDN captureVisibleTab · chrome.offscreen · gpuweb Implementation Status
```

**VISUAL** — a 4-column tick matrix: *Client-side perception · Sanitises the rendered screen · Closed action
loop · Published per-metric numbers*, with a row per system above. Every existing row has gaps; only our row
is complete. This single graphic is the answer to "isn't this already present" — put it where the eye lands
first.

**SAY** — "We are not claiming the first browser agent, or the first PII redactor. We are claiming the
first one where the planner cannot read the screen, and we brought the numbers to argue it."

---

## Speaking order (6 minutes)

1. Open on the gap, not on us: "agents exist; the users who need them most are not allowed to use them."
2. Slide 2 — the four-step approach, then the structural invariant. Say *one module touches the network*.
3. Slide 3 — walk the funnel downward, not upward: cheap stages first is *why* the resource number works.
4. Slide 4 — lead with Apple's in-browser demo so feasibility is closed before it is questioned, then the
   weight→instrument table.
5. Slide 5 — name ISRO's own use case explicitly.
6. Slide 6 — end on the tick matrix, and say the narrow claim out loud so nobody has to guess it.

## Prepared answers — say these verbatim if asked

- **"Isn't this just a wrapper?"** — "A wrapper passes data through. We are the opposite: the wrapped model
  is denied the data and still completes the task. The placeholder is a use-once capability bound to one
  element, so the server can fill a field it can never read."
- **"Why a vision model when you have the DOM?"** — "Google Docs has rendered to canvas since 2021.
  Cross-origin iframes are unreadable from a content script by design. The built-in PDF viewer, video,
  text inside images, faces, closed shadow roots — and occlusion itself — are invisible to the DOM. Those
  are vision's job; we do not use it where the DOM is already correct."
- **"How do you prove you don't leak?"** — "Two ways. Open the network inspector: the payload is readable
  and contains placeholders. Then the harder test — we OCR our own sanitised output and count how many
  ground-truth PII strings are recoverable. That number is in the deck."
- **"What if the server is compromised?"** — "Then the task fails. It does not disclose. Detokenisation
  happens only on the client, and the action schema is a typed allowlist, so a hostile plan cannot become
  arbitrary code."
- **"It'll break on the finale's unseen sites."** — "Nothing is hard-coded to a page: the recognizers are
  checksum-based and the cascade is site-agnostic. Name a site and we will run it now."

<!-- CONTENT-APPEND-POINT -->
