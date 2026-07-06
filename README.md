# Synapse

**A memory layer for clinical drug-safety review, built on Cognee Cloud's hybrid graph-vector memory.**

## The problem

A patient sees a cardiologist in January, a psychiatrist in March, and an endocrinologist in June. Each doctor writes their own notes, in their own system, with no idea what the others prescribed. Dangerous drug interactions slip through, not because anyone made a mistake, but because no single person, and no single system, ever held the whole picture at once.

Synapse is that missing picture. Every note, lab result, or discharge summary becomes a memory in a per-patient knowledge graph. Before a new drug is prescribed, Synapse recalls everything relevant across every past visit, works out when each drug was actually started or stopped, and surfaces interactions no single specialist could have known about on their own. When a clinician confirms or dismisses a finding, Synapse remembers that judgment and lets it shape future answers to the same question.

The graph, the temporal reasoning, and the feedback loop are the actual product here. Cognee's memory lifecycle is what makes all three possible without us having to build a graph database, a retrieval pipeline, or a vector store from scratch.

## How it's put together, and why it's built that way

Synapse is two small pieces of code wrapped around one big idea: let Cognee do the remembering, and keep everything else thin.

The **frontend** is a Next.js dashboard. It's the only place a clinician actually looks, and it does exactly three jobs: it lets you commit a note, it renders whatever the backend hands back (a finding, a graph, a timeline), and it draws a small D3 graph locally so you can see the shape of a patient's memory without waiting on Cognee's own graph explorer. It doesn't reason about anything itself.

The **backend** is a FastAPI service, and it's deliberately kept boring. It holds no database of its own, no vector index, no cached copy of anything. Its only real jobs are: keep every patient's data in its own isolated Cognee dataset, phrase the right question to Cognee at the right moment, and turn Cognee's answer into something the UI can render. Concretely, here's what happens on the two paths that matter most:

- **When a note is committed**, the backend first runs it through a small RxNorm-based normalizer, so "Zocor," "zocor," and "simvastatin" all collapse to the same canonical drug name before anything reaches Cognee. That normalized text is then written into that patient's dataset with `remember()`. If a drug pairs with something already active for that patient, the backend quietly appends a real pharmacology sentence to the note first (the actual mechanism, e.g. "amiodarone inhibits CYP3A4"), so Cognee's own graph extraction has a genuine fact to build an edge from, not just two drug names sitting in the same sentence.
- **When a clinician asks a question**, the backend doesn't just forward it. It wraps the question in a temporal instruction ("reconstruct this patient's full medication timeline before answering, and only trust dates and notes you can actually find") and a strict JSON schema, then sends that whole package to `recall()` in `GRAPH_COMPLETION` mode. Cognee comes back with a structured object: a plain-language narrative, plus a list of findings, each with a severity, a mechanism, and whether it's still active. Because LLMs occasionally wander off-schema even when told exactly what shape to return, the backend checks the shape it got back and silently retries once before giving up, so a single bad response doesn't show up as a mysteriously empty result on screen.

Two structural decisions run underneath almost everything above them, and they're worth calling out on their own, because they're the reason several of the more unusual features work at all:

- **Every patient is a separate Cognee dataset.** Not a filter, not a tag, an actual separate memory. That's what makes it safe to later ask "how many patients have both these drugs active" without ever reading one patient's notes in the context of another's.
- **Every recall is temporally framed.** Cognee doesn't get asked "does X interact with Y," it gets asked "reconstruct the whole timeline, then tell me." That single habit is what lets a discontinued drug's interaction correctly resolve itself the next time anyone asks, instead of staying flagged forever because of a note from four months ago.

## How Synapse uses Cognee

- **`remember()`** writes every note, document, and piece of clinician feedback into a per-patient Cognee dataset (`dataset_name=patient_id`), so one patient's record can never bleed into another's graph. A retry ladder never falls back to Cognee's default dataset; a failed write raises loudly instead of silently corrupting isolation.
- **`recall()`** is pinned to `SearchType.GRAPH_COMPLETION` on every call, so retrieval is always genuine graph traversal, not an auto-routed vector shortcut. Every question carries a temporal instruction that makes the model reconstruct a patient's full medication timeline before answering. `recall(..., only_context=True)` pulls raw graph triples with no LLM synthesis at all, used purely for deterministic explainability.
- **`improve()`** is called after every clinician feedback event, folding that judgment back into memory. Synapse also layers a fleet-wide consensus ledger on top of it: every confirm or dismiss is tallied across the whole patient population, and that accumulated judgment gets injected back into future `recall()` calls as context, so a pattern confirmed or dismissed elsewhere quietly shapes the next answer, not just a passive counter sitting beside it.
- **`forget()`** is used surgically. Provisional notes carry a real TTL and are removed one at a time via `forget(dataset=..., data_id=..., memory_only=True)`. A full `forget(dataset=patient_id)` powers the per-patient "Forget" action, scoped so clearing one patient never touches another.

## What it actually does

- **Cross-consultation synthesis.** Ask a question about a patient and Synapse answers from everything ever recorded for them, across every specialty, not just the note you're looking at.
- **Temporal reasoning that actually resolves.** A drug that was started and later stopped is correctly treated as inactive, and a finding that was once flagged visibly resolves itself the next time it's checked, because Cognee re-reads the whole timeline instead of trusting the last note it happened to see.
- **A real explanation, not a restated guess.** "Explain" runs a deterministic search over Cognee's own stored graph edges and shows you the literal path connecting two entities. If the path exists, you see it. If it doesn't, it says so.
- **A working feedback loop.** Confirming or dismissing a finding is remembered, tallied across every patient who's ever had that same finding, and fed back into how future questions get answered.
- **Provisional memory with a real expiry.** A speculative, unconfirmed note can be given a TTL and later forgotten individually, the same way a real chart distinguishes a working hypothesis from a confirmed fact.
- **Sequence-symmetry corroboration.** When a symptom might corroborate a finding, Synapse checks whether it actually follows the drug's start date by a plausible interval, not just whether both happen to appear somewhere in the same record.
- **Time-capsule queries.** Ask what was true as of a date in the past, not just what's true now, using Cognee's own temporal graph as a point-in-time index.
- **Privacy-safe population checks.** Ask "how many patients currently have both these drugs active" and get back a safe aggregate count, with identities only ever disclosed once the matching group is large enough that no one could be picked out.
- **Autonomous signal discovery.** This is the one that doesn't wait to be asked. It scans every drug pair that actually co-occurs across the whole patient population and flags any pair that isn't already a known interaction, where a symptom shows up disproportionately more often among the patients exposed to it, using the same statistic (Proportional Reporting Ratio) that real drug-safety regulators use to screen for signals. It gets more capable the more patients it remembers, which is the entire point of a memory that doesn't forget.

## Take it for a spin

These are the exact inputs to try, in order, on a fresh patient (use **+ New Patient** so nothing from earlier testing gets in the way).

**See a cross-specialty interaction get caught, then resolve itself**

1. Specialty **Cardiology**: `2025-09-01: Atrial fibrillation. Started Amiodarone 200mg daily.`
2. Specialty **Neurology**: `2026-02-14: Muscle fatigue. Started Simvastatin 40mg for high cholesterol.`
3. Click **Recall · run()**. Amiodarone and simvastatin get flagged as a major interaction, reasoned live over the graph, with both specialties correctly credited.
4. Add: `2026-03-01: Discontinued Amiodarone; rhythm stable without it.` Run Recall again. The same finding now reads **Resolved by temporal reasoning**.

**Check something before it's ever prescribed**

In the Simulation panel, type a drug name that isn't in the patient's record yet, for example `Warfarin`. Nothing is written to the patient's memory; it's a pure hypothetical.

**See the reasoning, not just the verdict**

Click **Explain** on any finding. It traces the literal path between the two entities through Cognee's own stored graph.

**Give it feedback and watch it accumulate**

Click **Confirm** on a finding. A fleet-wide tally appears immediately, and if the same finding gets confirmed disproportionately more than others across enough patients, a statistical signal badge appears alongside it.

**Give it something temporary**

In the Provisional panel, add a speculative note with a short TTL (try 15 seconds), wait, then click **Prune**. It's forgotten on its own, without touching anything else in the record.

**Upload a real document**

Try a PDF discharge summary or a lab-results CSV in the ingest panel. Cognee's native document parsing extracts the text server-side, no separate OCR or ML pipeline involved.

**Ask what was true in the past**

In the Time Capsule panel, pick a date before your discontinuation note above. It correctly reports both drugs as active and the interaction as live, exactly as it stood on that date.

**Check exposure across everyone, privately**

In Population Insight, enter the same two drug names from your test patient. You'll get back a count, and, once enough patients qualify, the specific patients matching, never below a safe threshold.

**Let it find something nobody told it about**

This one needs a few patients. Create two patients who both have `verapamil` and `clopidogrel` active, and both mention `dizziness`. Create one or two more patients on unrelated drugs with no symptoms. Then click **Scan population for undocumented signals** in the Signal Discovery panel. It surfaces the pair as a candidate signal, not in Synapse's known-interaction list, with the actual statistic and its reasoning shown alongside it, including an honest note when the sample size is small.

## Research grounding

Cognee's hybrid graph-vector memory descends from a real research lineage, and Synapse leans on it deliberately rather than treating Cognee as a black box:

- **Complementary Learning Systems theory** (McClelland, McNaughton & O'Reilly, 1995): the hippocampus does fast episodic encoding while the neocortex slowly consolidates stable semantic knowledge. Synapse's provisional TTL notes versus permanent memory are that same split, applied to a clinical record.
- **HippoRAG** (Gutiérrez et al., NeurIPS 2024) applies hippocampal indexing theory to long-term LLM memory, the research line Cognee's own architecture builds on.
- **GraphRAG** (Edge et al., Microsoft Research, 2024) is the published case for why graph-structured retrieval beats flat vector search on multi-hop, cross-document questions, exactly the shape of cross-specialty synthesis.
- **Path-based knowledge-graph explainability** (DeepPath, Xiong et al., 2017; MINERVA, Das et al., 2018) is the research area behind Synapse's deterministic graph-path explanations.

And three named methods borrowed from pharmacoepidemiology and privacy research, not invented for the occasion:

- **Proportional Reporting Ratio** (Evans, Waller & Davis, 2001), the disproportionality statistic regulators use to screen adverse-event reports. Signal discovery uses the textbook version on real per-patient exposure data; the feedback ledger uses an adapted version, since feedback events don't have an independent control group the way real adverse-event reports do.
- **Sequence Symmetry Analysis** (Hallas, 1996): check the order and interval between a drug's start and a symptom, not just whether both appear somewhere in the record.
- **k-anonymity** (Sweeney, 2002): population checks only ever disclose identities once the matching group clears a safe minimum size.

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
