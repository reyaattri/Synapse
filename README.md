# Synapse

**A memory layer for clinical drug-safety review, built on Cognee Cloud's hybrid graph-vector memory.**

## The problem

A patient sees a cardiologist in January, a psychiatrist in March, and an endocrinologist in June. Each doctor writes their own notes, in their own system, with no idea what the others prescribed. Dangerous drug interactions slip through not because anyone made a mistake, but because no single person, and no single system, ever held the whole picture at once.

Synapse is that missing picture. Every consultation note, lab result, or discharge summary becomes a memory in a per-patient knowledge graph. When a new drug is about to be prescribed, Synapse recalls everything relevant across every past visit, reasons over *when* each drug was started or stopped, and surfaces interactions a single specialist would have no way of knowing about. When a clinician confirms or dismisses a finding, Synapse remembers that judgment and factors it into future answers to the same question.

It is not a chatbot bolted onto a database. The graph, the temporal reasoning, and the feedback loop are the product — and Cognee's memory lifecycle is what makes all three possible without Synapse having to build its own graph database, retrieval pipeline, or vector store from scratch.

## How Synapse uses Cognee

Every one of Cognee's memory-lifecycle verbs does real work here, not a token integration:

- **`remember()`** — every note, uploaded document, and piece of clinician feedback is written into a per-patient Cognee dataset (`dataset_name=patient_id`), so one patient's record can never bleed into another's graph. A retry ladder (`main_cloud_pro.py:_remember`) never silently falls back to Cognee's default dataset — a failed write raises loudly instead of corrupting patient isolation.
- **`recall()`** — pinned to `SearchType.GRAPH_COMPLETION` on every call, so retrieval is always genuine graph traversal, never an auto-routed vector or hybrid shortcut. Every question is prepended with a temporal instruction that makes the model reconstruct a patient's entire medication timeline from the graph before answering, so "is this drug still active" is answered from the full history, not the single nearest note. `recall(..., only_context=True)` is used separately to pull raw graph triples with no LLM synthesis at all, for deterministic explainability (see XAI below).
- **`improve()`** — called after every clinician feedback event to fold that judgment back into the graph. Cognee Cloud does not yet expose this endpoint publicly (confirmed directly with Cognee's team), so Synapse also durably remembers the feedback as a plain-language fact and layers a cross-patient consensus ledger on top — a working substitute for the feedback-weighting `improve()` is meant to provide, built because the real thing wasn't available yet, not instead of it.
- **`forget()`** — used surgically, not as a blunt reset. Provisional ("rule-out") notes carry a real TTL and are removed one at a time via `forget(dataset=..., data_id=..., memory_only=True)` when they expire. A full `forget(dataset=patient_id)` powers the per-patient "Forget" action, scoped so clearing one patient can never touch another's memory.

On top of the four verbs, Synapse leans on two more Cognee capabilities that most integrations don't touch:

- **Temporal cognify** (`temporal_cognify=True`) so the graph itself understands *when* something happened, not just *that* it happened — a drug started in September and stopped in December is correctly excluded from an interaction check run in February.
- **Structured findings straight from the graph.** Instead of a client-side rules table deciding severity and resolution status, Synapse's `/analyze` endpoint asks Cognee's `recall()` for a strict JSON contract (`kind`, `drug_a`, `drug_b`, `severity`, `mechanism`, `resolved`, `specialties`) reasoned live over the patient's graph, with backend-side normalization to absorb the minor key-drift LLMs introduce even against an explicit schema. The severity badge and "Resolved by temporal reasoning" banner a clinician sees are Cognee's own graph-grounded conclusion, not a lookup table that happens to agree with it.

## What makes this different

- **Cross-consultation synthesis** finds interactions no single specialist's notes would reveal on their own, because Cognee's graph connects entities across every specialty a patient has seen.
- **Temporal reasoning** resolves risk over time instead of freezing it at the moment a drug was first mentioned — a discontinued drug's flagged interaction visibly resolves the next time the graph is queried.
- **Explainable AI over a real graph.** The "Explain" action on any finding runs a deterministic breadth-first search over Cognee's raw stored edges (via `only_context=True`) and renders the actual path connecting two entities — a reasoning chain grounded in stored graph structure, not a model's restated guess.
- **A working `improve()` substitute.** Rather than silently degrading when Cognee Cloud's feedback-weighting endpoint wasn't available, Synapse built the mechanism it's meant to provide: a fleet-wide confirm/dismiss ledger that conditions future answers and is injected back into the recall prompt as context.
- **Provisional memory with a real TTL.** Speculative findings decay and are individually forgotten via Cognee's `memory_only` deletion — never a full dataset wipe — modeling the difference between a tentative "rule-out" note and a confirmed clinical fact.
- **Time capsule queries** ask what was true as of a past date, exercising Cognee's temporal graph as a point-in-time index rather than only a "current state" store.
- **Privacy-safe population insight** loops a yes/no question across every isolated patient dataset and returns only aggregate counts — raw notes never cross a patient boundary, by construction of Cognee's per-dataset isolation.
- **RxNorm-normalized ingestion.** Drug names are canonicalized against the NIH RxNorm database before they ever reach `remember()`, so "Zocor" and "simvastatin" become the same graph node instead of two disconnected ones.

## Try it in under 2 minutes

1. Start both servers (below).
2. Select patient **Otis Reyes**, specialty **Cardiology**, and commit: `2025-09-01: Atrial fibrillation. Started Amiodarone 200mg daily.`
3. Switch specialty to **Neurology**, commit: `2026-02-14: Muscle fatigue. Started Simvastatin 40mg for high cholesterol.`
4. Click **Recall · run()**. Synapse traces the graph across both specialties and surfaces the Amiodarone + Simvastatin interaction, with severity and mechanism reasoned live by Cognee, not looked up.
5. Add a third note: `2026-03-01: Discontinued Amiodarone; rhythm stable without it.` Run Recall again. The same finding now shows **Resolved by temporal reasoning**, because Cognee re-evaluated the whole timeline, not just the latest note.
6. Click **Confirm** on the finding, then **Explain** to see the literal graph path connecting the two drugs.

## Architecture

```
frontend/   Next.js 16 + React 19 dashboard (single-page clinical UI)
backend/    FastAPI service, talks to Cognee Cloud and RxNorm
```

The backend is a thin layer over Cognee: it does not run its own vector store, graph database, or LLM calls outside of what Cognee provides. Its job is dataset isolation, temporal/schema prompting, deterministic graph-path explanation, and the client-side feedback ledger described above.

## Running it locally

### Backend

```bash
cd backend
python -m venv venv
venv\Scripts\activate      # Windows
# source venv/bin/activate # macOS/Linux
pip install -r requirements.txt
```

Create `backend/.env`:

```
COGNEE_SERVICE_URL=your_cognee_cloud_url
COGNEE_API_KEY=your_cognee_cloud_api_key
```

```bash
uvicorn main_cloud_pro:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000`.

## API overview

| Endpoint | Purpose |
|---|---|
| `POST /ingest` | Store a consultation note for a patient |
| `POST /ingest_document` | Store a parsed PDF/CSV document for a patient |
| `POST /ingest_provisional` | Store an unverified, auto-expiring finding |
| `GET /provisional_status` | Check which provisional findings are near expiry |
| `POST /prune` | Delete expired provisional findings |
| `POST /timeline_snapshot` | Query the patient's record as of a past date |
| `POST /population_insight` | Aggregate, de-identified cross-patient patterns |
| `POST /analyze` | Cross-consultation synthesis with Cognee-derived structured findings |
| `POST /simulate` | "What if" check for a drug not yet prescribed |
| `GET /debug_notes/{patient_id}` | Raw stored notes, for verification |
| `POST /explain` | Graph-path explanation for a given finding |
| `POST /feedback` | Record a clinician's confirm/dismiss judgment |
| `GET /ledger/{finding_title}` | Prior feedback consensus for a finding |
| `POST /improve` | Best-effort call into Cognee's native improve loop |
| `POST /clear` | Wipe a single patient's dataset |
| `GET /graph` | Visual graph view for a patient |
