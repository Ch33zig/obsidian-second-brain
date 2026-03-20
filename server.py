"""
Second Brain – FastAPI server for the Obsidian plugin.

Config via .env:
  CHUTES_API_KEY    – Chutes API key (required)
  VAULT_PATH        – Absolute path to Obsidian vault
  COGNEE_DATA_DIR   – Storage dir (default: ./cognee_data)
  AUTO_INGEST       – true = auto-scan vault on startup
  PORT              – Server port (default: 8765)
"""

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

# Configuration happens dynamically via plugin headers.

# ── Config ───────────────────────────────────────────────────────────────────
FASTEMBED_MODEL  = "BAAI/bge-small-en-v1.5"  # fast, local, ONNX-based
EMBEDDING_DIM   = 384   # output dim of bge-small-en-v1.5

DATA_DIR    = os.path.abspath("./cognee_data")

os.makedirs(DATA_DIR, exist_ok=True)

# Inject env vars BEFORE importing cognee (pydantic_settings reads at class init).
# We set placeholders. Actual values are injected per-request via headers.
os.environ["LLM_PROVIDER"]                   = "openai"
os.environ["LLM_MODEL"]                      = "placeholder"
os.environ["LLM_API_KEY"]                   = "placeholder"
os.environ["LLM_INSTRUCTOR_MODE"]            = "json_mode"
os.environ["SYSTEM_ROOT_DIRECTORY"]          = DATA_DIR
os.environ["DATA_ROOT_DIRECTORY"]            = DATA_DIR
os.environ["ENABLE_BACKEND_ACCESS_CONTROL"] = "false"
os.environ["COGNEE_SKIP_CONNECTION_TEST"]    = "true"

# Embeddings: fastembed (local) – Chutes doesn't expose an embeddings endpoint
os.environ["EMBEDDING_MODEL"]    = FASTEMBED_MODEL
os.environ["EMBEDDING_API_KEY"]  = "fastembed"  # placeholder, not used
os.environ["EMBEDDING_PROVIDER"] = "fastembed"

import cognee
import litellm 

litellm.drop_params = True  # silently drop unsupported params

# ── Fastembed local embedding engine ─────────────────────────────────────────
# Chutes doesn't expose an /embeddings endpoint via litellm.
# fastembed (ONNX-based, already installed) handles embeddings locally.
_fastembed_engine = None

async def _patched_aembedding(**kwargs):
    """Replace litellm.aembedding with fastembed for local vector generation."""
    global _fastembed_engine
    import asyncio
    from fastembed import TextEmbedding

    if _fastembed_engine is None:
        loop = asyncio.get_event_loop()
        _fastembed_engine = await loop.run_in_executor(
            None, lambda: TextEmbedding(FASTEMBED_MODEL)
        )

    texts = kwargs.get("input", [])
    if isinstance(texts, str):
        texts = [texts]

    loop = asyncio.get_event_loop()
    embeddings = await loop.run_in_executor(
        None, lambda: [list(map(float, e)) for e in _fastembed_engine.embed(texts)]
    )

    # Match the shape LiteLLMEmbeddingEngine expects: response.data[i]["embedding"]
    class _Resp:
        data = [{"embedding": emb} for emb in embeddings]
    return _Resp()

litellm.aembedding = _patched_aembedding



from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


# ── Cognee runtime overrides ──────────────────────────────────────────────────

def _apply_config() -> None:
    """Belt-and-suspenders: also call typed setters in case any singleton was
    cached before our env injection landed."""
    from cognee.infrastructure.llm import get_llm_config
    get_llm_config().llm_instructor_mode = "json_mode"
    cognee.config.system_root_directory(DATA_DIR)
    cognee.config.data_root_directory(DATA_DIR)
    # Embedding config: fastembed (local), correct dim for LanceDB schema
    from cognee.infrastructure.databases.vector.embeddings.config import get_embedding_config
    emb = get_embedding_config()
    emb.embedding_model      = FASTEMBED_MODEL
    emb.embedding_api_key    = "fastembed"
    emb.embedding_endpoint   = None
    emb.embedding_dimensions = EMBEDDING_DIM  # 384 for bge-small-en-v1.5


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _bootstrap_db() -> None:
    """Add a seed document so cognee creates all DB tables + default user."""
    try:
        await cognee.add("Second Brain initialised.", dataset_name="__bootstrap__")
        await cognee.cognify(custom_prompt=CONCEPT_GRAPH_PROMPT)
        print("[cognee] Database bootstrapped.")
    except Exception as exc:
        print(f"[cognee] Bootstrap warning (non-fatal): {exc}")


async def _ingest_vault(vault_path: str) -> dict:
    """Walk vault_path, add every .md file, then cognify."""
    vault = Path(vault_path)
    if not vault.exists():
        return {"error": f"Vault path does not exist: {vault_path}"}

    md_files = [
        p for p in vault.rglob("*.md")
        if ".obsidian" not in p.parts and ".trash" not in p.parts
    ]
    if not md_files:
        return {"error": "No .md files found in vault.", "path": str(vault)}

    added, errors = 0, []
    for md in md_files:
        try:
            content = md.read_text(encoding="utf-8", errors="replace")
            await cognee.add(f"# {md.stem}\n\n{content}", dataset_name="vault")
            added += 1
        except Exception as exc:
            errors.append({"file": str(md), "error": str(exc)})

    await cognee.cognify(custom_prompt=CONCEPT_GRAPH_PROMPT)
    return {"added": added, "total": len(md_files), "errors": errors[:10]}


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    _apply_config()
    await _bootstrap_db()
    
    yield


# ── Prompts ───────────────────────────────────────────────────────────────────

CONCEPT_GRAPH_PROMPT = """
You are a knowledge graph architect building a second brain.

Your ONLY task is to extract broad SUBJECTS from the text, and link every specific ENTITY to them.

## What to Extract
1. **Subjects**: Universal, high-level academic disciplines or overarching broad domains (e.g., "Literature", "History", "Computer Science", "Philosophy"). Use EXACTLY the type `Subject`.
2. **Entities**: Specific ideas, themes, story elements, mental models, frameworks, people, topics, or things mentioned in the text. Use EXACTLY the type `Entity`.

## CRITICAL CONNECTION RULE
- EVERY single `Entity` you extract MUST be connected to at least one umbrella `Subject` node via a `belongs_to_subject` edge. 
- NEVER leave an `Entity` isolated. If you extract an `Entity`, you MUST simultaneously create a parent `Subject` node, AND link them.

## STRICT ID MATCHING (CRUCIAL)
- The edge `source_node_id` and `target_node_id` MUST EXACTLY MATCH the `id` of an extracted node in your JSON array!
- If you create an edge targeting "computer_science", you MUST securely extract a `Subject` node with the EXACT id "computer_science".
- Case matters! "Computer_Science" does not match "computer_science". ALWAYS use lowercase snake_case for IDs.

## Subject Categories
- Subjects MUST be universal, foundational disciplines or high-level domains (e.g., "Literature", "Computer Science", "Psychology"). 
- Specific themes from stories, events, analyses, or anything granular MUST be categorized as an `Entity` and linked to a broader `Subject` (like "Literature" or "History").
- Do NOT generate narrow, niche, or hyper-specific subjects. Everything must be elevated to its highest possible overarching category.
- Avoid creating overlapping Subjects: consolidate them into the single broadest category.

## What NOT to extract
- Dates, numbers, quotes, or URLs.
- Implementation details.
- Vague filler nodes like "thing", "idea".

## Node IDs
- ALL nodes must have short, lowercase, snake_case IDs (e.g., "deep_work", "computer_science").
- Node `name` should be human-readable title-case (e.g., "Deep Work").
"""

# ── App ────────────────────────────────────────────────────────────────────────

app = FastAPI(title="Second Brain", version="0.3.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["app://obsidian.md", "http://localhost", "*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def update_cognee_config(request: Request, call_next):
    # Retrieve settings from request headers sent by CogneeClient
    api_key = request.headers.get("x-api-key")
    provider = request.headers.get("x-llm-provider")
    model = request.headers.get("x-llm-model")

    if api_key:
        cognee.config.set_llm_api_key(api_key)
        os.environ["LLM_API_KEY"] = api_key
    
    if provider:
        os.environ["LLM_PROVIDER"] = provider
        cognee.config.set_llm_provider("custom" if provider.lower() == "chutes" else provider)
        
    if model:
        # LiteLLM routing prefix for Chutes if chosen
        if provider and provider.lower() == "chutes" and not model.startswith("chutes/"):
            model = f"chutes/{model}"
        cognee.config.set_llm_model(model)
        os.environ["LLM_MODEL"] = model

    response = await call_next(request)
    return response


# ── Request models ─────────────────────────────────────────────────────────────

class AddRequest(BaseModel):
    text: str
    dataset_id: Optional[str] = "default"
    note_title: Optional[str] = None

class CognifyRequest(BaseModel):
    pass

class SearchRequest(BaseModel):
    query: str
    limit: Optional[int] = 10

class IngestVaultRequest(BaseModel):
    vault_path: Optional[str] = None


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/status")
async def status():
    return {
        "status": "ok",
        "llm_model": os.environ.get("LLM_MODEL", "placeholder"),
        "embedding_model": FASTEMBED_MODEL,
        "embedding_provider": "fastembed (local)",
        "data_dir": DATA_DIR,
    }


@app.get("/debug_nodes")
async def debug_nodes():
    try:
        from cognee.infrastructure.databases.graph import get_graph_engine
        graph_engine = await get_graph_engine()
        nodes_raw, edges_raw = await graph_engine.get_graph_data()
        
        # limit to 50
        nodes = []
        for n_id, props in nodes_raw[:50]:
            nodes.append({"id": str(n_id), "props": props})
            
        return {"nodes": nodes[:50], "edges_count": len(edges_raw), "nodes_count": len(nodes_raw)}
    except Exception as e:
        return {"error": str(e)}

@app.get("/graph")
async def get_graph():
    """Return meaningful graph nodes and edges in D3-compatible format.
    Filters out internal cognee scaffolding types (DocumentChunk, TextDocument, etc.)
    so only LLM-extracted entities and concepts are shown.
    """
    # Node types that are internal cognee plumbing, not real knowledge
    INTERNAL_TYPES = {
        "DocumentChunk", "TextDocument", "Dataset", "Data",
        "DatasetData", "PipelineRun", "TextSummary", "EntityType"
    }

    try:
        from cognee.infrastructure.databases.graph import get_graph_engine
        graph_engine = await get_graph_engine()
        nodes_raw, edges_raw = await graph_engine.get_graph_data()

        # Build a map of EntityType ID -> String name (e.g., "Subject" or "Entity")
        entity_type_names = {}
        for n_id, props in nodes_raw:
            if props.get("type") == "EntityType":
                entity_type_names[str(n_id)] = props.get("name") or props.get("id")

        # Follow any 'is_a' edges to see the true semantic type of our Entity nodes
        semantic_types = {}
        for source_id, target_id, rel_name, edge_props in edges_raw:
            if rel_name == "is_a" or str(edge_props.get("relationship_name")) == "is_a":
                tid = str(target_id)
                if tid in entity_type_names:
                    semantic_types[str(source_id)] = str(entity_type_names[tid]).capitalize()

        nodes = []
        node_ids: set[str] = set()
        for node_id, props in nodes_raw:
            node_type = props.get("type", "Node")
            
            # Skip internal scaffolding nodes
            if node_type in INTERNAL_TYPES:
                continue

            nid = str(node_id)
            
            # Apply the true semantic type if we found it (so we see Subject vs Entity)
            if nid in semantic_types:
                node_type = semantic_types[nid]
            
            # Skip bootstrap seed node
            label = props.get("name") or props.get("id") or str(node_id)
            if label == "Second Brain initialised.":
                continue
            
            node_ids.add(nid)
            nodes.append({
                "id": nid,
                "label": label,
                "type": node_type,
                "description": props.get("description", ""),
            })

        # Only include edges where both endpoints are real nodes
        edges = []
        connected_nodes = set()
        for src, tgt, rel, _props in edges_raw:
            src_s, tgt_s = str(src), str(tgt)
            if src_s not in node_ids or tgt_s not in node_ids:
                continue
            # Skip generic structural relationships
            if rel in ("is_part_of", "contains", "has_chunk", "is_a"):
                continue
            edges.append({
                "source": src_s,
                "target": tgt_s,
                "label": rel,
            })
            connected_nodes.add(src_s)
            connected_nodes.add(tgt_s)

        # Filter out any node that lacks connections (isolated nodes)
        filtered_nodes = []
        for n in nodes:
            if n["id"] not in connected_nodes:
                continue
            filtered_nodes.append(n)

        return {"nodes": filtered_nodes, "edges": edges}
    except Exception as exc:
        msg = str(exc)
        if "DatabaseNotCreated" in msg or "empty" in msg.lower():
            return {"nodes": [], "edges": [], "hint": "Graph is empty – ingest some notes first."}
        raise HTTPException(500, msg) from exc


@app.post("/add")
async def add_text(req: AddRequest):
    try:
        content = f"# {req.note_title}\n\n{req.text}" if req.note_title else req.text
        await cognee.add(content, dataset_name=req.dataset_id or "default")
        return {"success": True, "dataset_id": req.dataset_id or "default"}
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc


@app.post("/cognify")
async def cognify(_: CognifyRequest):
    try:
        await cognee.cognify(custom_prompt=CONCEPT_GRAPH_PROMPT)
        return {"success": True}
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc


@app.post("/ingest-vault")
async def ingest_vault_endpoint(req: IngestVaultRequest):
    vault = req.vault_path
    if not vault:
        raise HTTPException(400, "No vault path provided by the plugin.")
    try:
        result = await _ingest_vault(vault)
        if "error" in result:
            raise HTTPException(400, result["error"])
        return result
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc


@app.post("/search")
async def search(req: SearchRequest):
    try:
        results = await cognee.search(query_text=req.query)
        formatted: list[dict] = []
        for r in results:
            if isinstance(r, dict):
                formatted.append(r)
            elif hasattr(r, "__dict__"):
                formatted.append(vars(r))
            else:
                formatted.append({"text": str(r)})
        return {"results": formatted[: req.limit or 10]}
    except Exception as exc:
        msg = str(exc)
        if "SearchPreconditionError" in msg or "DatabaseNotCreated" in msg:
            return {
                "results": [],
                "hint": "Knowledge graph is empty. Add notes and click 'Build knowledge graph'.",
            }
        raise HTTPException(500, msg) from exc


@app.delete("/prune")
async def prune():
    try:
        await cognee.prune.prune_data()
        await cognee.prune.prune_system(metadata=True)
        return {"success": True}
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8765))
    uvicorn.run("server:app", host="127.0.0.1", port=port, reload=False)
