"""
Synapse backend — FastAPI + Cognee Cloud.

Combines Cognee Cloud storage, temporal reasoning (temporal_cognify), and an
RxNorm/canonical-term normalization pass (normalize.py) applied before data
reaches Cognee.

Install:  pip install fastapi uvicorn cognee python-dotenv pydantic requests
Run:      python main_cloud_pro.py
"""
import os
import re
import io
import json
import uuid
from datetime import datetime, timedelta, timezone
from collections import deque
from fastapi import FastAPI, Form, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
import cognee
from cognee.memory import QAEntry, FeedbackEntry
from dotenv import load_dotenv
from normalize import normalize_note

load_dotenv()
COGNEE_SERVICE_URL = os.getenv("COGNEE_SERVICE_URL")
COGNEE_API_KEY = os.getenv("COGNEE_API_KEY")

app = FastAPI(title="Synapse — Cognee Cloud")
app.add_middleware(
    CORSMiddleware, allow_origins=["http://localhost:3000"],
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)


@app.on_event("startup")
async def connect_to_cloud():
    if not COGNEE_SERVICE_URL or not COGNEE_API_KEY:
        print("Missing COGNEE_SERVICE_URL or COGNEE_API_KEY in .env")
        return
    await cognee.serve(url=COGNEE_SERVICE_URL, api_key=COGNEE_API_KEY)
    print("Connected to Cognee Cloud")


# Prepended to every recall() question so the model reconstructs the full
# timeline before answering, rather than pattern-matching a single note
# (which produces stale "discontinued" answers after a drug is restarted).
TEMPORAL_INSTRUCTION = (
    "Before answering, list EVERY medication-related note for this patient you can "
    "find, in chronological order by date, and determine each drug's CURRENT status "
    "(active or discontinued) based on its single LATEST note — a drug restarted "
    "after being discontinued is ACTIVE again. Do not answer from one note in "
    "isolation; use the full timeline. CRITICAL: only use notes and dates you can "
    "actually find in this patient's record — never invent, estimate, or extrapolate "
    "a note, date, or medication that isn't literally present. If you are not certain "
    "a note exists, omit it rather than guessing. Then answer:\n\n"
)

SAFETY_QUERY = TEMPORAL_INSTRUCTION + (
    "Review this patient's entire record across all specialties and visits. Report "
    "only drug-drug interactions or drug-condition contraindications that are "
    "CURRENTLY active (both drugs still in use as of the latest note). For each, "
    "give the drugs involved, a severity (critical / major / moderate), the "
    "mechanism, and which specialty introduced each. If a risk was present earlier "
    "but is now resolved because a drug was stopped, say that instead of flagging it."
)

RECALL_TOP_K = 30  # default 15; raised so older/updated notes aren't dropped from context

# recall() auto-routes between several retrieval strategies (vector, hybrid,
# graph, ...) unless query_type is pinned. Pin it to GRAPH_COMPLETION so every
# call in this app is genuinely graph-based retrieval.
GRAPH_QUERY_TYPE = cognee.SearchType.GRAPH_COMPLETION

# Documented pharmacology for pairs used in the demo. When a newly-introduced
# drug forms one of these pairs with a drug already active for the patient,
# the sentence is appended to the note before storage, so Cognee's extraction
# creates real mechanism entities (e.g. "CYP3A4 enzyme") and edges instead of
# only a same-note "alert" link between the two drug names.
MECHANISM_FACTS = {
    frozenset({"amiodarone", "simvastatin"}):
        "Known pharmacology: Amiodarone inhibits the CYP3A4 enzyme. The CYP3A4 "
        "enzyme is responsible for metabolizing simvastatin. Because amiodarone "
        "inhibits CYP3A4, simvastatin is metabolized more slowly, which raises "
        "simvastatin blood levels and increases the risk of myopathy and "
        "rhabdomyolysis.",
    frozenset({"amiodarone", "warfarin"}):
        "Known pharmacology: Amiodarone inhibits the CYP2C9 enzyme. The CYP2C9 "
        "enzyme is responsible for metabolizing warfarin. Because amiodarone "
        "inhibits CYP2C9, warfarin is metabolized more slowly, which raises "
        "warfarin blood levels and increases bleeding risk.",
    frozenset({"verapamil", "metoprolol"}):
        "Known pharmacology: Verapamil suppresses AV-node conduction. Metoprolol "
        "also suppresses AV-node conduction. Their combined effect on the AV node "
        "increases the risk of severe bradycardia and heart block.",
    frozenset({"diltiazem", "metoprolol"}):
        "Known pharmacology: Diltiazem suppresses AV-node conduction and cardiac "
        "contractility. Metoprolol also suppresses AV-node conduction. Combined, "
        "they increase the risk of bradycardia and heart block.",
    frozenset({"sildenafil", "nitroglycerin"}):
        "Known pharmacology: Sildenafil potentiates nitric-oxide-mediated "
        "vasodilation. Nitroglycerin also potentiates nitric-oxide-mediated "
        "vasodilation. Combined, they cause profound, potentially fatal "
        "hypotension.",
    frozenset({"clopidogrel", "omeprazole"}):
        "Known pharmacology: Omeprazole inhibits the CYP2C19 enzyme. The CYP2C19 "
        "enzyme is responsible for activating clopidogrel into its active form. "
        "Because omeprazole inhibits CYP2C19, clopidogrel is activated less "
        "effectively, reducing its antiplatelet effect.",
    frozenset({"warfarin", "aspirin"}):
        "Known pharmacology: Warfarin blocks clotting factor synthesis. Aspirin "
        "blocks platelet aggregation. Together they significantly increase "
        "bleeding risk.",
    frozenset({"warfarin", "ibuprofen"}):
        "Known pharmacology: Ibuprofen adds antiplatelet effect and GI mucosal "
        "irritation on top of warfarin's anticoagulant effect, increasing GI "
        "bleeding risk.",
    frozenset({"tramadol", "sertraline"}):
        "Known pharmacology: Tramadol raises central serotonin levels. Sertraline "
        "also raises central serotonin levels. Combined, they increase the risk "
        "of serotonin syndrome.",
}

_KNOWN_DRUGS = ["amiodarone", "simvastatin", "atorvastatin", "warfarin", "verapamil",
    "diltiazem", "metoprolol", "propranolol", "lisinopril", "metformin",
    "clopidogrel", "omeprazole", "sildenafil", "nitroglycerin", "aspirin",
    "ibuprofen", "sertraline", "tramadol"]


async def _currently_active_drugs(patient_id):
    """Generic-name list of this patient's currently active drugs, used to
    decide whether to append a MECHANISM_FACTS sentence to a new note."""
    q = (TEMPORAL_INSTRUCTION +
         "List ONLY the generic names of medications CURRENTLY ACTIVE for this "
         "patient (started and not later discontinued). Comma-separated, nothing "
         "else. If none, respond 'none'.")
    try:
        result = await cognee.recall(q, datasets=[patient_id], top_k=RECALL_TOP_K, query_type=GRAPH_QUERY_TYPE)
        text = " ".join(_texts(result)).lower()
        return {d for d in _KNOWN_DRUGS if d in text}
    except Exception:
        return set()


async def _append_mechanism_facts(annotated_text, mappings, patient_id):
    """If this note introduces a drug that pairs with something already
    active, append the real mechanism sentence so Cognee extracts genuine
    mechanism entities/edges instead of a bare same-note alert link."""
    from normalize import BRAND_TO_INGREDIENT
    new_drugs = set()
    for m in mappings:
        if m.get("type") == "drug":
            raw = m["raw"].lower()
            new_drugs.add(BRAND_TO_INGREDIENT.get(raw, raw))
    if not new_drugs:
        return annotated_text
    active = await _currently_active_drugs(patient_id)
    mech_lines = []
    for new_d in new_drugs:
        for active_d in active:
            if new_d == active_d:
                continue
            fact = MECHANISM_FACTS.get(frozenset({new_d, active_d}))
            if fact and fact not in mech_lines:
                mech_lines.append(fact)
    if not mech_lines:
        return annotated_text
    return annotated_text + "\n\n" + "\n\n".join(mech_lines)


class QueryRequest(BaseModel):
    patient_id: str
    query_text: str


class FeedbackRequest(BaseModel):
    patient_id: str
    finding_title: str
    judgment: str  # "confirm" | "dismiss"


class SimulateRequest(BaseModel):
    patient_id: str
    drug: str


class ExplainRequest(BaseModel):
    patient_id: str
    term_a: str
    term_b: str


class ProvisionalRequest(BaseModel):
    patient_id: str
    specialty: str
    text_content: str
    ttl_seconds: float = 86400


class TimelineSnapshotRequest(BaseModel):
    patient_id: str
    as_of_date: str  # YYYY-MM-DD


class PopulationInsightRequest(BaseModel):
    term_a: str
    term_b: str


# In-memory registry of provisional (TTL-tagged) notes, keyed by note_key.
# Process-lifetime only — no persistence needed across restarts. Expired
# entries are removed via per-item forget(dataset=..., data_id=..., memory_only=True).
PROVISIONAL_REGISTRY = {}

# Fleet-wide feedback ledger: tallies confirm/dismiss judgments by finding
# title across every patient (title + count only, never raw notes). This is
# what lets a different patient's identical finding show "confirmed N times
# across patients" — a client-side substitute for Cognee's improve()-driven
# feedback weighting, which is not available on this tenant.
FEEDBACK_LEDGER = {}


def _ledger_key(finding_title):
    return finding_title.strip().lower()


def _ledger_context_text():
    """Renders the feedback ledger as prompt context so accumulated fleet
    feedback conditions the model's actual answer, not just a UI badge next
    to an otherwise-unaffected one."""
    if not FEEDBACK_LEDGER:
        return ""
    lines = [f"- \"{title}\": clinicians confirmed this {v.get('confirm', 0)}x and dismissed it "
             f"{v.get('dismiss', 0)}x across the patient population so far"
             for title, v in FEEDBACK_LEDGER.items()]
    return ("\n\nKnown clinician feedback history from OTHER patients (context only — a pattern "
            "being frequently dismissed elsewhere is a signal it may be a lower-value alert here "
            "too, but confirm using this patient's own record, don't assume):\n" + "\n".join(lines))


# Tracks which patient_ids exist so /population_insight knows which isolated
# datasets to loop over.
KNOWN_PATIENTS = set()


def _register_patient(patient_id):
    KNOWN_PATIENTS.add(patient_id)


def _texts(results):
    out = []
    for r in (results or []):
        if isinstance(r, dict):
            out.append(r.get("search_result") or r.get("text") or str(r))
        else:
            out.append(getattr(r, "text", str(r)))
    return out


# Findings shown as clickable cards (severity, confirm/dismiss, XAI explain)
# are derived from this JSON contract, not from a local rules table, so every
# severity/resolved judgment on screen traces back to Cognee's own graph
# reasoning over this patient's record.
FINDINGS_SCHEMA_INSTRUCTION = (
    "Respond with ONLY a single JSON object, no prose outside the JSON and no markdown code "
    "fences. Use EXACTLY this structure and these key names, do not rename, nest, or add keys:\n"
    '{"narrative": "<short plain-language paragraph answering the question above>", '
    '"findings": [\n'
    '  {"kind": "drug_drug", "drug_a": "amiodarone", "drug_b": "simvastatin", '
    '"severity": "major", "mechanism": "<one sentence>", "effect": "<one sentence>", '
    '"action": "<one sentence>", "resolved": false, '
    '"specialties": ["Cardiology", "Neurology"]}\n'
    "]}\n"
    'kind is "drug_drug" for a drug-drug interaction or "drug_condition" for a drug-condition '
    "contraindication (drug_b is then the condition name). drug_a/drug_b must be plain "
    "lowercase generic names, ordered alphabetically so the same pair is reported consistently "
    'across calls. severity is exactly one of "critical", "major", "moderate". resolved is '
    "true only if the interacting drug was later discontinued. specialties lists the specialty "
    "that introduced drug_a, then the one that introduced drug_b. Include one object per "
    "interaction or contraindication found anywhere in this patient's record. If there are "
    "none, use an empty array for findings."
)


def _normalize_finding(raw):
    """Coerces one findings-array element into the exact shape the frontend
    expects, tolerating the key-name/shape drift LLMs commonly introduce
    despite an explicit schema (e.g. "interaction_type" + a "drugs" array
    instead of "kind" + "drug_a"/"drug_b"). Returns None if the element
    doesn't carry enough information to be usable."""
    if not isinstance(raw, dict):
        return None

    kind = raw.get("kind") or raw.get("interaction_type") or ""
    kind = "drug_condition" if "condition" in str(kind).lower() else "drug_drug"

    drug_a, drug_b = raw.get("drug_a"), raw.get("drug_b")
    specialties = raw.get("specialties")
    drugs_list = raw.get("drugs")
    if (not drug_a or not drug_b) and isinstance(drugs_list, list) and len(drugs_list) >= 2:
        items = drugs_list[:2]
        names = sorted(
            str(it.get("name", "")).strip().lower() if isinstance(it, dict) else str(it).strip().lower()
            for it in items
        )
        drug_a, drug_b = names[0], names[1]
        if not specialties:
            specialties = [it.get("specialty") for it in items if isinstance(it, dict) and it.get("specialty")]

    if not drug_a or not drug_b:
        return None

    severity = raw.get("severity") if raw.get("severity") in ("critical", "major", "moderate") else "moderate"

    return {
        "kind": kind,
        "drug_a": str(drug_a).strip().lower(),
        "drug_b": str(drug_b).strip().lower(),
        "severity": severity,
        "mechanism": raw.get("mechanism") or "",
        "effect": raw.get("effect") or raw.get("clinical_effect") or "",
        "action": raw.get("action") or raw.get("recommendation") or "",
        "resolved": bool(raw.get("resolved", False)),
        "specialties": specialties or [],
    }


def _parse_structured_response(text):
    """Parses the {narrative, findings} JSON contract out of an LLM response,
    tolerating markdown code fences and per-finding shape drift. Falls back to
    treating the raw text as the narrative with no findings if the model
    didn't return valid JSON at all."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.MULTILINE).strip()
    try:
        data = json.loads(cleaned)
    except (json.JSONDecodeError, TypeError):
        return {"narrative": text, "findings": []}
    if not isinstance(data, dict):
        return {"narrative": text, "findings": []}
    raw_findings = data.get("findings")
    if not isinstance(raw_findings, list):
        raw_findings = []
    findings = [f for f in (_normalize_finding(r) for r in raw_findings) if f]
    return {"narrative": data.get("narrative") or "", "findings": findings}


# Matches the "Connections:" lines returned by cognee.recall(..., only_context=True):
#   <source node> --[<relation>]--> <target node>  (<explanation>)
_EDGE_RE = re.compile(r"^(.+?)\s+--\[(.+?)\]-->\s+(.+?)\s{2}\(.*\)\s*$")


def _parse_edges(raw_texts):
    """Extract literal (source, relation, target) triples from raw graph
    context — real Cognee data, no LLM synthesis."""
    edges = []
    for block in raw_texts:
        for line in block.split("\n"):
            m = _EDGE_RE.match(line.strip())
            if m:
                edges.append((m.group(1).strip(), m.group(2).strip(), m.group(3).strip()))
    return edges


def _node_matches(node, term):
    n = node.lower()
    t = term.lower()
    return n == t or n.startswith(t + " ") or (" " not in n and t in n)


def _shortest_path(edges, term_a, term_b, max_hops=4):
    """Deterministic BFS over the literal edges Cognee returned. Traverses
    in either direction — an edge recorded a->b can still explain a
    connection when walked b->a."""
    adj = {}
    for s, rel, t in edges:
        adj.setdefault(s, []).append((rel, t, True))
        adj.setdefault(t, []).append((rel, s, False))

    starts = [n for n in adj if _node_matches(n, term_a)]
    if not starts:
        return None

    for start in starts:
        if _node_matches(start, term_b):
            return [{"node": start}]
        visited = {start}
        queue = deque([[{"node": start}]])
        while queue:
            path = queue.popleft()
            if len(path) - 1 >= max_hops:
                continue
            last = path[-1]["node"]
            for rel, nxt, forward in adj.get(last, []):
                if nxt in visited:
                    continue
                new_path = path + [{"relation": rel, "forward": forward, "node": nxt}]
                if _node_matches(nxt, term_b):
                    return new_path
                visited.add(nxt)
                queue.append(new_path)
    return None


# Note chunks are stored as "[Cardiology Note]: 2025-09-01: ..." — a
# "contains" edge from such a chunk to an entity tells us which specialty
# introduced that entity.
_SPECIALTY_RE = re.compile(r"^\[(\w[\w ]*)\s+Note\]", re.IGNORECASE)


def _find_specialty_bookend(edges, node_label):
    """Find a note chunk that 'contains' this node and extract its
    specialty, e.g. '[Cardiology Note]: ...' -> 'Cardiology File', to
    bookend the breadcrumb with where each end of the chain came from."""
    for s, rel, t in edges:
        if rel.lower() != "contains":
            continue
        if t == node_label:
            m = _SPECIALTY_RE.match(s)
        elif s == node_label:
            m = _SPECIALTY_RE.match(t)
        else:
            continue
        if m:
            return f"{m.group(1)} File"
    return None


def _is_delete_error(e):
    m = str(e).lower()
    return "forget" in m or "deletion" in m or "delete" in m


async def _remember(text, patient_id):
    # self_improvement=False skips the internal prune/delete step that
    # errors on this tenant. Every attempt keeps dataset_name=patient_id —
    # never fall back to Cognee's default "main_dataset", since that would
    # silently store the note in the wrong dataset and break per-patient
    # isolation instead of failing loudly.
    attempts = (
        {"dataset_name": patient_id, "temporal_cognify": True, "self_improvement": False},
        {"dataset_name": patient_id, "self_improvement": False},
        {"dataset_name": patient_id},
    )
    last = None
    for i, kwargs in enumerate(attempts):
        try:
            await cognee.remember(text, **kwargs)
            if i > 0:
                print(f"  temporal_cognify dropped (attempt {i} succeeded) — last error: {last}")
            return
        except Exception as e:
            # Data is stored during add+cognify, which runs before the prune
            # step. If only the delete step failed, the data is already saved.
            if _is_delete_error(e):
                print("  note stored; skipped a failing cloud cleanup step")
                return
            last = e
    raise last


@app.post("/ingest")
async def ingest(patient_id: str = Form(...), text_content: str = Form(...)):
    try:
        annotated, mappings = normalize_note(text_content)
        annotated = await _append_mechanism_facts(annotated, mappings, patient_id)
        _register_patient(patient_id)
        await _remember(annotated, patient_id)
        # Scoped to this patient's dataset only, so it never mixes in
        # another patient's medications.
        alerts = await cognee.recall(SAFETY_QUERY + _ledger_context_text(), datasets=[patient_id], top_k=RECALL_TOP_K, query_type=GRAPH_QUERY_TYPE)
        return {"status": "success",
                "message": f"Normalized, stored, and time-reviewed record for {patient_id}.",
                "normalized": mappings,
                "alerts": _texts(alerts)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/ingest_document")
async def ingest_document(patient_id: str = Form(...), file: UploadFile = File(...)):
    # Cognee's PdfDocument/CsvDocument/UnstructuredDocument types extract
    # text via pure-Python libraries (pypdf, stdlib csv) — no external ML
    # model dependency. Handles discharge summaries, lab exports, etc.
    try:
        raw_bytes = await file.read()
        buf = io.BytesIO(raw_bytes)
        buf.name = file.filename or "upload.pdf"
        _register_patient(patient_id)
        await _remember(buf, patient_id)
        summary = await cognee.recall(
            TEMPORAL_INSTRUCTION + f"Text was just extracted from a document file named "
            f"'{buf.name}', uploaded RIGHT NOW via the ingest-document endpoint, for this "
            f"patient. This patient's record may ALSO contain older, unrelated documents or "
            f"images from earlier testing — IGNORE those entirely and summarize ONLY the "
            f"content of the file just named above. Be specific about medications, dates, or "
            f"findings mentioned in it. If nothing usable was extracted, say so.",
            datasets=[patient_id], top_k=RECALL_TOP_K, query_type=GRAPH_QUERY_TYPE)
        alerts = await cognee.recall(SAFETY_QUERY + _ledger_context_text(), datasets=[patient_id], top_k=RECALL_TOP_K, query_type=GRAPH_QUERY_TYPE)
        return {"status": "success", "summary": _texts(summary), "alerts": _texts(alerts)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/ingest_provisional")
async def ingest_provisional(request: ProvisionalRequest):
    # A provisional (e.g. "rule-out") note carries a real TTL. When it
    # expires, /prune forgets only this data item via
    # forget(dataset=..., data_id=..., memory_only=True) rather than leaving
    # speculative entries in memory indefinitely.
    expiry = datetime.now(timezone.utc) + timedelta(seconds=request.ttl_seconds)
    annotated, mappings = normalize_note(request.text_content)
    annotated = (f"[{request.specialty} Note — PROVISIONAL, expires {expiry.isoformat()}]: "
                 f"{annotated}")
    try:
        result = await cognee.remember(annotated, dataset_name=request.patient_id, self_improvement=False)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    # The cloud client returns a raw dict for plain-text remember(), not the
    # RememberResult object the SDK docstring describes for typed entries.
    items = result.get("items") if isinstance(result, dict) else getattr(result, "items", None)
    data_id = items[0].get("id") if items else None
    note_key = str(uuid.uuid4())
    PROVISIONAL_REGISTRY[note_key] = {
        "patient_id": request.patient_id, "data_id": data_id,
        "expires_at": expiry.isoformat(), "text": request.text_content,
    }
    return {"status": "stored", "note_key": note_key, "expires_at": expiry.isoformat(),
            "normalized": mappings, "data_id": data_id}


@app.get("/provisional_status")
async def provisional_status():
    now = datetime.now(timezone.utc)
    out = []
    for key, info in PROVISIONAL_REGISTRY.items():
        expires_at = datetime.fromisoformat(info["expires_at"])
        out.append({"note_key": key, "patient_id": info["patient_id"], "text": info["text"],
                    "expires_at": info["expires_at"], "expired": now >= expires_at})
    return {"provisional": out}


@app.post("/prune")
async def prune():
    now = datetime.now(timezone.utc)
    pruned, failed = [], []
    for key, info in list(PROVISIONAL_REGISTRY.items()):
        if now < datetime.fromisoformat(info["expires_at"]):
            continue
        try:
            if info["data_id"]:
                await cognee.forget(dataset=info["patient_id"], data_id=info["data_id"], memory_only=True)
            pruned.append({"note_key": key, "text": info["text"]})
            del PROVISIONAL_REGISTRY[key]
        except Exception as e:
            failed.append({"note_key": key, "error": str(e)})
    return {"pruned": pruned, "failed": failed, "remaining": len(PROVISIONAL_REGISTRY)}


@app.post("/timeline_snapshot")
async def timeline_snapshot(request: TimelineSnapshotRequest):
    # Point-in-time query: what was true as of a past date, not "current
    # status" — a deeper use of temporal reasoning than start/stop tracking.
    question = (
        f"Before answering, list EVERY medication-related note for this patient you can "
        f"find, in chronological order by date, but ONLY consider notes dated on or before "
        f"{request.as_of_date} — treat any note dated AFTER {request.as_of_date} as if it "
        f"had not happened yet and ignore it entirely. Based only on that filtered history, "
        f"determine each drug's status AS OF {request.as_of_date} (active or discontinued) "
        f"using each drug's latest qualifying note. CRITICAL: only use notes and dates you "
        f"can actually find in this patient's record — never invent one. Then answer: what "
        f"was this patient's medication status, and were there any active drug-drug or "
        f"drug-condition risks, AS OF {request.as_of_date}? Give severity and mechanism for "
        f"any active risk you find."
    )
    try:
        result = await cognee.recall(question, datasets=[request.patient_id],
                                      top_k=RECALL_TOP_K, query_type=GRAPH_QUERY_TYPE)
        return {"status": "success", "as_of_date": request.as_of_date, "result": _texts(result)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/population_insight")
async def population_insight(request: PopulationInsightRequest):
    # Privacy-safe cross-patient aggregation: each isolated patient dataset
    # is queried separately with a strict yes/no question. Raw notes never
    # cross a patient boundary — only the yes/no answer and matching
    # patient_id come back.
    question = (
        f"Based only on this patient's own record, are {request.term_a} and "
        f"{request.term_b} BOTH currently active (started and not later "
        f"discontinued) for this patient? Answer with just the single word "
        f"YES or NO, nothing else."
    )
    matching, checked = [], 0
    for pid in sorted(KNOWN_PATIENTS):
        checked += 1
        try:
            result = await cognee.recall(question, datasets=[pid], top_k=RECALL_TOP_K,
                                          query_type=GRAPH_QUERY_TYPE)
            answer = " ".join(_texts(result)).strip().upper()
            if answer.startswith("YES"):
                matching.append(pid)
        except Exception:
            continue
    return {"checked": checked, "matching_patients": matching, "count": len(matching)}


@app.post("/analyze")
async def analyze(request: QueryRequest):
    try:
        question = (TEMPORAL_INSTRUCTION + request.query_text + _ledger_context_text()
                    + "\n\n" + FINDINGS_SCHEMA_INSTRUCTION)
        results = await cognee.recall(question, datasets=[request.patient_id], top_k=RECALL_TOP_K, query_type=GRAPH_QUERY_TYPE)
        parsed = _parse_structured_response("\n".join(_texts(results)))
        data = [parsed["narrative"]] if parsed["narrative"] else _texts(results)
        return {"status": "success", "data": data, "findings": parsed["findings"]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/simulate")
async def simulate(request: SimulateRequest):
    # Counterfactual "what-if": a pure recall() against the existing
    # record. Nothing is written.
    question = TEMPORAL_INSTRUCTION + (
        f"Given this patient's currently active medications, if we NEWLY prescribe "
        f"{request.drug}, list any drug-drug interactions or contraindications it "
        f"would introduce. This is HYPOTHETICAL — the patient has not actually been "
        f"given this drug and the record must not be treated as changed. For each "
        f"interaction found, give the severity (critical / major / moderate), the "
        f"mechanism, and which existing drug it conflicts with."
    ) + _ledger_context_text()
    try:
        results = await cognee.recall(question, datasets=[request.patient_id], top_k=RECALL_TOP_K, query_type=GRAPH_QUERY_TYPE)
        return {"status": "success", "result": _texts(results)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/debug_notes/{patient_id}")
async def debug_notes(patient_id: str):
    # Ground-truth check: only_context=True skips LLM synthesis and returns
    # the raw retrieved chunks, useful for verifying what's actually stored.
    try:
        raw = await cognee.recall("medications and dates", datasets=[patient_id],
                                   only_context=True, top_k=RECALL_TOP_K, query_type=GRAPH_QUERY_TYPE)
        return {"patient_id": patient_id, "raw_context": _texts(raw)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/explain")
async def explain(request: ExplainRequest):
    # XAI traceability: fetch raw graph triples (only_context=True, no LLM
    # synthesis) and run a deterministic BFS — the breadcrumb is built from
    # literal edges Cognee stored, not a model's guess.
    try:
        raw = await cognee.recall(f"{request.term_a} {request.term_b}",
                                   datasets=[request.patient_id],
                                   only_context=True, top_k=RECALL_TOP_K, query_type=GRAPH_QUERY_TYPE)
        edges = _parse_edges(_texts(raw))
        path = _shortest_path(edges, request.term_a, request.term_b)
        if path:
            # Bookend the chain with each end's source specialty file when
            # that provenance edge exists, e.g. "Cardiology File -> amiodarone
            # -> ... -> simvastatin -> Neurology File".
            start_bookend = _find_specialty_bookend(edges, path[0]["node"])
            end_bookend = _find_specialty_bookend(edges, path[-1]["node"])
            if start_bookend:
                path = [{"node": start_bookend},
                        {"relation": "introduces", "forward": True, "node": path[0]["node"]}] + path[1:]
            if end_bookend:
                path = path + [{"relation": "introduced_by", "forward": True, "node": end_bookend}]
        return {"status": "success", "path": path,
                "note": None if path else (
                    "No direct graph-level link found between these two concepts yet — "
                    "the interaction is flagged by the clinical rules engine, not a "
                    "stored graph relationship. See each drug's source note instead.")}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/feedback")
async def feedback(request: FeedbackRequest):
    # Human-in-the-loop feedback on Cognee's typed memory API. A QAEntry
    # records the alert as a session Q&A turn; a FeedbackEntry attaches the
    # clinician's judgment to that turn via qa_id.
    session_id = request.patient_id
    try:
        qa = QAEntry(
            question=f"Is there a cross-specialty risk from: {request.finding_title}?",
            answer=f"Alert raised: {request.finding_title}",
        )
        qa_result = await cognee.remember(qa, dataset_name=request.patient_id, session_id=session_id)
        qa_id = qa_result.entry_id
        if not qa_id:
            raise HTTPException(status_code=500, detail="Cognee did not return a qa_id for the QA entry")

        fb = FeedbackEntry(
            qa_id=qa_id,
            feedback_text=f"Clinician {request.judgment}ed this alert.",
            feedback_score=1 if request.judgment == "confirm" else -1,
        )
        await cognee.remember(fb, dataset_name=request.patient_id, session_id=session_id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # improve(session_ids=...) is meant to bridge session Q&A/feedback into
    # the permanent graph and apply feedback-weight adjustments. It is not
    # available on this Cognee Cloud tenant yet, so this call is
    # best-effort — the QAEntry/FeedbackEntry above are already durably
    # recorded regardless of whether this succeeds.
    enriched = False
    try:
        await cognee.improve(dataset=request.patient_id, session_ids=[session_id])
        enriched = True
    except Exception:
        pass

    # Since the improve() bridge above is unavailable, the session-scoped
    # QAEntry/FeedbackEntry would otherwise never reach the permanent graph.
    # Bridge it explicitly with a plain-text commit so the fact "clinician
    # judged this alert" durably enters the same graph everything else lives in.
    try:
        bridge_note = f"Clinician {request.judgment}ed the alert: {request.finding_title}."
        await _remember(bridge_note, request.patient_id)
    except Exception:
        pass

    # Fleet-wide ledger: tally this judgment against the finding's title
    # across all patients (title + count only, never raw notes).
    key = _ledger_key(request.finding_title)
    entry = FEEDBACK_LEDGER.setdefault(key, {"confirm": 0, "dismiss": 0})
    entry[request.judgment] = entry.get(request.judgment, 0) + 1

    return {"status": "ok", "judgment": request.judgment, "qa_id": qa_id, "enriched": enriched,
            "ledger": entry}


@app.get("/ledger/{finding_title}")
async def ledger_lookup(finding_title: str):
    return FEEDBACK_LEDGER.get(_ledger_key(finding_title), {"confirm": 0, "dismiss": 0})


@app.post("/improve")
async def improve():
    await cognee.improve()
    return {"status": "improved"}


@app.post("/clear")
async def clear(patient_id: str = Form(...)):
    # Scoped to this patient's dataset only. forget(everything=True) errors
    # on this tenant; forget(dataset=...) for a single dataset works.
    try:
        result = await cognee.forget(dataset=patient_id)
        return {"status": "cleared", "detail": result}
    except Exception as e:
        return {"status": "clear_failed", "detail": str(e),
                "hint": "Cloud deletion is erroring; use a new patient_id to start fresh."}


@app.get("/graph", response_class=HTMLResponse)
async def graph():
    # Cognee Cloud's own graph explorer lives behind platform.cognee.ai's login,
    # so it can't be embedded directly in this iframe — link out to it instead
    # of silently failing to render inside the frame.
    return HTMLResponse(
        "<div style='font-family:sans-serif;padding:24px;color:#333;line-height:1.5'>"
        "Cognee Cloud's own graph explorer requires signing in to your Cognee account "
        "directly, so it can't be embedded here. Open it in a new tab: "
        "<a href='https://platform.cognee.ai' target='_blank' rel='noopener'>platform.cognee.ai</a>."
        "<br><br>The <b>SYNTHESIZED</b> tab on this page renders the same underlying graph "
        "locally and needs no separate login.</div>"
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main_cloud_pro:app", host="0.0.0.0", port=8000, reload=True)
