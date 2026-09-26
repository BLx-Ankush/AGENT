"""
ANTARDRISHTI — Planner Server

FastAPI server implementing the planner endpoint.
Contract §17: real server-side LLM for SIH demo.
Contract §18: deterministic planner is dev/test fallback.

Endpoints:
  POST /v1/plan          — Submit sanitized observation, receive typed action plan
  GET  /v1/health        — Health check
  GET  /v1/metrics       — Aggregated inference metrics

Usage:
  python server.py                    # Start with mock planner (dev)
  python server.py --adapter=llm      # Start with real LLM adapter
  python server.py --adapter=llm --model=llama3.1  # Specific model
"""

import json
import time
import uuid
import argparse
import os
from typing import Optional, Literal
from datetime import datetime, timedelta

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import uvicorn

# ── App ───────────────────────────────────────────────────────

app = FastAPI(
    title="ANTARDRISHTI Planner Server",
    version="0.1.0",
    description="Server-side planner for ANTARDRISHTI browser agent",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Extension origin
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

# ── Request / Response Schemas ────────────────────────────────

class Viewport(BaseModel):
    width: int
    height: int
    devicePixelRatio: float = 1.0

class SessionInfo(BaseModel):
    id: str
    step: int
    observationId: str
    origin: str
    documentGeneration: str
    viewport: Viewport

class TaskInfo(BaseModel):
    sanitized: str
    risk: Literal["low", "medium", "high"] = "low"

class SceneNode(BaseModel):
    id: str
    role: str
    name: Optional[str] = None
    value: Optional[str] = None
    bbox: Optional[dict] = None
    actionability: Optional[str] = None

class SceneCoverage(BaseModel):
    visualGrounding: str = "none"
    unresolvedRegions: int = 0
    structuredGate: str = "passed"
    visualGate: str = "not-applicable"

class Scene(BaseModel):
    nodes: list[SceneNode] = []
    coverage: Optional[SceneCoverage] = None

class RedactionDecl(BaseModel):
    token: str
    category: str
    shape: str
    region: str
    representation: str = "placeholder"
    disclosure: str = "shape-only"
    reasonCode: str = "required-for-planning"

class ProtectedVisualRegion(BaseModel):
    visualRegionId: str
    category: str
    representation: str
    bbox: Optional[dict] = None

class PlannerRequest(BaseModel):
    protocolVersion: str = "2.0"
    session: SessionInfo
    task: TaskInfo
    scene: Scene
    redactions: list[RedactionDecl] = []
    protectedVisualRegions: list[ProtectedVisualRegion] = []
    allowedActions: list[str] = []

class AgentAction(BaseModel):
    kind: str
    id: str
    targetNodeId: Optional[str] = None
    text: Optional[str] = None
    token: Optional[str] = None
    expectedRole: Optional[str] = None
    reason: Optional[str] = None
    milliseconds: Optional[int] = None

class PlannerResponse(BaseModel):
    protocolVersion: str = "2.0"
    observationId: str
    planId: str
    expiresAt: str
    actions: list[AgentAction]

# ── Planner Adapters ──────────────────────────────────────────

class PlannerAdapter:
    """Base adapter interface."""
    name: str = "base"
    
    async def plan(self, request: PlannerRequest) -> PlannerResponse:
        raise NotImplementedError


class MockPlanner(PlannerAdapter):
    """
    Deterministic mock planner for development and testing.
    Returns hardcoded plans based on simple task + scene heuristics.
    """
    name = "mock"
    
    async def plan(self, request: PlannerRequest) -> PlannerResponse:
        actions: list[AgentAction] = []
        task = request.task.sanitized.lower()
        action_id = 0
        
        # Find tokens in the task
        tokens_in_task = [r.token for r in request.redactions]
        
        # Pattern: fill form → find typable fields and fill them
        typable_nodes = [n for n in request.scene.nodes if n.actionability == "typable"]
        clickable_nodes = [n for n in request.scene.nodes if n.actionability == "clickable"]
        
        if "fill" in task or "enter" in task or "type" in task:
            for node in typable_nodes[:3]:
                action_id += 1
                # Check if we have a token that matches this field's redaction
                matching_token = None
                for r in request.redactions:
                    if node.id in r.region:
                        matching_token = r.token
                        break
                
                if matching_token:
                    actions.append(AgentAction(
                        kind="type_token",
                        id=f"action-{action_id}",
                        targetNodeId=node.id,
                        token=matching_token,
                        expectedRole=node.role,
                        reason=f"Fill {node.name or node.role} with protected value",
                    ))
                else:
                    actions.append(AgentAction(
                        kind="focus",
                        id=f"action-{action_id}",
                        targetNodeId=node.id,
                        expectedRole=node.role,
                        reason=f"Focus {node.name or node.role}",
                    ))
        
        elif "click" in task or "submit" in task or "send" in task:
            for node in clickable_nodes[:1]:
                action_id += 1
                actions.append(AgentAction(
                    kind="click",
                    id=f"action-{action_id}",
                    targetNodeId=node.id,
                    expectedRole=node.role,
                    reason=f"Click {node.name or node.role}",
                ))
        
        elif "transfer" in task or "pay" in task:
            # Payment task: fill amount, then click transfer
            for node in typable_nodes[:1]:
                action_id += 1
                if tokens_in_task:
                    actions.append(AgentAction(
                        kind="type_token",
                        id=f"action-{action_id}",
                        targetNodeId=node.id,
                        token=tokens_in_task[0],
                        expectedRole=node.role,
                        reason="Fill payment field with protected value",
                    ))
            
            for node in clickable_nodes[:1]:
                if "send" in (node.name or "").lower() or "transfer" in (node.name or "").lower():
                    action_id += 1
                    actions.append(AgentAction(
                        kind="click",
                        id=f"action-{action_id}",
                        targetNodeId=node.id,
                        expectedRole=node.role,
                        reason=f"Click {node.name}",
                    ))
        
        if not actions:
            action_id += 1
            actions.append(AgentAction(
                kind="request_observation",
                id=f"action-{action_id}",
                reason="No actionable pattern found, requesting fresh observation",
            ))
        
        return PlannerResponse(
            protocolVersion="2.0",
            observationId=request.session.observationId,
            planId=f"mock-plan-{uuid.uuid4().hex[:8]}",
            expiresAt=(datetime.utcnow() + timedelta(seconds=30)).isoformat() + "Z",
            actions=actions,
        )


# ── OpenAI-Compatible Response Normalization ──────────────────

class ContentExtractionError(Exception):
    """Raised when provider response content cannot be extracted."""
    pass


class PlannerFailureError(Exception):
    """Raised when the LLM/provider fails and no valid plan is produced.
    
    This must NOT be converted into a request_observation action.
    It propagates as a non-2xx HTTP response to the extension client.
    """
    # Category -> HTTP status mapping
    STATUS_MAP = {
        "provider_http_error": 502,
        "provider_request_failed": 504,
        "provider_response_invalid": 502,
        "content_extraction_failed": 502,
        "planner_json_parse_failed": 502,
        "planner_action_parse_failed": 502,
    }

    def __init__(self, category: str, message: str):
        self.category = category
        self.message = message
        self.http_status = self.STATUS_MAP.get(category, 502)
        super().__init__(message)


class OpenAICompatibleResponseAdapter:
    """
    Provider-agnostic normalization for OpenAI-compatible API responses.

    Extracts textual content from the first choice's message, regardless
    of whether the provider returns content as a string, a list of typed
    content parts, a list of plain strings, or a mixed array.

    No provider-specific, model-specific, or site-specific branching.
    The response shape alone determines normalization.
    """

    def __init__(self):
        self.last_content_shape: str = "unknown"

    def extract_text(self, resp_json: dict) -> str:
        """
        Extract the textual assistant content from a decoded OpenAI-compatible
        JSON response.

        Supported content forms:
          1. string:       "{"actions":[...]}"
          2. text parts:   [{"type": "text", "text": "..."}]
          3. string list:  ["...", "..."]
          4. mixed:        [{"type": "text", ...}, {"type": "image_url", ...}]

        Returns the canonical text string for JSON parsing.
        Raises ContentExtractionError on invalid/unsupported content.
        """
        # Navigate to message content
        choices = resp_json.get("choices")
        if not choices or not isinstance(choices, list) or len(choices) == 0:
            raise ContentExtractionError("no choices in provider response")

        message = choices[0].get("message")
        if not message or not isinstance(message, dict):
            raise ContentExtractionError("no message in first choice")

        content = message.get("content")

        if content is None:
            # Safe structural diagnostic — log shape only, no raw values
            msg_keys = sorted(message.keys())
            finish_reason = choices[0].get("finish_reason")
            has_reasoning = "reasoning" in message and message["reasoning"] is not None
            reasoning_type = type(message["reasoning"]).__name__ if has_reasoning else None
            has_tool_calls = "tool_calls" in message and message["tool_calls"] is not None
            print(f"[ResponseAdapter] content=null diagnostic: "
                  f"messageKeys={msg_keys}, finishReason={finish_reason}, "
                  f"reasoningPresent={has_reasoning}, reasoningType={reasoning_type}, "
                  f"toolCalls={has_tool_calls}")
            raise ContentExtractionError("message content is null")

        # Form 1: String content (most common)
        if isinstance(content, str):
            self.last_content_shape = "string"
            return content

        # Form 2-4: Array content
        if isinstance(content, list):
            if len(content) == 0:
                raise ContentExtractionError("message content is empty array")

            text_parts: list[str] = []

            for part in content:
                if isinstance(part, str):
                    # Form 3: plain string in array
                    text_parts.append(part)
                elif isinstance(part, dict):
                    part_type = part.get("type", "")
                    if part_type == "text" and "text" in part:
                        # Form 2/4: typed text content block
                        text_val = part["text"]
                        if isinstance(text_val, str):
                            text_parts.append(text_val)
                    # Non-text blocks (image_url, audio, etc.) are skipped
                # Other types are skipped

            if not text_parts:
                raise ContentExtractionError(
                    "content array contains no text-bearing elements"
                )

            # Determine shape for diagnostics
            has_dicts = any(isinstance(p, dict) for p in content)
            has_strings = any(isinstance(p, str) for p in content)
            if has_dicts and not has_strings:
                self.last_content_shape = "text_parts[]"
            elif has_strings and not has_dicts:
                self.last_content_shape = "string_parts[]"
            else:
                self.last_content_shape = "mixed_parts[]"

            return "".join(text_parts)

        # Unsupported content type
        raise ContentExtractionError(
            f"unsupported content type: {type(content).__name__}"
        )

    def normalize_text(self, raw_text: str) -> str:
        """
        Apply benign normalization to extracted text:
          - Strip surrounding whitespace
          - Strip fenced code markers (```json ... ``` or ``` ... ```)
        Does NOT perform arbitrary natural-language extraction.
        """
        text = raw_text.strip()

        # Strip fenced code block markers
        if text.startswith("```"):
            lines = text.split("\n")
            # Remove opening fence (```json or ```)
            if lines[0].strip().startswith("```"):
                lines = lines[1:]
            # Remove closing fence
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            text = "\n".join(lines).strip()

        return text


class LLMPlanner(PlannerAdapter):
    """
    Real LLM planner adapter.
    Supports both:
      - Ollama (local): http://localhost:11434/api/generate
      - OpenAI-compatible APIs: GPT-4o, Gemini, Claude via proxy, etc.

    Contract §17: real server-side LLM for SIH demo.

    Configuration:
      ANTARDRISHTI_LLM_API_KEY  — API key (OpenAI/Gemini/Anthropic)
      ANTARDRISHTI_LLM_BASE_URL — Base URL override
      ANTARDRISHTI_LLM_MODEL    — Model name override

    CLI:
      --adapter=llm --openai --model=gpt-4o-mini
      --adapter=llm --model=llama3.2:3b  (local Ollama)
    """
    name = "llm"

    def __init__(
        self,
        model: str = "gpt-4o-mini",
        base_url: str = "https://api.openai.com/v1",
        api_key: str = "",
        use_openai_format: bool = True,
    ):
        self.model = os.environ.get("ANTARDRISHTI_LLM_MODEL", model)
        self.base_url = os.environ.get("ANTARDRISHTI_LLM_BASE_URL", base_url).rstrip("/")
        self.api_key = os.environ.get("ANTARDRISHTI_LLM_API_KEY", api_key)
        self.use_openai_format = use_openai_format
        self.response_adapter = OpenAICompatibleResponseAdapter()
        # Auto-detect: Ollama uses its own format, others use OpenAI
        if "11434" in self.base_url or "ollama" in self.base_url.lower():
            self.use_openai_format = False
        # OpenAI-compatible providers need /v1 in the path.
        # If user provides just the domain (e.g. https://apichat.budsin.dev),
        # append /v1. If URL already has /v1 (e.g. https://api.openai.com/v1),
        # don't double it.
        if self.use_openai_format and "/v1" not in self.base_url:
            self.base_url = self.base_url + "/v1"

    async def plan(self, request: PlannerRequest) -> PlannerResponse:
        import httpx

        prompt = self._build_prompt(request)
        actions: list[AgentAction] = []
        error_category: str | None = None

        try:
            async with httpx.AsyncClient(timeout=45.0) as client:
                if self.use_openai_format:
                    # OpenAI-compatible chat completions format
                    headers = {"Content-Type": "application/json"}
                    if self.api_key:
                        headers["Authorization"] = f"Bearer {self.api_key}"

                    payload = {
                        "model": self.model,
                        "messages": [
                            {
                                "role": "system",
                                "content": "You are ANTARDRISHTI, a privacy-preserving browser agent planner. Output ONLY valid JSON. Never guess protected token values.",
                            },
                            {"role": "user", "content": prompt},
                        ],
                        "temperature": 0.1,
                        "max_tokens": 4096,  # Reasoning models need headroom for reasoning + content
                        # NOTE: response_format omitted for provider compatibility.
                        # Not all OpenAI-compatible providers support it.
                        # JSON output is enforced by the system prompt instead.
                    }

                    try:
                        resp = await client.post(
                            f"{self.base_url}/chat/completions",
                            headers=headers,
                            json=payload,
                        )
                        resp.raise_for_status()
                    except httpx.HTTPStatusError as http_err:
                        status = http_err.response.status_code
                        error_category = "provider_http_error"
                        raise RuntimeError(
                            f"provider_http_error: HTTP {status}"
                        ) from http_err
                    except httpx.RequestError as req_err:
                        error_category = "provider_request_failed"
                        raise RuntimeError(
                            f"provider_request_failed: {type(req_err).__name__}"
                        ) from req_err
                    except Exception as req_err:
                        error_category = "provider_request_failed"
                        raise RuntimeError(
                            f"provider_request_failed: {type(req_err).__name__}"
                        ) from req_err

                    try:
                        resp_json = resp.json()
                    except Exception as decode_err:
                        error_category = "provider_response_invalid"
                        raise RuntimeError("provider_response_invalid: response is not valid JSON") from decode_err

                    # ── Provider-agnostic response normalization ──
                    try:
                        raw_text = self.response_adapter.extract_text(resp_json)
                    except ContentExtractionError as ext_err:
                        error_category = "content_extraction_failed"
                        raise RuntimeError(f"content_extraction_failed: {ext_err}") from ext_err

                    raw_text = self.response_adapter.normalize_text(raw_text)
                    content_shape = self.response_adapter.last_content_shape
                    print(f"[LLMPlanner] Provider response normalized (shape: {content_shape})")

                else:
                    # Ollama native format
                    payload = {
                        "model": self.model,
                        "prompt": prompt,
                        "stream": False,
                        "format": "json",
                        "options": {"temperature": 0.1, "num_predict": 512},
                    }
                    try:
                        resp = await client.post(
                            f"{self.base_url}/api/generate",
                            json=payload,
                        )
                        resp.raise_for_status()
                    except httpx.HTTPStatusError as http_err:
                        status = http_err.response.status_code
                        error_category = "provider_http_error"
                        raise RuntimeError(
                            f"provider_http_error: HTTP {status}"
                        ) from http_err
                    except httpx.RequestError as req_err:
                        error_category = "provider_request_failed"
                        raise RuntimeError(
                            f"provider_request_failed: {type(req_err).__name__}"
                        ) from req_err
                    except Exception as req_err:
                        error_category = "provider_request_failed"
                        raise RuntimeError(
                            f"provider_request_failed: {type(req_err).__name__}"
                        ) from req_err

                    raw_text = resp.json().get("response", "{}")

                # ── JSON parse ──
                try:
                    plan_data = json.loads(raw_text)
                except (json.JSONDecodeError, TypeError) as parse_err:
                    error_category = "planner_json_parse_failed"
                    raise RuntimeError(f"planner_json_parse_failed: {parse_err}") from parse_err

                # ── Action extraction ──
                try:
                    actions = self._parse_actions(plan_data, request)
                except Exception as action_err:
                    error_category = "planner_action_parse_failed"
                    raise RuntimeError(f"planner_action_parse_failed: {action_err}") from action_err

                print(f"[LLMPlanner] {self.model} returned {len(actions)} actions")

        except Exception as e:
            cat = error_category or "unknown"
            sanitized_msg = str(e)
            print(f"[LLMPlanner] PROVIDER_FAILURE ({cat}): {sanitized_msg}")
            raise PlannerFailureError(cat, sanitized_msg) from e

        return PlannerResponse(
            protocolVersion="2.0",
            observationId=request.session.observationId,
            planId=f"llm-plan-{uuid.uuid4().hex[:8]}",
            expiresAt=(datetime.utcnow() + timedelta(seconds=30)).isoformat() + "Z",
            actions=actions,
        )

    def _build_prompt(self, request: PlannerRequest) -> str:
        nodes_desc = []
        for n in request.scene.nodes[:50]:
            parts = [f"id={n.id}", f"role={n.role}"]
            if n.name:
                parts.append(f'name="{n.name}"')
            if n.actionability:
                parts.append(f"action={n.actionability}")
            if n.value:
                parts.append(f"value={n.value[:30]}")
            nodes_desc.append(" ".join(parts))

        redactions_desc = [
            f"  {r.token}: {r.category} ({r.shape})"
            for r in request.redactions
        ]

        allowed = (
            ", ".join(request.allowedActions)
            if request.allowedActions
            else "click, focus, type_text, type_token, select, scroll, wait, request_observation, finish"
        )

        return f"""You are a browser agent planner. You receive a sanitized view of a web page.
Protected values have been replaced with tokens like <SENSITIVE_XXXX>.
You MUST NOT try to guess or reconstruct protected values.
For type_token actions, use the exact token string from the REDACTED VALUES list.

TASK: {request.task.sanitized}
RISK: {request.task.risk}
ORIGIN: {request.session.origin}

SCENE NODES:
{chr(10).join(nodes_desc)}

REDACTED VALUES:
{chr(10).join(redactions_desc) if redactions_desc else "  (none)"}

ALLOWED ACTIONS: {allowed}

Return JSON:
{{"actions": [{{"kind": "click|type_token|type_text|focus|scroll|wait|finish|request_observation",
               "id": "action-1", "targetNodeId": "<scene-node-id>",
               "text": "<only for type_text>", "token": "<SENSITIVE_... only for type_token>",
               "reason": "<brief explanation>"}}]}}
"""

    def _parse_actions(
        self, plan_data: dict, request: PlannerRequest
    ) -> list[AgentAction]:
        actions: list[AgentAction] = []
        raw_actions = plan_data.get("actions", [])

        valid_kinds = {
            "click", "focus", "type_text", "type_token", "select",
            "scroll", "wait", "request_observation", "finish",
        }
        node_ids = {n.id for n in request.scene.nodes}

        for i, raw in enumerate(raw_actions[:5]):
            if not isinstance(raw, dict):
                continue

            kind = raw.get("kind", "")
            if kind not in valid_kinds:
                continue

            target = raw.get("targetNodeId")
            if target and target not in node_ids:
                continue

            actions.append(
                AgentAction(
                    kind=kind,
                    id=raw.get("id", f"action-{i + 1}"),
                    targetNodeId=target,
                    text=raw.get("text"),
                    token=raw.get("token"),
                    expectedRole=raw.get("expectedRole"),
                    reason=raw.get("reason"),
                    milliseconds=raw.get("milliseconds"),
                )
            )

        return actions


# ── Metrics ───────────────────────────────────────────────────

request_log: list[dict] = []

# ── Endpoints ─────────────────────────────────────────────────

@app.get("/v1/health")
async def health():
    return {
        "status": "ok",
        "adapter": current_adapter.name,
        "version": "0.1.0",
        "requestsServed": len(request_log),
    }

@app.get("/v1/metrics")
async def metrics():
    return {
        "totalRequests": len(request_log),
        "recentRequests": request_log[-10:] if request_log else [],
    }

@app.post("/v1/plan", response_model=PlannerResponse, response_model_exclude_none=True)
async def plan(request: Request):
    start_time = time.time()
    
    # Read body
    body = await request.body()
    seal = request.headers.get("X-Antardrishti-Seal", "none")
    
    try:
        data = json.loads(body)
        planner_request = PlannerRequest(**data)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid request: {e}")
    
    # Validate protocol version
    if planner_request.protocolVersion != "2.0":
        raise HTTPException(status_code=400, detail="Unsupported protocol version")
    
    # Validate redactions are present
    # (contract §13: every request must declare redactions)
    # Note: empty redactions[] is valid if page has no PII
    
    # Plan
    try:
        response = await current_adapter.plan(planner_request)
    except PlannerFailureError as pf:
        elapsed_ms = round((time.time() - start_time) * 1000)
        # Log failure (category-only, no raw content)
        request_log.append({
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "observationId": planner_request.session.observationId,
            "origin": planner_request.session.origin,
            "task_risk": planner_request.task.risk,
            "nodeCount": len(planner_request.scene.nodes),
            "redactionCount": len(planner_request.redactions),
            "actionCount": 0,
            "actionKinds": [],
            "planId": None,
            "seal": seal[:16] + "..." if len(seal) > 16 else seal,
            "latencyMs": elapsed_ms,
            "adapter": current_adapter.name,
            "error": pf.category,
        })
        print(f"[Planner] FAILURE | {current_adapter.name} | {elapsed_ms}ms | {pf.category}: {pf.message}")
        raise HTTPException(
            status_code=pf.http_status,
            detail={
                "category": pf.category,
                "message": pf.message,
            },
        )
    
    elapsed_ms = round((time.time() - start_time) * 1000)
    
    # Log (category-only, no raw content)
    request_log.append({
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "observationId": planner_request.session.observationId,
        "origin": planner_request.session.origin,
        "task_risk": planner_request.task.risk,
        "nodeCount": len(planner_request.scene.nodes),
        "redactionCount": len(planner_request.redactions),
        "actionCount": len(response.actions),
        "actionKinds": [a.kind for a in response.actions],
        "planId": response.planId,
        "seal": seal[:16] + "..." if len(seal) > 16 else seal,
        "latencyMs": elapsed_ms,
        "adapter": current_adapter.name,
    })
    
    print(f"[Planner] {current_adapter.name} | {elapsed_ms}ms | "
          f"nodes={len(planner_request.scene.nodes)} | "
          f"redactions={len(planner_request.redactions)} | "
          f"actions={len(response.actions)} [{', '.join(a.kind for a in response.actions)}]")
    
    return response


# ── Startup ───────────────────────────────────────────────────

current_adapter: PlannerAdapter = MockPlanner()


def main():
    parser = argparse.ArgumentParser(description="ANTARDRISHTI Planner Server")
    parser.add_argument(
        "--adapter",
        choices=["mock", "llm"],
        default="mock",
        help="Planner adapter (mock=deterministic, llm=real LLM)",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("ANTARDRISHTI_LLM_MODEL", "gpt-4o-mini"),
        help="LLM model name",
    )
    parser.add_argument(
        "--openai",
        action="store_true",
        default=True,
        help="Use OpenAI-compatible API (default: True)",
    )
    parser.add_argument(
        "--ollama",
        action="store_true",
        default=False,
        help="Use local Ollama (overrides --openai)",
    )
    parser.add_argument(
        "--llm-url",
        default=os.environ.get("ANTARDRISHTI_LLM_BASE_URL", "https://api.openai.com/v1"),
        help="LLM API base URL",
    )
    parser.add_argument("--host", default="0.0.0.0", help="Server host")
    parser.add_argument("--port", type=int, default=8000, help="Server port")
    parser.add_argument("--reload", action="store_true", help="Enable hot reload")
    args = parser.parse_args()

    global current_adapter
    if args.adapter == "llm":
        use_openai = not args.ollama
        if args.ollama:
            base_url = args.llm_url if "11434" in args.llm_url else "http://localhost:11434"
        else:
            base_url = args.llm_url

        api_key = os.environ.get("ANTARDRISHTI_LLM_API_KEY", "")
        current_adapter = LLMPlanner(
            model=args.model,
            base_url=base_url,
            api_key=api_key,
            use_openai_format=use_openai,
        )
        backend_label = "Ollama" if args.ollama else "OpenAI-compatible"
        print(f"[Planner] LLM adapter ({backend_label}): {current_adapter.model} @ {current_adapter.base_url}")
        if use_openai and not api_key:
            print("[Planner] WARNING: ANTARDRISHTI_LLM_API_KEY not set")
    else:
        current_adapter = MockPlanner()
        print("[Planner] Mock (deterministic) adapter")

    print(f"[Planner] Starting on http://{args.host}:{args.port}")
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
    )


if __name__ == "__main__":
    main()
