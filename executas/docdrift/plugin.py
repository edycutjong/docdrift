#!/usr/bin/env python3
"""plugin.py — DocDrift Executa plugin.

Exposes 3 tools for code-to-docs drift detection:
  1. project.scan  — Walks file tree, extracts symbols, hashes state
  2. docs.crossref — Finds doc mentions, encrypts snippets, classifies drift via LLM
  3. docs.patchgen — Generates unified diffs from accepted changes
"""

from __future__ import annotations

import json
import os
import sys
import threading
import uuid
import queue
import hashlib
import re
import secrets
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# ─── Manifest ────────────────────────────────────────────────────────

MANIFEST = {
    "name": "docdrift",
    "display_name": "DocDrift Engine",
    "version": "0.3.0",
    "description": "Scans workspace directory, extracts code symbols, audits markdown documents, and generates patches.",
    "author": "DocDrift",
    "icon": "🔍",
    "category": "developer-tools",
    "license": "MIT",
    "host_capabilities": ["llm.sample", "llm.embed", "llm.image", "llm.agent.auto", "host.upload"],
    "tools": [
      {
        "name": "project.scan",
        "description": "Walks directory tree, extracts symbols, hashes codebase files.",
        "timeout": 120,
        "parameters": [
          {
            "name": "path",
            "type": "string",
            "description": "Target workspace path to scan",
            "required": True
          }
        ]
      },
      {
        "name": "docs.crossref",
        "description": "Finds doc references, encrypts snippets, and classifies drifts using LLM.",
        "timeout": 180,
        "parameters": [
          {
            "name": "symbols",
            "type": "array",
            "items": {"type": "object"},
            "description": "Symbol list returned by project.scan",
            "required": True
          },
          {
            "name": "docFile",
            "type": "string",
            "description": "Doc file path to cross-reference",
            "required": True
          }
        ]
      },
      {
        "name": "docs.patchgen",
        "description": "Generates verified unified patches from accepted drift review items.",
        "timeout": 120,
        "parameters": [
          {
            "name": "drifts",
            "type": "array",
            "items": {"type": "object"},
            "description": "List of accepted drift items",
            "required": True
          }
        ]
      },
      {
        "name": "project.semantic_search",
        "description": "Semantic search across code symbols and doc sections using vector embeddings (Anna llm.embed).",
        "timeout": 60,
        "parameters": [
          {
            "name": "query",
            "type": "string",
            "description": "Natural language search query",
            "required": True
          },
          {
            "name": "symbols",
            "type": "array",
            "items": {"type": "object"},
            "description": "Symbol list from project.scan",
            "required": True
          }
        ]
      },
      {
        "name": "project.generate_diagram",
        "description": "Generates an AI architecture diagram for the scanned project using Anna image/generate.",
        "timeout": 120,
        "parameters": [
          {
            "name": "stats",
            "type": "object",
            "description": "Project stats from project.scan",
            "required": True
          }
        ]
      },
      {
        "name": "project.file_archive",
        "description": "Manages durable file archive in Anna Persistent Storage (APS Files). Actions: save, list, download, delete.",
        "timeout": 60,
        "parameters": [
          {
            "name": "action",
            "type": "string",
            "description": "Action: save|list|download|delete",
            "required": True
          },
          {
            "name": "path",
            "type": "string",
            "description": "File path within archive",
            "required": False
          },
          {
            "name": "content",
            "type": "string",
            "description": "File content (for save action)",
            "required": False
          }
        ]
      },
      {
        "name": "project.history",
        "description": "Lists or deletes scan history entries from Anna Persistent Storage.",
        "timeout": 30,
        "parameters": [
          {
            "name": "action",
            "type": "string",
            "description": "Action: list|delete",
            "required": True
          },
          {
            "name": "key",
            "type": "string",
            "description": "Key to delete (for delete action)",
            "required": False
          }
        ]
      }
    ],
    "credentials": [
      {
        "name": "GITHUB_TOKEN",
        "display_name": "GitHub Personal Access Token",
        "description": "Optional: GitHub → Settings → Developer Settings → Tokens",
        "required": False,
        "sensitive": True
      }
    ],
    "runtime": {"type": "uv", "min_version": "0.1.0"}
}

# ─── Reverse-RPC infrastructure ──────────────────────────────────────

_stdout_lock = threading.Lock()
_host_responses: dict[str, queue.Queue] = {}
_agent_requests: queue.Queue = queue.Queue()
_v2_negotiated = False

def _write_frame(msg: dict) -> None:
    payload = json.dumps(msg, ensure_ascii=False)
    with _stdout_lock:
        sys.stdout.write(payload + "\n")
        sys.stdout.flush()

def _reader():
    """Single stdin reader — demuxes agent requests and host RPC responses."""
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "method" in msg:
            _agent_requests.put(msg)
        else:
            rid = msg.get("id")
            q = _host_responses.pop(rid, None)
            if q is not None:
                q.put(msg)
            else:
                print(f"⚠️  unmatched response id={rid!r}", file=sys.stderr)

def _sample(invoke_id: str, system_prompt: str, user_message: str,
            *, max_tokens: int = 1024, timeout: float = 90.0) -> str:
    """Issue a sampling/createMessage reverse RPC to the host."""
    global _v2_negotiated
    if not _v2_negotiated:
        raise ConnectionError("Anna V2 protocol not negotiated. Direct external API call fallback is disabled.")

    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q

    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "sampling/createMessage",
        "params": {
            "messages": [
                {
                    "role": "user",
                    "content": {"type": "text", "text": user_message},
                }
            ],
            "maxTokens": max_tokens,
            "systemPrompt": system_prompt,
            "includeContext": "none",
            "metadata": {
                "executa_invoke_id": invoke_id,
                "tool": "docdrift-engine",
            },
        },
    })

    try:
        resp = q.get(timeout=timeout)
    except queue.Empty:
        raise TimeoutError("sampling/createMessage timed out")

    if "error" in resp:
        err = resp["error"]
        raise RuntimeError(
            f"Sampling error {err.get('code', '?')}: {err.get('message', str(err))}"
        )

    content = resp.get("result", {}).get("content", {})
    if isinstance(content, dict) and content.get("type") == "text":
        return content.get("text", "")
    return str(content)

# ─── Anna Persistent Storage (APS KV) reverse-RPC ────────────────────
# Uses storage/get and storage/set to persist scan history in Anna's
# per-user KV store. No external database needed.

def _storage_get(key, scope="user"):
    """Read a key from Anna Persistent Storage via reverse-RPC."""
    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "storage/get",
        "params": {"key": key, "scope": scope}
    })
    try:
        resp = q.get(timeout=15.0)
        if "error" in resp:
            return {"exists": False, "value": None}
        return resp.get("result", {"exists": False, "value": None})
    except queue.Empty:
        return {"exists": False, "value": None}

def _storage_set(key, value, scope="user"):
    """Write a key to Anna Persistent Storage via reverse-RPC."""
    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "storage/set",
        "params": {"key": key, "value": value, "scope": scope}
    })
    try:
        resp = q.get(timeout=15.0)
        if "error" in resp:
            return {"ok": False}
        return resp.get("result", {"ok": True})
    except queue.Empty:
        return {"ok": False}

# ─── Anna Host Upload (R2) reverse-RPC ────────────────────────────────
# Upload artifacts to Anna's R2 bucket via host/uploadFile.

def _host_upload_inline(filename, mime_type, content_bytes, purpose="artifact"):
    """Upload a file to Anna R2 via inline base64 reverse-RPC."""
    import base64
    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "host/uploadFile",
        "params": {
            "mode": "inline",
            "filename": filename,
            "mime_type": mime_type,
            "content_b64": base64.b64encode(content_bytes).decode("ascii"),
            "purpose": purpose
        }
    })
    try:
        resp = q.get(timeout=30.0)
        if "error" in resp:
            return {"download_url": None, "error": str(resp["error"])}
        return resp.get("result", {"download_url": None})
    except queue.Empty:
        return {"download_url": None, "error": "timeout"}

# ─── Embeddings reverse-RPC (llm.embed) ──────────────────────────────
# Uses embeddings/create to compute dense vector embeddings via the host's
# embedding model. No API key needed — billed on user's plan.

def _embed(texts, *, timeout=30.0):
    """Compute embeddings via host reverse-RPC. Returns list of embedding vectors."""
    global _v2_negotiated
    if not _v2_negotiated:
        # Fallback: return zero-vectors for local dev
        print("[Embed] Fallback: v2 not negotiated, returning mock embeddings", file=sys.stderr)
        return [{"embedding": [0.0] * 64, "dimensions": 64} for _ in (texts if isinstance(texts, list) else [texts])]

    if isinstance(texts, str):
        texts = [texts]

    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "embeddings/create",
        "params": {
            "input": texts,
            "model": "anna-managed-v1"
        }
    })
    try:
        resp = q.get(timeout=timeout)
        if "error" in resp:
            print(f"[Embed] Error: {resp['error']}", file=sys.stderr)
            return [{"embedding": [0.0] * 64, "dimensions": 64} for _ in texts]
        result = resp.get("result", {})
        data = result.get("data", [])
        return [{"embedding": item.get("embedding", []), "dimensions": result.get("_meta", {}).get("dimensions", 1536)} for item in data]
    except queue.Empty:
        print("[Embed] Timed out", file=sys.stderr)
        return [{"embedding": [0.0] * 64, "dimensions": 64} for _ in texts]

def _cosine_similarity(a, b):
    """Compute cosine similarity between two vectors."""
    import math
    dot = sum(x * y for x, y in zip(a, b))
    mag_a = math.sqrt(sum(x * x for x in a))
    mag_b = math.sqrt(sum(x * x for x in b))
    if mag_a == 0 or mag_b == 0:
        return 0.0
    return dot / (mag_a * mag_b)

# ─── Image generation reverse-RPC (llm.image) ────────────────────────
# Uses image/generate to create AI-generated images via the host's image provider.

def _image_generate(prompt, *, n=1, size="1024x1024", invoke_id="", timeout=120.0):
    """Generate images via host reverse-RPC. Returns list of image URLs."""
    global _v2_negotiated
    if not _v2_negotiated:
        print("[Image] Fallback: v2 not negotiated, returning placeholder", file=sys.stderr)
        return [{"url": "https://placehold.co/1024x1024/1a1a2e/06b6d4?text=DocDrift+Diagram"}]

    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "image/generate",
        "params": {
            "prompt": prompt,
            "n": n,
            "size": size,
            "metadata": {"executa_invoke_id": invoke_id}
        }
    })
    try:
        resp = q.get(timeout=timeout)
        if "error" in resp:
            print(f"[Image] Error: {resp['error']}", file=sys.stderr)
            return [{"url": "https://placehold.co/1024x1024/1a1a2e/06b6d4?text=Generation+Failed"}]
        result = resp.get("result", {})
        images = result.get("images", [])
        return images if images else [{"url": "https://placehold.co/1024x1024/1a1a2e/06b6d4?text=No+Image"}]
    except queue.Empty:
        print("[Image] Timed out", file=sys.stderr)
        return [{"url": "https://placehold.co/1024x1024/1a1a2e/06b6d4?text=Timeout"}]

# ─── APS Files reverse-RPC (files/*) ─────────────────────────────────
# Durable per-user file storage. Unlike host/uploadFile (transient R2),
# these persist in Anna Persistent Storage and are user-browsable.

def _files_upload(path, content_bytes, content_type, scope="app"):
    """Two-phase upload to APS Files. Returns object entry dict."""
    import urllib.request
    global _v2_negotiated
    if not _v2_negotiated:
        print("[Files] Fallback: v2 not negotiated", file=sys.stderr)
        return {"path": path, "mock": True}

    # Phase 1: upload_begin
    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "files/upload_begin",
        "params": {
            "scope": scope,
            "path": path,
            "size_bytes": len(content_bytes),
            "content_type": content_type
        }
    })
    try:
        resp = q.get(timeout=60.0)
        if "error" in resp:
            print(f"[Files] upload_begin error: {resp['error']}", file=sys.stderr)
            return {"error": str(resp["error"])}
        begin_result = resp.get("result", {})
    except queue.Empty:
        return {"error": "upload_begin timeout"}

    # PUT bytes to presigned URL
    put_url = begin_result.get("upload_url") or begin_result.get("url")
    headers_dict = begin_result.get("headers", {})
    if put_url:
        try:
            req = urllib.request.Request(put_url, data=content_bytes, method="PUT")
            req.add_header("Content-Type", content_type)
            for k, v in headers_dict.items():
                req.add_header(k, v)
            urllib.request.urlopen(req, timeout=60)
        except Exception as e:
            print(f"[Files] PUT failed: {e}", file=sys.stderr)
            return {"error": f"PUT failed: {e}"}

    # Phase 2: upload_complete
    rid2 = str(uuid.uuid4())
    q2: queue.Queue = queue.Queue()
    _host_responses[rid2] = q2
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid2,
        "method": "files/upload_complete",
        "params": {"scope": scope, "path": path}
    })
    try:
        resp2 = q2.get(timeout=60.0)
        if "error" in resp2:
            print(f"[Files] upload_complete error: {resp2['error']}", file=sys.stderr)
            return {"error": str(resp2["error"])}
        return resp2.get("result", {})
    except queue.Empty:
        return {"error": "upload_complete timeout"}

def _files_download_url(path, scope="app"):
    """Mint a presigned GET URL for a stored file."""
    global _v2_negotiated
    if not _v2_negotiated:
        return {"url": None, "mock": True}
    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "files/download_url",
        "params": {"scope": scope, "path": path}
    })
    try:
        resp = q.get(timeout=15.0)
        if "error" in resp:
            return {"url": None, "error": str(resp["error"])}
        return resp.get("result", {})
    except queue.Empty:
        return {"url": None, "error": "timeout"}

def _files_list(prefix="", scope="app"):
    """List objects in APS Files by prefix."""
    global _v2_negotiated
    if not _v2_negotiated:
        return {"items": [], "mock": True}
    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "files/list",
        "params": {"scope": scope, "prefix": prefix}
    })
    try:
        resp = q.get(timeout=15.0)
        if "error" in resp:
            return {"items": [], "error": str(resp["error"])}
        return resp.get("result", {})
    except queue.Empty:
        return {"items": [], "error": "timeout"}

def _files_delete(path, scope="app"):
    """Delete a stored file from APS Files."""
    global _v2_negotiated
    if not _v2_negotiated:
        return {"ok": False, "mock": True}
    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "files/delete",
        "params": {"scope": scope, "path": path}
    })
    try:
        resp = q.get(timeout=15.0)
        if "error" in resp:
            return {"ok": False, "error": str(resp["error"])}
        return {"ok": True}
    except queue.Empty:
        return {"ok": False, "error": "timeout"}

# ─── Storage list & delete reverse-RPC ────────────────────────────────

def _storage_list(prefix="", scope="user"):
    """List keys in APS KV by prefix."""
    global _v2_negotiated
    if not _v2_negotiated:
        return {"items": [], "mock": True}
    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "storage/list",
        "params": {"scope": scope, "prefix": prefix}
    })
    try:
        resp = q.get(timeout=15.0)
        if "error" in resp:
            return {"items": []}
        return resp.get("result", {"items": []})
    except queue.Empty:
        return {"items": []}

def _storage_delete(key, scope="user"):
    """Delete a key from APS KV."""
    global _v2_negotiated
    if not _v2_negotiated:
        return {"ok": False, "mock": True}
    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "storage/delete",
        "params": {"scope": scope, "key": key}
    })
    try:
        resp = q.get(timeout=15.0)
        if "error" in resp:
            return {"ok": False}
        return {"ok": True}
    except queue.Empty:
        return {"ok": False}

# ─── Agent Sessions reverse-RPC (llm.agent.auto) ─────────────────────
# Multi-turn, tool-using agent sessions. The plugin drives the agent,
# receiving buffered SSE frames.

def _agent_session_create(*, label="DocDrift Agent", ttl_seconds=600):
    """Create a stateful agent session via reverse-RPC."""
    global _v2_negotiated
    if not _v2_negotiated:
        return {"app_session_uuid": f"mock_aps_{uuid.uuid4().hex[:8]}", "mock": True}
    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "agent/session.create",
        "params": {
            "agent_submode": "auto",
            "label": label,
            "ttl_seconds": ttl_seconds
        }
    })
    try:
        resp = q.get(timeout=30.0)
        if "error" in resp:
            print(f"[Agent] session.create error: {resp['error']}", file=sys.stderr)
            return {"app_session_uuid": None, "error": str(resp["error"])}
        return resp.get("result", {})
    except queue.Empty:
        return {"app_session_uuid": None, "error": "timeout"}

def _agent_session_run(session_uuid, content, *, system=None):
    """Submit a turn to an agent session. Returns buffered frames."""
    global _v2_negotiated
    if not _v2_negotiated:
        return {"frames": [{"event": "final", "content": "Mock agent response for: " + content}], "mock": True}
    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    params = {
        "app_session_uuid": session_uuid,
        "content": content
    }
    if system:
        params["system"] = system
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "agent/session.run",
        "params": params
    })
    try:
        resp = q.get(timeout=120.0)
        if "error" in resp:
            return {"frames": [], "error": str(resp["error"])}
        return resp.get("result", {})
    except queue.Empty:
        return {"frames": [], "error": "timeout"}

def _agent_session_delete(session_uuid):
    """Delete an agent session."""
    global _v2_negotiated
    if not _v2_negotiated:
        return {"ok": True, "mock": True}
    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "agent/session.delete",
        "params": {"app_session_uuid": session_uuid}
    })
    try:
        resp = q.get(timeout=15.0)
        return {"ok": True}
    except queue.Empty:
        return {"ok": False}

def _agent_complete(prompt, system=None):
    """One-shot completion via Anna server (L1)."""
    global _v2_negotiated
    if not _v2_negotiated:
        return {"content": "Mock one-shot completion response.", "mock": True}
    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    params = {"prompt": prompt}
    if system:
        params["system"] = system
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "agent/complete",
        "params": params
    })
    try:
        resp = q.get(timeout=60.0)
        if "error" in resp:
            return {"content": "", "error": str(resp["error"])}
        return resp.get("result", {"content": ""})
    except queue.Empty:
        return {"content": "", "error": "timeout"}

def _agent_session_history(session_uuid):
    """Retrieve history transcript of an agent session."""
    global _v2_negotiated
    if not _v2_negotiated:
        return {"messages": [{"role": "user", "content": "Hello"}, {"role": "agent", "content": "Mock reply"}], "mock": True}
    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "agent/session.history",
        "params": {"app_session_uuid": session_uuid}
    })
    try:
        resp = q.get(timeout=15.0)
        if "error" in resp:
            return {"messages": [], "error": str(resp["error"])}
        return resp.get("result", {"messages": []})
    except queue.Empty:
        return {"messages": [], "error": "timeout"}

def _agent_session_cancel(session_uuid):
    """Abort an in-flight run for an agent session."""
    global _v2_negotiated
    if not _v2_negotiated:
        return {"ok": True, "mock": True}
    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "agent/session.cancel",
        "params": {"app_session_uuid": session_uuid}
    })
    try:
        resp = q.get(timeout=15.0)
        if "error" in resp:
            return {"ok": False, "error": str(resp["error"])}
        return resp.get("result", {"ok": True})
    except queue.Empty:
        return {"ok": False, "error": "timeout"}

def _image_edit(image_url, prompt, n=1, size="1024x1024"):
    """Restyle/inpaint an existing image."""
    global _v2_negotiated
    if not _v2_negotiated:
        return [{"url": "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=500", "mock": True}]
    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "image/edit",
        "params": {
            "image_url": image_url,
            "prompt": prompt,
            "n": n,
            "size": size
        }
    })
    try:
        resp = q.get(timeout=120.0)
        if "error" in resp:
            return [{"url": "", "error": str(resp["error"])}]
        return resp.get("result", [])
    except queue.Empty:
        return [{"url": "", "error": "timeout"}]

def _host_upload_negotiate(filename, mime_type, byte_length, purpose="artifact"):
    """Request a presigned upload URL for a file."""
    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "host/uploadFile",
        "params": {
            "mode": "negotiate",
            "filename": filename,
            "mime_type": mime_type,
            "byte_length": byte_length,
            "purpose": purpose
        }
    })
    try:
        resp = q.get(timeout=30.0)
        if "error" in resp:
            return {"r2_key": None, "upload_url": None, "error": str(resp["error"])}
        return resp.get("result", {"r2_key": None, "upload_url": None})
    except queue.Empty:
        return {"r2_key": None, "upload_url": None, "error": "timeout"}

def _host_upload_confirm(r2_key):
    """Confirm a completed upload and retrieve download URL."""
    rid = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _host_responses[rid] = q
    _write_frame({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "host/uploadFile",
        "params": {
            "mode": "confirm",
            "r2_key": r2_key
        }
    })
    try:
        resp = q.get(timeout=30.0)
        if "error" in resp:
            return {"download_url": None, "error": str(resp["error"])}
        return resp.get("result", {"download_url": None})
    except queue.Empty:
        return {"download_url": None, "error": "timeout"}

def _sample_json(invoke_id: str, system_prompt: str, user_message: str,

                 *, max_tokens: int = 1024) -> dict:
    """Issue sampling and parse the result as JSON."""
    raw = _sample(invoke_id, system_prompt, user_message, max_tokens=max_tokens)
    raw = raw.strip()
    
    # Handle markdown-wrapped JSON
    if raw.startswith("```"):
        lines = raw.split("\n")
        json_lines = []
        in_block = False
        for line in lines:
            if line.strip().startswith("```") and not in_block:
                in_block = True
                continue
            elif line.strip() == "```" and in_block:
                break
            elif in_block:
                json_lines.append(line)
        raw = "\n".join(json_lines)

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}") + 1
        if start >= 0 and end > start:
            try:
                return json.loads(raw[start:end])
            except json.JSONDecodeError:
                pass
        return {"raw_text": raw, "parse_error": True}

# ─── Cryptographic Helpers ───────────────────────────────────────────

def encrypt_snippet(plaintext: str) -> dict:
    """Encrypts a code snippet using AES-GCM-256."""
    key = AESGCM.generate_key(bit_length=256)
    aesgcm = AESGCM(key)
    nonce = secrets.token_bytes(12)
    ciphertext = aesgcm.encrypt(nonce, plaintext.encode('utf-8'), None)
    return {
        "key": key.hex(),
        "nonce": nonce.hex(),
        "ciphertext": ciphertext.hex()
    }

def decrypt_snippet(ciphertext_hex: str, key_hex: str, nonce_hex: str) -> str:
    """Decrypts a code snippet using AES-GCM-256."""
    key = bytes.fromhex(key_hex)
    nonce = bytes.fromhex(nonce_hex)
    ciphertext = bytes.fromhex(ciphertext_hex)
    aesgcm = AESGCM(key)
    plaintext_bytes = aesgcm.decrypt(nonce, ciphertext, None)
    return plaintext_bytes.decode('utf-8')

# ─── Tool Implementations ────────────────────────────────────────────

def _extract_symbols_from_file(file_path: str) -> list[dict]:
    ext = os.path.splitext(file_path)[1]
    symbols = []
    
    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
            lines = content.splitlines()
    except Exception as e:
        print(f"Error reading {file_path}: {e}", file=sys.stderr)
        return []

    # Simple regex parsers matching signature definitions
    if ext in (".js", ".ts"):
        # Matches: export function name(args) or export class name or export const name =
        func_pat = re.compile(r'(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\(')
        class_pat = re.compile(r'(?:export\s+)?class\s+([a-zA-Z0-9_]+)')
        const_pat = re.compile(r'export\s+(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=')
        
        for idx, line in enumerate(lines):
            m_func = func_pat.search(line)
            if m_func:
                symbols.append({"name": m_func.group(1), "line": idx + 1, "type": "function"})
                continue
            m_class = class_pat.search(line)
            if m_class:
                symbols.append({"name": m_class.group(1), "line": idx + 1, "type": "class"})
                continue
            m_const = const_pat.search(line)
            if m_const:
                symbols.append({"name": m_const.group(1), "line": idx + 1, "type": "constant"})
                
    elif ext == ".py":
        # Matches def func_name( or class ClassName: or variable assignments
        def_pat = re.compile(r'^\s*def\s+([a-zA-Z0-9_]+)\s*\(')
        class_pat = re.compile(r'^\s*class\s+([a-zA-Z0-9_]+)\b')
        dep_pat = re.compile(r'#\s*@deprecated')
        
        for idx, line in enumerate(lines):
            m_def = def_pat.search(line)
            if m_def:
                # Check if deprecated comment is immediately preceding
                is_deprecated = False
                if idx > 0 and dep_pat.search(lines[idx-1]):
                    is_deprecated = True
                symbols.append({
                    "name": m_def.group(1), 
                    "line": idx + 1, 
                    "type": "function",
                    "deprecated": is_deprecated
                })
                continue
            m_class = class_pat.search(line)
            if m_class:
                symbols.append({"name": m_class.group(1), "line": idx + 1, "type": "class"})
                
    elif ext == ".go":
        # Matches func FuncName( or type TypeName struct
        func_pat = re.compile(r'^\s*func\s+(?:\([^)]+\)\s+)?([a-zA-Z0-9_]+)\s*\(')
        struct_pat = re.compile(r'^\s*type\s+([a-zA-Z0-9_]+)\s+struct')
        
        for idx, line in enumerate(lines):
            m_func = func_pat.search(line)
            if m_func:
                symbols.append({"name": m_func.group(1), "line": idx + 1, "type": "function"})
                continue
            m_struct = struct_pat.search(line)
            if m_struct:
                symbols.append({"name": m_struct.group(1), "line": idx + 1, "type": "struct"})

    # Compute SHA-256 for symbol declarations
    for sym in symbols:
        sym["file"] = file_path
        # Compute a hash representing the signature text
        sig_line = lines[sym["line"] - 1].strip()
        sym["hash"] = hashlib.sha256(sig_line.encode("utf-8")).hexdigest()
        
    return symbols

def _tool_project_scan(invoke_id: str, args: dict) -> dict:
    path = args.get("path")

    if not path or not os.path.exists(path):
        raise FileNotFoundError(f"Path does not exist: {path}")

    print(f"[DocDrift] Auditing path: {path}", file=sys.stderr)

    code_exts = (".js", ".ts", ".py", ".go")
    doc_exts = (".md", ".txt", ".rst")
    
    all_symbols = []
    doc_files = []
    
    for root, dirs, files in os.walk(path):
        # Skip common directories
        if any(p in root for p in ("node_modules", ".git", ".venv", "__pycache__", "build", "dist")):
            continue
            
        for file in files:
            full_path = os.path.join(root, file)
            rel_path = os.path.relpath(full_path, path)
            ext = os.path.splitext(file)[1]
            
            if ext in code_exts:
                all_symbols.extend(_extract_symbols_from_file(full_path))
            elif ext in doc_exts or file.startswith("README"):
                # Count potential matches for simplicity
                doc_files.append({"path": full_path, "rel_path": rel_path, "mentionsCount": 0})

    # Update relative path representation for clean output
    for sym in all_symbols:
        sym["rel_file"] = os.path.relpath(sym["file"], path)

    stats = {
        "total_files_scanned": len(doc_files) + len(set(sym["file"] for sym in all_symbols)),
        "code_symbols_extracted": len(all_symbols),
        "doc_files_found": len(doc_files)
    }

    # ─── Persist scan results to Anna Persistent Storage (APS KV) ───
    try:
        scan_history = _storage_get("docdrift/scan_history")
        history_log = scan_history.get("value") if scan_history.get("exists") else []
        if not isinstance(history_log, list):
            history_log = []
        history_log.append({
            "ts": datetime.now(timezone.utc).isoformat(),
            "path": path,
            "symbols": stats["code_symbols_extracted"],
            "docs": stats["doc_files_found"],
            "files": stats["total_files_scanned"]
        })
        history_log = history_log[-50:]  # Keep last 50
        _storage_set("docdrift/scan_history", history_log)
        print(f"[APS] Scan persisted. Total history: {len(history_log)}", file=sys.stderr)
    except Exception as e:
        print(f"[APS] Failed to persist scan: {e}", file=sys.stderr)

    return {
        "symbols": all_symbols,
        "docFiles": doc_files,
        "stats": stats
    }

def _tool_docs_crossref(invoke_id: str, args: dict) -> dict:
    symbols = args.get("symbols") or []
    doc_file = args.get("docFile")
    
    if not doc_file or not os.path.exists(doc_file):
        raise FileNotFoundError(f"Doc file not found: {doc_file}")

    try:
        with open(doc_file, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
            lines = content.splitlines()
    except Exception as e:
        raise RuntimeError(f"Error reading doc file: {e}")

    # Extract symbols present in codebase
    symbol_names = {sym["name"]: sym for sym in symbols}
    
    drifts = []
    # Regex to find backtick-quoted references (e.g. `getUser()`)
    backtick_pat = re.compile(r'`([a-zA-Z0-9_\(\)\,\s\.\@]+)`')

    for idx, line in enumerate(lines):
        for match in backtick_pat.finditer(line):
            ref = match.group(1).strip()
            # Clean ref from trailing parens like getUser() -> getUser
            clean_ref = ref.split("(")[0].strip()
            # Clean decorator symbol @deprecated -> deprecated
            if clean_ref.startswith("@"):
                clean_ref = clean_ref[1:]

            # If it looks like a symbol but is NOT in our symbol table, check for drift
            if clean_ref and (re.search(r'^[a-zA-Z0-9_]+$', clean_ref) or "(" in ref):
                if clean_ref not in symbol_names:
                    # Potential drift!
                    # Construct local doc context snippet (3 lines before and after)
                    start_ctx = max(0, idx - 2)
                    end_ctx = min(len(lines), idx + 3)
                    snippet = "\n".join(lines[start_ctx:end_ctx])
                    
                    # ─── Cryptographic Snippet Protection (AES-GCM-256) ───
                    # We encrypt the snippet locally to safeguard proprietary IP in local storage
                    encrypted_data = encrypt_snippet(snippet)
                    print(f"[Crypto] Encrypted local snippet for reference '{ref}' in {os.path.basename(doc_file)}:L{idx+1}.", file=sys.stderr)
                    print(f"         IV: {encrypted_data['nonce']} | Tag: {encrypted_data['ciphertext'][-32:]}", file=sys.stderr)
                    
                    # Request LLM audit classification via Host reverse-RPC
                    system_prompt = (
                        "You are DocDrift, a strict code-to-docs drift auditor. Analyze the following unmatched documentation reference "
                        "against the codebase state and determine what type of drift has occurred. "
                        "Return ONLY a JSON object:\n"
                        '{"driftType": "renamed"|"deleted"|"signature_changed"|"deprecated"|"false_positive", '
                        '"confidence": 0.0-1.0, "suggestion": "updated markdown snippet or comment", "reason": "brief explanation"}'
                    )
                    
                    user_message = (
                        f"DOC FILE: {doc_file}\n"
                        f"LINE NUMBER: {idx + 1}\n"
                        f"STALE REFERENCE MENTIONED: `{ref}`\n"
                        f"DOC SNIPPET CONTEXT:\n{snippet}\n\n"
                        f"AVAILABLE CODE SYMBOLS:\n{json.dumps([s['name'] for s in symbols[:100]])}\n"
                    )
                    
                    verdict = _sample_json(invoke_id, system_prompt, user_message, max_tokens=384)
                    
                    if verdict.get("driftType") != "false_positive":
                        # Attempt to find the matching code symbol location if suggested
                        matching_symbol = symbol_names.get(verdict.get("suggestion", "").split("(")[0].strip())
                        code_file = matching_symbol.get("rel_file", "") if matching_symbol else ""
                        code_line = matching_symbol.get("line", 0) if matching_symbol else 0
                        
                        drifts.append({
                            "id": str(uuid.uuid4())[:8],
                            "docFile": doc_file,
                            "rel_docFile": os.path.basename(doc_file),
                            "line": idx + 1,
                            "reference": ref,
                            "driftType": verdict.get("driftType", "deleted"),
                            "confidence": verdict.get("confidence", 0.9),
                            "suggestion": verdict.get("suggestion", ""),
                            "reason": verdict.get("reason", ""),
                            "codeFile": code_file,
                            "codeLine": code_line,
                            # Save encrypted details in the state for secure persistent reviews
                            "encrypted_snippet": {
                                "ciphertext": encrypted_data["ciphertext"],
                                "nonce": encrypted_data["nonce"],
                                "key": encrypted_data["key"]
                            }
                        })
                else:
                    # Symbol matches perfectly, but let's check for deprecation drift!
                    matching_symbol = symbol_names[clean_ref]
                    if matching_symbol.get("deprecated", False):
                        drifts.append({
                            "id": str(uuid.uuid4())[:8],
                            "docFile": doc_file,
                            "rel_docFile": os.path.basename(doc_file),
                            "line": idx + 1,
                            "reference": ref,
                            "driftType": "deprecated",
                            "confidence": 1.0,
                            "suggestion": f"{ref} (DEPRECATED)",
                            "reason": "Symbol is marked deprecated in source code comments",
                            "codeFile": os.path.basename(matching_symbol.get("file", "")),
                            "codeLine": matching_symbol.get("line", 0)
                        })

    return {"drifts": drifts}

def _tool_docs_patchgen(invoke_id: str, args: dict) -> dict:
    drifts = args.get("drifts") or []
    
    patches = []
    file_drifts = {}
    
    # Group drifts by target doc file
    for drift in drifts:
        doc_file = drift.get("docFile")
        if not doc_file:
            continue
        if doc_file not in file_drifts:
            file_drifts[doc_file] = []
        file_drifts[doc_file].append(drift)

    for doc_file, drift_list in file_drifts.items():
        if not os.path.exists(doc_file):
            continue

        try:
            with open(doc_file, "r", encoding="utf-8") as f:
                content = f.read()
                lines = content.splitlines()
        except Exception as _err:
            continue

        # Sort drifts in descending line order to edit bottom-up
        sorted_drifts = sorted(drift_list, key=lambda d: d.get("line", 0), reverse=True)
        
        original_lines = list(lines)
        modified = False
        
        for drift in sorted_drifts:
            line_idx = drift.get("line", 1) - 1
            if 0 <= line_idx < len(lines):
                ref = drift.get("reference")
                suggestion = drift.get("suggestion")
                
                # Replace the reference on the line
                line_content = lines[line_idx]
                if f"`{ref}`" in line_content:
                    lines[line_idx] = line_content.replace(f"`{ref}`", f"`{suggestion}`")
                    modified = True

        if modified:
            new_content = "\n".join(lines)
            
            # Form unified-like diff format
            diff_lines = []
            diff_lines.append(f"--- a/{os.path.basename(doc_file)}")
            diff_lines.append(f"+++ b/{os.path.basename(doc_file)}")
            
            # Simple line-by-line diff
            for idx in range(max(len(original_lines), len(lines))):
                orig_l = original_lines[idx] if idx < len(original_lines) else ""
                new_l = lines[idx] if idx < len(lines) else ""
                if orig_l != new_l:
                    diff_lines.append(f"@@ -{idx+1} +{idx+1} @@")
                    diff_lines.append(f"- {orig_l}")
                    diff_lines.append(f"+ {new_l}")

            patches.append({
                "file": doc_file,
                "rel_file": os.path.basename(doc_file),
                "diff": "\n".join(diff_lines),
                "new_content": new_content
            })

    summary = f"Generated {len(patches)} doc patches."
    
    # ─── Upload patches to Anna R2 via host/uploadFile ───
    r2_urls = []
    for p in patches:
        try:
            patch_bytes = p["diff"].encode("utf-8")
            upload_result = _host_upload_inline(
                filename=f"docdrift-patch-{p['rel_file']}.diff",
                mime_type="text/x-diff",
                content_bytes=patch_bytes,
                purpose="artifact"
            )
            url = upload_result.get("download_url")
            if url:
                r2_urls.append({"file": p["rel_file"], "url": url})
                print(f"[R2] Patch uploaded: {url}", file=sys.stderr)
        except Exception as e:
            print(f"[R2] Failed to upload patch for {p['rel_file']}: {e}", file=sys.stderr)

    return {
        "patches": patches,
        "summary": summary,
        "r2_artifacts": r2_urls
    }

# ─── JSON-RPC Protocol Dispatcher ────────────────────────────────────

# ─── New Tool Implementations ─────────────────────────────────────────

def _tool_semantic_search(invoke_id: str, args: dict) -> dict:
    """Semantic search using vector embeddings."""
    query = args.get("query", "")
    symbols = args.get("symbols") or []
    if not query:
        return {"results": [], "error": "Query is required"}

    # Build text descriptions for each symbol
    symbol_texts = []
    for sym in symbols[:64]:  # embeddings/create max 64 items
        text = f"{sym.get('type', 'symbol')} {sym['name']} in {sym.get('rel_file', sym.get('file', 'unknown'))}"
        symbol_texts.append(text)

    if not symbol_texts:
        return {"results": [], "message": "No symbols to search"}

    # Embed query + symbols in one batch
    all_texts = [query] + symbol_texts
    embeddings = _embed(all_texts)

    if not embeddings or len(embeddings) < 2:
        return {"results": [], "error": "Embedding failed"}

    query_vec = embeddings[0]["embedding"]
    results = []
    for i, sym in enumerate(symbols[:64]):
        if i + 1 < len(embeddings):
            sim = _cosine_similarity(query_vec, embeddings[i + 1]["embedding"])
            results.append({
                "symbol": sym["name"],
                "type": sym.get("type", "unknown"),
                "file": sym.get("rel_file", sym.get("file", "")),
                "line": sym.get("line", 0),
                "similarity": round(sim, 4)
            })

    # Sort by similarity descending
    results.sort(key=lambda r: r["similarity"], reverse=True)
    return {
        "results": results[:10],
        "query": query,
        "total_compared": len(results),
        "embedding_dimensions": embeddings[0].get("dimensions", 1536)
    }

def _tool_generate_diagram(invoke_id: str, args: dict) -> dict:
    """Generate an AI architecture diagram."""
    stats = args.get("stats") or {}
    prompt = (
        f"A clean, modern software architecture diagram showing a project with "
        f"{stats.get('code_symbols_extracted', 0)} code symbols across "
        f"{stats.get('total_files_scanned', 0)} files and "
        f"{stats.get('doc_files_found', 0)} documentation files. "
        f"Dark mode with cyan (#06b6d4) accent lines on a #0f172a background. "
        f"Show interconnected nodes representing modules, APIs, and documentation layers. "
        f"Minimal, professional, technical schematic style."
    )
    images = _image_generate(prompt, invoke_id=invoke_id)
    return {
        "images": images,
        "prompt_used": prompt,
        "stats": stats
    }

def _tool_file_archive(invoke_id: str, args: dict) -> dict:
    """Manage durable file archive in APS Files."""
    action = args.get("action", "list")
    path = args.get("path", "")
    content = args.get("content", "")

    if action == "save":
        if not path or not content:
            return {"error": "path and content required for save"}
        content_bytes = content.encode("utf-8")
        result = _files_upload(f"docdrift/{path}", content_bytes, "text/plain")
        return {"action": "save", "path": path, "result": result}

    elif action == "list":
        result = _files_list(prefix="docdrift/")
        return {"action": "list", "files": result.get("items", [])}

    elif action == "download":
        if not path:
            return {"error": "path required for download"}
        result = _files_download_url(f"docdrift/{path}")
        return {"action": "download", "path": path, "url": result.get("url")}

    elif action == "delete":
        if not path:
            return {"error": "path required for delete"}
        result = _files_delete(f"docdrift/{path}")
        return {"action": "delete", "path": path, "ok": result.get("ok", False)}

    return {"error": f"Unknown action: {action}"}

def _tool_history(invoke_id: str, args: dict) -> dict:
    """List or delete scan history entries."""
    action = args.get("action", "list")

    if action == "list":
        result = _storage_list(prefix="docdrift/")
        return {"action": "list", "entries": result.get("items", [])}
    elif action == "delete":
        key = args.get("key")
        if not key:
            return {"error": "key required for delete"}
        result = _storage_delete(key)
        return {"action": "delete", "key": key, "ok": result.get("ok", False)}

    return {"error": f"Unknown action: {action}"}

# ─── JSON-RPC Protocol Dispatcher ────────────────────────────────────

_TOOL_DISPATCH = {
    "project.scan": _tool_project_scan,
    "docs.crossref": _tool_docs_crossref,
    "docs.patchgen": _tool_docs_patchgen,
    "project.semantic_search": _tool_semantic_search,
    "project.generate_diagram": _tool_generate_diagram,
    "project.file_archive": _tool_file_archive,
    "project.history": _tool_history
}

def _make_response(req_id, result=None, error=None) -> dict:
    resp = {"jsonrpc": "2.0", "id": req_id}
    if error is not None:
        resp["error"] = error
    else:
        resp["result"] = result
    return resp

def _handle_initialize(req_id, params: dict) -> dict:
    proto = params.get("protocolVersion")
    global _v2_negotiated
    if proto == "2.0":
        _v2_negotiated = True
    else:
        print(f"⚠️ host offered protocolVersion={proto!r}, not 2.0", file=sys.stderr)

    return _make_response(
        req_id,
        result={
            "protocolVersion": proto if proto in ("1.1", "2.0") else "2.0",
            "server_info": {
                "name": MANIFEST["display_name"],
                "version": MANIFEST["version"],
            },
            "serverInfo": {
                "name": MANIFEST["display_name"],
                "version": MANIFEST["version"],
            },
            "capabilities": {
                "sampling": {},
                "storage": True
            },
            "client_capabilities": {
                "sampling": {},
                "storage": {},
                "embed": {},
                "image": {},
                "upload": {}
            } if _v2_negotiated else {},
        },
    )

def _handle_describe(req_id) -> dict:
    return _make_response(req_id, result=MANIFEST)

def _handle_health(req_id) -> dict:
    return _make_response(
        req_id,
        result={
            "status": "healthy",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "version": MANIFEST["version"],
        },
    )

def _handle_invoke(req_id, params: dict) -> dict:
    tool = params.get("tool")
    args = params.get("arguments") or {}
    invoke_id = (params.get("context") or {}).get("invoke_id") or params.get("invoke_id") or str(uuid.uuid4())

    handler = _TOOL_DISPATCH.get(tool)
    if handler is None:
        return _make_response(
            req_id,
            error={"code": -32601, "message": f"Unknown tool: {tool}"},
        )

    try:
        data = handler(invoke_id, args)
    except Exception as e:
        return _make_response(
            req_id,
            error={"code": -32603, "message": f"Tool execution failed: {e}"},
        )

    return _make_response(
        req_id,
        result={"success": True, "tool": tool, "data": data},
    )

def _dispatch_agent_msg(msg: dict) -> None:
    method = msg.get("method")
    req_id = msg.get("id")
    params = msg.get("params") or {}

    if method == "initialize":
        resp = _handle_initialize(req_id, params)
    elif method == "describe":
        resp = _handle_describe(req_id)
    elif method == "invoke":
        resp = _handle_invoke(req_id, params)
    elif method == "health":
        resp = _handle_health(req_id)
    elif method == "shutdown":
        resp = _make_response(req_id, result={"ok": True})
    else:
        resp = _make_response(
            req_id,
            error={"code": -32601, "message": f"Method not found: {method}"},
        )

    if req_id is not None:
        _write_frame(resp)

def main() -> None:
    print("🔍 DocDrift engine started", file=sys.stderr)

    reader_thread = threading.Thread(target=_reader, daemon=True)
    reader_thread.start()

    pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="invoke")
    try:
        while True:
            try:
                msg = _agent_requests.get(timeout=1.0)
            except queue.Empty:
                if not reader_thread.is_alive():
                    break
                continue
            pool.submit(_dispatch_agent_msg, msg)
    except KeyboardInterrupt:
        pass
    finally:
        pool.shutdown(wait=False, cancel_futures=True)

if __name__ == "__main__":
    main()
