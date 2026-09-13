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
        # Auto-detect: Ollama uses its own format, others use OpenAI
        if "11434" in self.base_url or "ollama" in self.base_url.lower():
            self.use_openai_format = False

    async def plan(self, request: PlannerRequest) -> PlannerResponse:
        import httpx

        prompt = self._build_prompt(request)
        actions: list[AgentAction] = []

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
                        "max_tokens": 512,
                        "response_format": {"type": "json_object"},
                    }

                    resp = await client.post(
                        f"{self.base_url}/chat/completions",
                        headers=headers,
                        json=payload,
                    )
                    resp.raise_for_status()
                    raw_text = resp.json()["choices"][0]["message"]["content"]

                else:
                    # Ollama native format
                    payload = {
                        "model": self.model,
                        "prompt": prompt,
                        "stream": False,
                        "format": "json",
                        "options": {"temperature": 0.1, "num_predict": 512},
                    }
                    resp = await client.post(
                        f"{self.base_url}/api/generate",
                        json=payload,
                    )
                    resp.raise_for_status()
                    raw_text = resp.json().get("response", "{}")

                plan_data = json.loads(raw_text)
                actions = self._parse_actions(plan_data, request)
                print(f"[LLMPlanner] {self.model} returned {len(actions)} actions")

        except Exception as e:
            print(f"[LLMPlanner] LLM call failed: {e}")
            actions = [
                AgentAction(
                    kind="request_observation",
                    id="action-fallback",
                    reason=f"LLM planning failed: {type(e).__name__}",
                )
            ]

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
        actions = []
        raw_actions = plan_data.get("actions", [])

        valid_kinds = {
            "click", "focus", "type_text", "type_token", "select",
            "scroll", "wait", "request_observation", "finish",
        }
        node_ids = {n.id for n in request.scene.nodes}

        for i, raw in enumerate(raw_actions[:5]):
            kind = raw.get("kind", "")
            if kind not in valid_kinds:
                continue

            target = raw.get("targetNodeId")
            if target and target not in node_ids:
                reason="No valid actions parsed from LLM response",
            ))
        
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

@app.post("/v1/plan", response_model=PlannerResponse)
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
    response = await current_adapter.plan(planner_request)
    
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
        print(f"[Planner] LLM adapter ({backend_label}): {args.model} @ {base_url}")
        if use_openai and not api_key:
            print("[Planner] WARNING: ANTARDRISHTI_LLM_API_KEY not set")
    else:
        current_adapter = MockPlanner()
        print("[Planner] Mock (deterministic) adapter")

    print(f"[Planner] Starting on http://{args.host}:{args.port}")
    uvicorn.run(
        "server:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
