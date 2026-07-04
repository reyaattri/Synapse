# Synapse

**A memory layer for clinical drug-safety review, built on Cognee Cloud.**

## The problem, in simple words

A patient sees a cardiologist in January, a psychiatrist in March, and an endocrinologist in June. Each doctor writes their own notes, in their own system, with no idea what the others prescribed. Dangerous drug interactions slip through not because anyone made a mistake, but because no single person ever saw the whole picture.

Synapse is that missing picture. Every consultation note, lab result, or discharge summary gets stored as a memory in a knowledge graph, tied to that specific patient. When a new drug is about to be prescribed, Synapse recalls everything relevant across every past visit, reasons over *when* each drug was started or stopped, and flags interactions a single specialist would have no way of knowing about. When a doctor confirms or dismisses a finding, Synapse remembers that judgment and factors it into future answers for the same question.

It's not a chatbot bolted onto a database. The graph, the temporal reasoning, and the feedback loop are the product.

## How it uses Cognee

Synapse is built around Cognee's four core operations, applied to a real clinical workflow rather than generic Q&A:

- **`remember()`** — every note, document, and piece of clinician feedback is written into a per-patient Cognee dataset, so one patient's data never leaks into another's graph.
- **`recall()`** — retrieval runs in `GRAPH_COMPLETION` mode, forcing genuine graph-based reasoning instead of a flattened text search, and is scoped with `datasets=[patient_id]` on every call.
- **`improve()`** — used where available, with a client-side ledger layered on top to compensate for the parts of Cognee's feedback loop not yet enabled on the Cloud tier (documented honestly below, not hidden).
- **`forget()`** — supports scoped per-dataset deletion (`prune`, `clear`) so stale or auto-expiring "provisional" findings don't pollute the permanent graph.

Temporal reasoning (`temporal_cognify=True`) lets Synapse understand that a drug started in January and stopped in March is no longer active in June, so it correctly resolves interactions that a keyword search would get wrong.

## Features

- **Cross-consultation synthesis** — ask a question about a patient and get an answer reasoned over every note ever recorded for them, across every specialty.
- **Temporal reasoning** — drugs that were started and later discontinued are correctly excluded from current-interaction checks.
- **Simulation mode** — ask "what if we add drug X" before it's actually prescribed, without writing anything to the graph.
- **Explainability (XAI)** — every finding can be traced back to the shortest path of graph edges that produced it, shown as a plain-language reasoning chain rather than a black box.
- **Feedback loop** — a clinician can confirm or dismiss a finding; that judgment is remembered and shown as a consensus banner the next time the same question comes up.
- **Provisional memory with TTL** — findings from unverified sources can be stored with an expiry and pruned automatically, versus permanent, verified clinical facts.
- **Time capsule** — query the patient's record as it stood at any past point in time.
- **Population insight** — aggregate patterns across all patients without exposing any single patient's identity.
- **Document ingestion** — upload PDFs or CSVs (discharge summaries, lab results) and have them parsed and folded into the graph, not just typed notes.
- **RxNorm normalization** — drug names are canonicalized against the NIH RxNorm database before being stored, so "Tylenol" and "acetaminophen" resolve to the same node.

## Architecture

```
frontend/   Next.js 16 + React 19 dashboard (single-page clinical UI)
backend/    FastAPI service, talks to Cognee Cloud and RxNorm
```

The backend is a thin, honest layer over Cognee: it does not run its own vector store or LLM calls outside of what Cognee provides. Its job is dataset isolation, temporal instructions, deterministic graph-path explanation, and the feedback ledger.

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
| `POST /analyze` | Full cross-consultation synthesis for a patient |
| `POST /simulate` | "What if" check for a drug not yet prescribed |
| `GET /debug_notes/{patient_id}` | Raw stored notes, for verification |
| `POST /explain` | Graph-path explanation for a given finding |
| `POST /feedback` | Record a clinician's confirm/dismiss judgment |
| `GET /ledger/{finding_title}` | Prior feedback consensus for a finding |
| `POST /improve` | Best-effort call into Cognee's native improve loop |
| `POST /clear` | Wipe a single patient's dataset |
| `GET /graph` | Visual graph view for a patient |

## Known limitations

Built against a live Cognee Cloud tenant, so these are real, current gaps rather than hypotheticals:

- `improve()` is not yet available on Cognee Cloud (confirmed with Cognee support), so Synapse layers its own feedback ledger on top rather than relying on it silently failing.
- Audio transcription is not enabled on Cognee Cloud; document upload (PDF/CSV) is the supported path for non-text input instead.
- `forget(everything=True)` currently errors on the Cloud tier; scoped per-dataset deletion (used throughout Synapse) works reliably and is what the app relies on.

## License

MIT — see [LICENSE](LICENSE).
