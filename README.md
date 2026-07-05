# Synapse

**A memory layer for clinical drug-safety review, built on Cognee Cloud's hybrid graph-vector memory.**

## The problem

A patient sees a cardiologist in January, a psychiatrist in March, and an endocrinologist in June. Each doctor writes their own notes, in their own system, with no idea what the others prescribed. Dangerous drug interactions slip through because no single system ever holds the whole picture.

Synapse is that missing picture. Every note, lab result, or discharge summary becomes a memory in a per-patient knowledge graph. Before a new drug is prescribed, Synapse recalls everything relevant across every past visit, reasons over when each drug was started or stopped, and surfaces interactions no single specialist could have known about. When a clinician confirms or dismisses a finding, Synapse remembers that judgment and factors it into future answers.

The graph, the temporal reasoning, and the feedback loop are the product. Cognee's memory lifecycle is what makes all three possible without building a graph database, retrieval pipeline, or vector store from scratch.

## How Synapse uses Cognee

- **`remember()`** writes every note, document, and piece of clinician feedback into a per-patient Cognee dataset (`dataset_name=patient_id`), so one patient's record can never bleed into another's graph. A retry ladder (`_remember`) never falls back to Cognee's default dataset; a failed write raises loudly instead of silently corrupting isolation.
- **`recall()`** is pinned to `SearchType.GRAPH_COMPLETION` on every call, so retrieval is always genuine graph traversal, not an auto-routed vector shortcut. Every question is prepended with a temporal instruction that makes the model reconstruct a patient's full medication timeline before answering. `recall(..., only_context=True)` pulls raw graph triples with no LLM synthesis, used for deterministic explainability (see XAI below).
- **`improve()`** is called after every clinician feedback event. Cognee Cloud doesn't expose this endpoint publicly yet (confirmed with Cognee's team), so Synapse also remembers the feedback as a plain-language fact and layers a cross-patient consensus ledger on top, a working substitute built because the real thing wasn't available yet.
- **`forget()`** is used surgically. Provisional notes carry a real TTL and are removed one at a time via `forget(dataset=..., data_id=..., memory_only=True)`. A full `forget(dataset=patient_id)` powers the per-patient "Forget" action, scoped so clearing one patient never touches another.

Two more Cognee capabilities most integrations skip:

- **Temporal cognify** (`temporal_cognify=True`) so the graph understands when something happened, not just that it happened. A drug started in September and stopped in December is correctly excluded from a check run in February.
- **Structured findings from the graph.** `/analyze` asks `recall()` for a strict JSON contract (`kind`, `drug_a`, `drug_b`, `severity`, `mechanism`, `resolved`, `specialties`) reasoned live over the patient's graph, with backend normalization to absorb the key drift LLMs introduce even against an explicit schema. The severity badge and "Resolved by temporal reasoning" banner are Cognee's own conclusion, not a lookup table.

## What makes this different

- **Autonomous signal discovery.** `/discover_signals` doesn't check a pair someone already suspects. It scans every drug pair that co-occurs across the fleet's isolated datasets and flags any pair not already known to Synapse where a symptom appears disproportionately more often among exposed patients than unexposed ones, using the same Proportional Reporting Ratio formula regulators use to screen adverse-event databases. It gets more capable the more patients it remembers.
- **Cross-consultation synthesis** finds interactions no single specialist's notes would reveal, because Cognee's graph connects entities across every specialty a patient has seen.
- **Temporal reasoning** resolves risk over time instead of freezing it at the moment a drug was first mentioned. A discontinued drug's flagged interaction visibly resolves the next time the graph is queried.
- **Explainable AI over a real graph.** "Explain" runs a deterministic breadth-first search over Cognee's raw stored edges and renders the actual path connecting two entities, grounded in stored graph structure, not a restated guess.
- **A working `improve()` substitute**: a fleet-wide confirm/dismiss ledger that conditions future answers and gets injected back into the recall prompt as context.
- **Provisional memory with a real TTL.** Speculative findings decay and are individually forgotten via `memory_only` deletion, never a full dataset wipe.
- **Sequence-symmetry temporal corroboration.** A corroborating symptom is checked against the drug's actual start date, not just its presence somewhere in the record.
- **A disproportionality signal, not a vote count.** Repeated clinician feedback is scored with a PRR-style statistic, so "confirmed 4 times" becomes "confirmed disproportionately more than the fleet's baseline."
- **Time capsule queries** ask what was true as of a past date, using Cognee's temporal graph as a point-in-time index.
- **Privacy-safe population insight** checks a yes/no question across every isolated patient dataset and returns only aggregate counts.
- **RxNorm-normalized ingestion.** Drug names are canonicalized before they reach `remember()`, so "Zocor" and "simvastatin" become the same graph node.

## Research grounding

Cognee's hybrid graph-vector memory descends from a real research lineage, and Synapse leans on it deliberately:

- **Complementary Learning Systems theory** (McClelland, McNaughton & O'Reilly, 1995): the hippocampus does fast episodic encoding while the neocortex slowly consolidates stable semantic knowledge. Synapse's provisional TTL notes versus permanent `remember()` calls are that same split applied to a clinical record.
- **HippoRAG** (Gutiérrez et al., NeurIPS 2024) applies hippocampal indexing theory to long-term LLM memory, the research line Cognee's architecture builds on.
- **GraphRAG** (Edge et al., Microsoft Research, 2024) is the published case for why graph-structured retrieval outperforms flat vector RAG on multi-hop, cross-document questions, exactly the shape of cross-specialty synthesis.
- **Path-based knowledge-graph explainability** (DeepPath, Xiong et al., 2017; MINERVA, Das et al., 2018) is the research area `/explain`'s deterministic graph-path traversal is a simplified instance of.

Three named methods from pharmacoepidemiology and privacy research, not invented heuristics:

- **Proportional Reporting Ratio** (Evans, Waller & Davis, 2001), the disproportionality statistic regulators use to screen adverse-event reports (FDA FAERS, WHO VigiBase). `/discover_signals` uses the textbook 2×2 contingency formula on real per-patient exposure/outcome data. `/ledger/{finding_title}` uses an adapted version over the clinician feedback ledger, since there's no independent adverse-event denominator for feedback events. Both flag a signal at PRR >= 2 with a handful of reports, the conventional screening rule.
- **Sequence Symmetry Analysis** (Hallas, 1996) checks the order and interval between a drug's start and a marker event, not just that both appear somewhere in the record.
- **k-anonymity** (Sweeney, 2002): `/population_insight` only discloses matching patient IDs once the group clears k=3. Below that, only the count is returned.

## Try it in under 2 minutes

1. Start both servers (below).
2. Select patient **Otis Reyes**, specialty **Cardiology**, and commit: `2025-09-01: Atrial fibrillation. Started Amiodarone 200mg daily.`
3. Switch specialty to **Neurology**, commit: `2026-02-14: Muscle fatigue. Started Simvastatin 40mg for high cholesterol.`
4. Click **Recall · run()**. Synapse traces the graph across both specialties and surfaces the Amiodarone + Simvastatin interaction, reasoned live by Cognee.
5. Add a third note: `2026-03-01: Discontinued Amiodarone; rhythm stable without it.` Run Recall again. The finding now shows **Resolved by temporal reasoning**.
6. Click **Confirm** on the finding, then **Explain** to see the literal graph path connecting the two drugs.

## Architecture

```
frontend/   Next.js 16 + React 19 dashboard (single-page clinical UI)
backend/    FastAPI service, talks to Cognee Cloud and RxNorm
```

The backend is a thin layer over Cognee. It doesn't run its own vector store, graph database, or LLM calls outside of what Cognee provides. Its job is dataset isolation, temporal and schema prompting, deterministic graph-path explanation, and the client-side feedback ledger.

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
| `POST /population_insight` | k-anonymized cross-patient aggregation |
| `POST /discover_signals` | Fleet-wide PRR sweep for undocumented drug-symptom signals |
| `POST /analyze` | Cross-consultation synthesis with Cognee-derived structured findings |
| `POST /simulate` | "What if" check for a drug not yet prescribed |
| `GET /debug_notes/{patient_id}` | Raw stored notes, for verification |
| `POST /explain` | Graph-path explanation for a given finding |
| `POST /feedback` | Record a clinician's confirm/dismiss judgment |
| `GET /ledger/{finding_title}` | Fleet consensus for a finding, plus its PRR signal |
| `POST /improve` | Best-effort call into Cognee's native improve loop |
| `POST /clear` | Wipe a single patient's dataset |
| `GET /graph` | Visual graph view for a patient |
