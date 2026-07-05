// @ts-nocheck
"use client";
import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import * as d3 from "d3";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Activity, Brain, ShieldAlert, FlaskConical, Stethoscope, Plus,
  Sparkles, Trash2, Network, Clock, Database, ChevronRight, X, Check,
  AlertTriangle, Info, Zap, User, FileText, History, Users, Radar,
} from "lucide-react";

const BACKEND_URL = "http://localhost:8000";

/* ── backend calls ──────────────────────────────────────────────── */
// fetch() only rejects on network failure. A 500 response resolves normally
// and would otherwise be silently treated as success. Always check r.ok first.
async function checkOk(r) {
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Backend error ${r.status}: ${body.slice(0, 300)}`);
  }
  return r;
}
async function apiRemember(patientId, specialty, text) {
  const fd = new FormData();
  fd.append("patient_id", patientId);
  fd.append("text_content", `[${specialty} Note]: ${text}`);
  const r = await checkOk(await fetch(`${BACKEND_URL}/ingest`, { method: "POST", body: fd }));
  return r.json();
}
async function apiRecall(patientId, query) {
  const r = await checkOk(await fetch(`${BACKEND_URL}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patient_id: patientId, query_text: query }),
  }));
  return r.json();
}
async function apiForget(patientId) {
  const fd = new FormData();
  fd.append("patient_id", patientId);
  const r = await checkOk(await fetch(`${BACKEND_URL}/clear`, { method: "POST", body: fd }));
  return r.json();
}
async function apiFeedback(patientId, findingTitle, judgment) {
  const r = await checkOk(await fetch(`${BACKEND_URL}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patient_id: patientId, finding_title: findingTitle, judgment }),
  }));
  return r.json();
}
async function apiSimulate(patientId, drug) {
  const r = await checkOk(await fetch(`${BACKEND_URL}/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patient_id: patientId, drug }),
  }));
  return (await r.json()).result;
}
async function apiExplain(patientId, termA, termB) {
  const r = await checkOk(await fetch(`${BACKEND_URL}/explain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patient_id: patientId, term_a: termA, term_b: termB }),
  }));
  return r.json();
}
async function apiIngestProvisional(patientId, specialty, text, ttlSeconds) {
  const r = await checkOk(await fetch(`${BACKEND_URL}/ingest_provisional`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patient_id: patientId, specialty, text_content: text, ttl_seconds: ttlSeconds }),
  }));
  return r.json();
}
async function apiProvisionalStatus() {
  const r = await checkOk(await fetch(`${BACKEND_URL}/provisional_status`));
  return (await r.json()).provisional;
}
async function apiPrune() {
  const r = await checkOk(await fetch(`${BACKEND_URL}/prune`, { method: "POST" }));
  return r.json();
}
async function apiIngestDocument(patientId, file) {
  const fd = new FormData();
  fd.append("patient_id", patientId);
  fd.append("file", file);
  const r = await checkOk(await fetch(`${BACKEND_URL}/ingest_document`, { method: "POST", body: fd }));
  return r.json();
}
async function apiTimelineSnapshot(patientId, asOfDate) {
  const r = await checkOk(await fetch(`${BACKEND_URL}/timeline_snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patient_id: patientId, as_of_date: asOfDate }),
  }));
  return r.json();
}
async function apiPopulationInsight(termA, termB) {
  const r = await checkOk(await fetch(`${BACKEND_URL}/population_insight`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ term_a: termA, term_b: termB }),
  }));
  return r.json();
}
async function apiLedgerLookup(findingTitle) {
  const r = await checkOk(await fetch(`${BACKEND_URL}/ledger/${encodeURIComponent(findingTitle)}`));
  return r.json();
}
async function apiDiscoverSignals() {
  const r = await checkOk(await fetch(`${BACKEND_URL}/discover_signals`, { method: "POST" }));
  return r.json();
}

/* ─────────────────── known clinical vocabulary ──────────────────────
   Used client-side only to spot which drugs/conditions/symptoms appear
   in note text, so the D3 graph can render nodes for them. Interaction
   severity, mechanism, and temporal resolution are never decided here.
   Those come from Cognee's recall() on the backend.                   */
const DRUGS = {
  amiodarone: "Amiodarone", simvastatin: "Simvastatin", atorvastatin: "Atorvastatin",
  rosuvastatin: "Rosuvastatin", pravastatin: "Pravastatin",
  warfarin: "Warfarin", apixaban: "Apixaban", rivaroxaban: "Rivaroxaban",
  verapamil: "Verapamil", diltiazem: "Diltiazem", amlodipine: "Amlodipine",
  metoprolol: "Metoprolol", propranolol: "Propranolol", lisinopril: "Lisinopril",
  enalapril: "Enalapril", losartan: "Losartan", clonidine: "Clonidine",
  hydrochlorothiazide: "Hydrochlorothiazide", furosemide: "Furosemide",
  spironolactone: "Spironolactone", digoxin: "Digoxin",
  metformin: "Metformin", glipizide: "Glipizide", insulin: "Insulin",
  levothyroxine: "Levothyroxine",
  clopidogrel: "Clopidogrel", omeprazole: "Omeprazole", pantoprazole: "Pantoprazole",
  sildenafil: "Sildenafil", nitroglycerin: "Nitroglycerin", aspirin: "Aspirin",
  ibuprofen: "Ibuprofen", naproxen: "Naproxen", celecoxib: "Celecoxib",
  acetaminophen: "Acetaminophen",
  sertraline: "Sertraline", fluoxetine: "Fluoxetine", citalopram: "Citalopram",
  escitalopram: "Escitalopram", venlafaxine: "Venlafaxine",
  alprazolam: "Alprazolam", lorazepam: "Lorazepam", quetiapine: "Quetiapine",
  gabapentin: "Gabapentin",
  tramadol: "Tramadol", oxycodone: "Oxycodone", hydrocodone: "Hydrocodone",
  morphine: "Morphine",
  amoxicillin: "Amoxicillin", azithromycin: "Azithromycin",
  ciprofloxacin: "Ciprofloxacin", doxycycline: "Doxycycline",
  albuterol: "Albuterol", montelukast: "Montelukast", prednisone: "Prednisone",
};
const CONDITIONS = {
  "atrial fibrillation": "Atrial Fibrillation", arrhythmia: "Arrhythmia",
  asthma: "Asthma", hypertension: "Hypertension", diabetes: "Diabetes",
  hyperlipidemia: "Hyperlipidemia", angina: "Angina", depression: "Depression",
  anxiety: "Anxiety", insomnia: "Insomnia", migraine: "Migraine",
  stroke: "Stroke", gerd: "GERD", copd: "COPD", obesity: "Obesity",
  hypothyroidism: "Hypothyroidism", osteoporosis: "Osteoporosis",
  "chronic kidney disease": "Chronic Kidney Disease",
};
const SYMPTOMS = {
  "muscle fatigue": "Muscle fatigue", "muscle pain": "Muscle pain",
  weakness: "Weakness", dizziness: "Dizziness", "chest pain": "Chest pain",
  "shortness of breath": "Shortness of breath", bleeding: "Bleeding",
  palpitations: "Palpitations", nausea: "Nausea", fatigue: "Fatigue",
  headache: "Headache", rash: "Rash", confusion: "Confusion",
  sedation: "Sedation", constipation: "Constipation", tremor: "Tremor",
};
const SPECIALTIES = [
  { name: "Cardiology", icon: Activity },
  { name: "Neurology", icon: Brain },
  { name: "Pharmacy", icon: FlaskConical },
  { name: "General Practice", icon: Stethoscope },
];

// Brand -> generic, mirrors backend/normalize.py's BRAND_TO_INGREDIENT so the
// client-side graph resolves "Zocor" to the same drug node as "simvastatin".
const BRAND_TO_GENERIC = {
  zocor: "simvastatin", coumadin: "warfarin", plavix: "clopidogrel",
  viagra: "sildenafil", advil: "ibuprofen", motrin: "ibuprofen",
  zoloft: "sertraline", crestor: "rosuvastatin", lipitor: "atorvastatin",
  eliquis: "apixaban", xarelto: "rivaroxaban", norvasc: "amlodipine",
  lasix: "furosemide", synthroid: "levothyroxine", glucophage: "metformin",
  lantus: "insulin", xanax: "alprazolam", ativan: "lorazepam",
  prozac: "fluoxetine", lexapro: "escitalopram", celexa: "citalopram",
  effexor: "venlafaxine", tylenol: "acetaminophen", aleve: "naproxen",
  prilosec: "omeprazole", protonix: "pantoprazole",
};

/* ── tiny keyword extractor, used only to drive the local D3 graph ── */
function scan(text, dict) {
  const low = text.toLowerCase();
  return Object.keys(dict).filter((k) => low.includes(k));
}
function scanDrugs(text) {
  const low = text.toLowerCase();
  const found = new Set();
  Object.keys(DRUGS).forEach((k) => { if (low.includes(k)) found.add(k); });
  Object.keys(BRAND_TO_GENERIC).forEach((brand) => {
    if (low.includes(brand)) found.add(BRAND_TO_GENERIC[brand]);
  });
  return [...found];
}
function extract(text) {
  return {
    drugs: scanDrugs(text),
    conditions: scan(text, CONDITIONS),
    symptoms: scan(text, SYMPTOMS),
  };
}
// First explicit YYYY-MM-DD date literally written in a note, if any.
function noteDate(text) {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(text || "");
  return m ? new Date(m[1]) : null;
}
// Sequence Symmetry Analysis (Hallas, 1996): a pharmacoepidemiology technique
// that compares the order and interval between a drug's start and a marker
// event (here, a corroborating symptom), rather than only checking that both
// appear somewhere in the same record. A symptom following drug start within
// a plausible window is stronger temporal evidence than one that predates the
// drug or trails it by an implausible margin. This runs on explicit dates
// already written in note text. It does not invent or infer a date.
function sequenceSymmetry(notes, drugTerm, symptomKeys) {
  if (!symptomKeys.length) return null;
  const drugDate = notes
    .filter((n) => n.text.toLowerCase().includes(drugTerm) && noteDate(n.text))
    .map((n) => noteDate(n.text))
    .sort((a, b) => a - b)[0];
  const symptomNote = notes
    .filter((n) => symptomKeys.some((s) => n.entities.symptoms.includes(s)) && noteDate(n.text))
    .sort((a, b) => noteDate(a.text) - noteDate(b.text))[0];
  if (!drugDate || !symptomNote) return null;
  const symptomDate = noteDate(symptomNote.text);
  const days = Math.round((symptomDate - drugDate) / 86400000);
  if (days < 0) return { days, verdict: "precedes" };
  if (days > 180) return { days, verdict: "distant" };
  return { days, verdict: "consistent" };
}
// Display label for a drug/condition name Cognee returned that isn't in the
// local vocabulary dicts above (e.g. one it knows from the graph but this
// app's node-labeling dict doesn't cover).
function titleCase(s) {
  return (s || "").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ── seed patients ─────────────────────────────────────────────── */
const SEED = () => ({
  p_otis_reyes: { name: "Otis Reyes", mrn: "MRN-4471", age: 68, sex: "M", notes: [] },
  p_annie_walsh: { name: "Annie Walsh", mrn: "MRN-2208", age: 54, sex: "F", notes: [] },
});

/* ─────────────────────── color tokens ─────────────────────────── */
const C = {
  patient: "#36D6C3", drug: "#5BA8FF", condition: "#C792EA",
  symptom: "#FFB454", specialty: "#6B7A99",
};
const SEV = {
  critical: { label: "Critical", color: "#FF5C72", icon: Zap },
  major: { label: "Major", color: "#FF8A4C", icon: AlertTriangle },
  moderate: { label: "Moderate", color: "#FFB454", icon: AlertTriangle },
  info: { label: "Info", color: "#5BA8FF", icon: Info },
  resolved: { label: "Resolved", color: "#36D6C3", icon: Clock },
};

/* ═══════════════════════ COMPONENT ════════════════════════════ */
export default function SynapseMedDashboard() {
  const [patients, setPatients] = useState(SEED);
  const [activeId, setActiveId] = useState("p_otis_reyes");
  const [specialty, setSpecialty] = useState("Cardiology");
  const [noteText, setNoteText] = useState("");
  const [query, setQuery] = useState("Check for drug interactions and cross-specialty risks.");
  const [findings, setFindings] = useState(null);
  const [cogneeText, setCogneeText] = useState("");
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [graphView, setGraphView] = useState("synth"); // synth | cognee
  const [showNewPatientInput, setShowNewPatientInput] = useState(false);
  const [newPatientName, setNewPatientName] = useState("");
  const [reviewed, setReviewed] = useState({}); // `${patientId}::${findingTitle}` -> "confirm" | "dismiss"
  const [simDrug, setSimDrug] = useState("");
  const [simResult, setSimResult] = useState(null);
  const [simBusy, setSimBusy] = useState(false);
  const [explainByTitle, setExplainByTitle] = useState({}); // findingTitle -> { path, note, busy }
  const [provisionalText, setProvisionalText] = useState("");
  const [provisionalTTL, setProvisionalTTL] = useState(30);
  const [provisionalList, setProvisionalList] = useState([]);
  const [provisionalBusy, setProvisionalBusy] = useState(false);
  const [documentFile, setDocumentFile] = useState(null);
  const [documentBusy, setDocumentBusy] = useState(false);
  const [documentResult, setDocumentResult] = useState(null);
  const [snapshotDate, setSnapshotDate] = useState("");
  const [snapshotResult, setSnapshotResult] = useState(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [ledgerByTitle, setLedgerByTitle] = useState({}); // findingTitle -> {confirm, dismiss}
  const [popA, setPopA] = useState("");
  const [popB, setPopB] = useState("");
  const [popResult, setPopResult] = useState(null);
  const [popBusy, setPopBusy] = useState(false);
  const [discoverResult, setDiscoverResult] = useState(null);
  const [discoverBusy, setDiscoverBusy] = useState(false);

  const patient = patients[activeId];
  const notes = patient.notes;

  const flash = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  /* ── add a brand-new patient with a guaranteed-fresh, never-touched Cognee dataset ── */
  const addNewPatient = () => {
    const name = newPatientName.trim();
    if (!name) return;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "patient";
    const id = `p_${slug}_${Date.now().toString(36)}`; // timestamp suffix guarantees a fresh dataset
    setPatients((prev) => ({ ...prev,
      [id]: { name, mrn: `MRN-${Math.floor(1000 + Math.random() * 9000)}`, age: 0, sex: "-", notes: [] } }));
    setActiveId(id);
    setNewPatientName(""); setShowNewPatientInput(false);
    setFindings(null); setCogneeText(""); setSelected(null);
    flash(`New patient created · fresh, untouched dataset (${id})`);
  };

  /* ── build graph data from this patient's notes ── */
  const graph = useMemo(() => {
    const nodes = new Map();
    const links = [];
    const add = (id, label, type) => {
      if (!nodes.has(id)) nodes.set(id, { id, label, type });
      return id;
    };
    add("patient", patient.name, "patient");
    const seenSpec = new Set();
    notes.forEach((n) => {
      const sId = add(`spec:${n.specialty}`, n.specialty, "specialty");
      if (!seenSpec.has(sId)) {
        links.push({ source: "patient", target: sId, kind: "consult" });
        seenSpec.add(sId);
      }
      n.entities.drugs.forEach((d) =>
        links.push({ source: sId, target: add(`drug:${d}`, DRUGS[d], "drug"), kind: "noted" }));
      n.entities.conditions.forEach((c) =>
        links.push({ source: sId, target: add(`cond:${c}`, CONDITIONS[c], "condition"), kind: "noted" }));
      n.entities.symptoms.forEach((s) =>
        links.push({ source: sId, target: add(`sym:${s}`, SYMPTOMS[s], "symptom"), kind: "noted" }));
    });
    // Risk/resolved edges come from Cognee's own findings (set by runAnalyze),
    // not a local rules table, so the graph only draws an edge once Cognee's
    // reasoning has actually confirmed it.
    (findings || []).forEach((f) => {
      const aId = add(`drug:${f.drug_a}`, DRUGS[f.drug_a] || titleCase(f.drug_a), "drug");
      const bId = f.kind === "drug_condition"
        ? add(`cond:${f.drug_b}`, CONDITIONS[f.drug_b] || titleCase(f.drug_b), "condition")
        : add(`drug:${f.drug_b}`, DRUGS[f.drug_b] || titleCase(f.drug_b), "drug");
      links.push({ source: aId, target: bId, kind: f.resolved ? "resolved" : "risk", severity: f.severity });
    });
    return { nodes: [...nodes.values()], links };
  }, [notes, patient.name, findings]);

  /* ── analyze: recall() reasoning over this patient's full record ── */
  const runAnalyze = async () => {
    setBusy(true);
    try {
      const res = await apiRecall(activeId, query);
      const data = res.data;
      setCogneeText(Array.isArray(data) ? data.join("\n\n") : String(data ?? ""));
      const order = { critical: 0, major: 1, moderate: 2, info: 3 };
      const out = (res.findings || []).map((f) => {
        const sources = [...new Set(f.specialties || [])];
        // Matched against raw note text, not the local drug dict, so
        // corroboration works for any drug Cognee names, not only the
        // small vocabulary this app recognizes for graph-node labeling.
        const corro = notes
          .filter((n) => n.text.toLowerCase().includes(f.drug_a) || n.text.toLowerCase().includes(f.drug_b))
          .flatMap((n) => n.entities.symptoms);
        const uniqueCorro = [...new Set(corro)];
        const temporal = f.kind === "drug_drug" && !f.resolved
          ? sequenceSymmetry(notes, f.drug_a, uniqueCorro) || sequenceSymmetry(notes, f.drug_b, uniqueCorro)
          : null;
        return {
          ...f,
          title: `${DRUGS[f.drug_a] || titleCase(f.drug_a)} + ${DRUGS[f.drug_b] || CONDITIONS[f.drug_b] || titleCase(f.drug_b)}`,
          sources, crossSpecialty: sources.length > 1,
          corro: uniqueCorro, temporal,
        };
      }).sort((x, y) => (x.resolved - y.resolved) || (order[x.severity] ?? 9) - (order[y.severity] ?? 9));
      setFindings(out);
      refreshLedgerFor(out.map((f) => f.title));
    } catch {
      setCogneeText("Could not reach Cognee backend at " + BACKEND_URL);
      setFindings([]);
    }
    setBusy(false);
  };

  /* ── commit a note (remember) ── */
  const commit = async () => {
    if (!noteText.trim()) return;
    setBusy(true);
    const note = {
      id: `note_${Date.now()}`, specialty, text: noteText.trim(),
      entities: extract(noteText), ts: new Date(),
    };
    let backendMsg = "";
    try {
      const res = await apiRemember(activeId, specialty, noteText);
      if (res?.normalized?.length) {
        const chips = res.normalized
          .map((m) => (m.rxcui ? `${m.raw}→${m.canonical} (RxCUI ${m.rxcui})` : `${m.raw}→${m.canonical}`))
          .join(" · ");
        backendMsg = "Normalized: " + chips;
      }
      if (res?.alerts?.length) setCogneeText(res.alerts.join("\n\n"));
    } catch (e) {
      // Shown in the graph locally, but NOT actually stored in Cognee.
      // Make that distinction unmistakable instead of a vague "saved" message.
      backendMsg = `⚠ NOT stored in Cognee: ${e.message || "backend unreachable"}`;
    }
    setPatients((prev) => ({ ...prev,
      [activeId]: { ...prev[activeId], notes: [...prev[activeId].notes, note] } }));
    setNoteText(""); setFindings(null);
    const hits = note.entities.drugs.length + note.entities.conditions.length + note.entities.symptoms.length;
    flash(backendMsg || `Committed to memory · ${hits} clinical concept${hits === 1 ? "" : "s"} extracted`);
    setBusy(false);
  };

  /* ── TTL/decay pruning: provisional notes expire, then get surgically forget()'ed ── */
  const refreshProvisional = async () => {
    try { setProvisionalList(await apiProvisionalStatus()); } catch {}
  };
  const commitProvisional = async () => {
    if (!provisionalText.trim()) return;
    setProvisionalBusy(true);
    try {
      await apiIngestProvisional(activeId, specialty, provisionalText.trim(), provisionalTTL);
      setProvisionalText("");
      flash(`Stored provisional note · expires in ${provisionalTTL}s`);
      await refreshProvisional();
    } catch (e) {
      flash(`⚠ NOT stored: ${e.message}`);
    }
    setProvisionalBusy(false);
  };
  const runPrune = async () => {
    setProvisionalBusy(true);
    try {
      const res = await apiPrune();
      flash(res.pruned.length
        ? `Pruned ${res.pruned.length} expired note(s) · surgically forgotten via forget()`
        : "No expired provisional notes to prune yet");
      await refreshProvisional();
    } catch (e) {
      flash(`⚠ Prune failed: ${e.message}`);
    }
    setProvisionalBusy(false);
  };

  /* ── clinical document upload: PDF/CSV/docx via Cognee's native document types (pure-Python extraction, no ML-model dependency) ── */
  const commitDocument = async () => {
    if (!documentFile) return;
    setDocumentBusy(true);
    setDocumentResult(null);
    try {
      const res = await apiIngestDocument(activeId, documentFile);
      const combined = [res?.summary?.join("\n\n"), res?.alerts?.join("\n\n")].filter(Boolean).join("\n\n---\n\n");
      setDocumentResult(combined || "(No summary returned. Extraction may have found nothing usable.)");
      if (combined) setCogneeText(combined);
      const note = {
        id: `doc_${Date.now()}`, specialty, text: `[${specialty} Document]: ${documentFile.name}, extracted by Cognee.`,
        entities: { drugs: [], conditions: [], symptoms: [] }, ts: new Date(),
      };
      setPatients((prev) => ({ ...prev,
        [activeId]: { ...prev[activeId], notes: [...prev[activeId].notes, note] } }));
      setDocumentFile(null); setFindings(null);
      flash("Document extracted by Cognee Cloud");
    } catch (e) {
      setDocumentResult(`⚠ NOT stored in Cognee: ${e.message}`);
      flash(`⚠ NOT stored in Cognee: ${e.message}`);
    }
    setDocumentBusy(false);
  };

  /* ── time capsule: what was true as of a PAST date, not today ── */
  const runSnapshot = async () => {
    if (!snapshotDate) return;
    setSnapshotBusy(true);
    try {
      const res = await apiTimelineSnapshot(activeId, snapshotDate);
      setSnapshotResult(res.result?.join("\n\n") || "No result.");
    } catch (e) {
      setSnapshotResult(`Could not reach backend: ${e.message}`);
    }
    setSnapshotBusy(false);
  };

  /* ── population insight: aggregated yes/no across isolated patient datasets ── */
  const runPopulationInsight = async () => {
    if (!popA.trim() || !popB.trim()) return;
    setPopBusy(true);
    try {
      const res = await apiPopulationInsight(popA.trim(), popB.trim());
      setPopResult(res);
    } catch (e) {
      setPopResult({ checked: 0, matching_patients: [], count: 0, note: `Error: ${e.message}` });
    }
    setPopBusy(false);
  };

  /* ── signal discovery: fleet-wide PRR sweep for undocumented drug pairs ── */
  const runDiscoverSignals = async () => {
    setDiscoverBusy(true);
    try {
      const res = await apiDiscoverSignals();
      setDiscoverResult(res);
    } catch (e) {
      setDiscoverResult({ patients_scanned: 0, candidate_signals: [], note: `Error: ${e.message}` });
    }
    setDiscoverBusy(false);
  };

  /* ── fleet-wide ledger: look up confirm/dismiss tallies for each finding ── */
  const refreshLedgerFor = async (findingTitles) => {
    if (!findingTitles.length) return;
    const entries = await Promise.all(findingTitles.map(async (title) => {
      try { return [title, await apiLedgerLookup(title)]; }
      catch { return [title, null]; }
    }));
    setLedgerByTitle((prev) => {
      const next = { ...prev };
      entries.forEach(([title, data]) => { if (data) next[title] = data; });
      return next;
    });
  };

  /* ── clinician confirms/dismisses a finding → stored + triggers improve() ── */
  const submitFeedback = async (findingTitle, judgment) => {
    const key = `${activeId}::${findingTitle}`;
    setReviewed((prev) => ({ ...prev, [key]: judgment }));
    const verb = judgment === "confirm" ? "Confirmed" : "Dismissed";
    let msg = `${verb} · feedback stored (QAEntry + FeedbackEntry)`;
    try {
      const res = await apiFeedback(activeId, findingTitle, judgment);
      msg += res?.enriched ? " · graph re-weighted" : " · improve() unavailable on this tenant, feedback still recorded";
      if (res?.ledger) setLedgerByTitle((prev) => ({ ...prev, [findingTitle]: res.ledger }));
    } catch (e) { msg = `⚠ Feedback NOT stored: ${e.message}`; }
    flash(msg);
  };

  /* ── counterfactual what-if: read-only recall, nothing is stored ── */
  const runSimulate = async () => {
    if (!simDrug.trim()) return;
    setSimBusy(true);
    try {
      const data = await apiSimulate(activeId, simDrug.trim());
      setSimResult(Array.isArray(data) ? data.join("\n\n") : String(data ?? "No interactions found."));
    } catch {
      setSimResult("Could not reach Cognee backend at " + BACKEND_URL);
    }
    setSimBusy(false);
  };

  /* ── XAI: deterministic breadcrumb over Cognee's raw graph triples ── */
  const runExplain = async (f) => {
    setExplainByTitle((prev) => ({ ...prev, [f.title]: { busy: true } }));
    try {
      const data = await apiExplain(activeId, f.drug_a, f.drug_b);
      setExplainByTitle((prev) => ({ ...prev, [f.title]: { busy: false, path: data.path, note: data.note } }));
    } catch (e) {
      setExplainByTitle((prev) => ({ ...prev, [f.title]: { busy: false, note: `Could not reach backend: ${e.message}` } }));
    }
  };

  const forget = async () => {
    setBusy(true);
    let msg = "Patient memory cleared";
    try {
      const res = await apiForget(activeId);
      if (res?.status !== "cleared") msg = `⚠ Cloud clear failed: ${res?.detail || "unknown error"}`;
    } catch (e) { msg = `⚠ Cloud clear failed: ${e.message}`; }
    setPatients((prev) => ({ ...prev, [activeId]: { ...prev[activeId], notes: [] } }));
    setFindings(null); setCogneeText(""); setSelected(null);
    flash(msg);
    setBusy(false);
  };

  const stats = useMemo(() => ({
    notes: notes.length,
    entities: graph.nodes.filter((n) => ["drug", "condition", "symptom"].includes(n.type)).length,
    links: graph.links.length,
    sessions: new Set(notes.map((n) => n.specialty)).size,
  }), [notes, graph]);

  return (
    <div style={{ background: "#0A1019", color: "#E8EEF7", fontFamily: "Inter, system-ui, sans-serif" }}
      className="min-h-screen w-full">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        .disp { font-family:'Space Grotesk',system-ui,sans-serif; }
        .mono { font-family:'IBM Plex Mono',ui-monospace,monospace; }
        @keyframes pulseRed { 0%,100%{opacity:.35} 50%{opacity:.9} }
        @keyframes popIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:none} }
        .pop { animation: popIn .35s ease both; }
        .scrolln::-webkit-scrollbar{width:8px} .scrolln::-webkit-scrollbar-thumb{background:#1E2A40;border-radius:8px}
        @media (prefers-reduced-motion: reduce){ .pop{animation:none} }
        .wrap{ max-width:1400px; margin-left:auto; margin-right:auto; }
        .mainGrid{ display:grid; grid-template-columns:1fr; gap:1rem; }
        @media (min-width:1024px){ .mainGrid{ grid-template-columns:340px 1fr; } }
        /* guarantee arbitrary-value utilities render without JIT */
        .text-\\[9px\\]{font-size:9px} .text-\\[10px\\]{font-size:10px}
        .text-\\[10\\.5px\\]{font-size:10.5px} .text-\\[11px\\]{font-size:11px}
        .text-\\[12px\\]{font-size:12px} .text-\\[13px\\]{font-size:13px}
        .text-\\[14px\\]{font-size:14px} .text-\\[17px\\]{font-size:17px}
        .w-\\[68px\\]{width:68px}
      `}</style>

      {/* HEADER */}
      <header className="sticky top-0 z-20 backdrop-blur"
        style={{ borderBottom: "1px solid #16223A", background: "rgba(10,16,25,.82)" }}>
        <div className="wrap px-6 py-3 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className="grid place-items-center h-9 w-9 rounded-lg"
              style={{ background: "linear-gradient(135deg,#0E3A37,#0A1019)", border: "1px solid #1C5C56" }}>
              <Network className="h-5 w-5" style={{ color: C.patient }} />
            </div>
            <div className="leading-none">
              <div className="disp text-[17px] font-bold tracking-tight">Synapse</div>
            </div>
          </div>

          {/* patient selector */}
          <div className="flex items-center gap-1.5 ml-2">
            {Object.entries(patients).map(([id, p]) => (
              <button key={id} onClick={() => { setActiveId(id); setFindings(null); setCogneeText(""); setSelected(null); }}
                className="px-3 py-1.5 rounded-lg text-sm transition-all flex items-center gap-2"
                style={ id === activeId
                  ? { background: "#0E3A37", border: "1px solid #1C5C56", color: "#E8EEF7" }
                  : { background: "#0E1626", border: "1px solid #16223A", color: "#8A99B4" } }>
                <User className="h-3.5 w-3.5" />
                <span className="font-medium">{p.name.split(" ")[0]}</span>
                <span className="mono text-[10px]" style={{ color: "#5C6B85" }}>{p.mrn}</span>
              </button>
            ))}
            {showNewPatientInput ? (
              <div className="flex items-center gap-1">
                <input autoFocus value={newPatientName} onChange={(e) => setNewPatientName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addNewPatient(); if (e.key === "Escape") setShowNewPatientInput(false); }}
                  placeholder="Patient name…"
                  className="px-2.5 py-1.5 rounded-lg text-sm outline-none"
                  style={{ background: "#0E1626", border: "1px solid #2C5C8E", color: "#E8EEF7", width: 140 }} />
                <button onClick={addNewPatient} disabled={!newPatientName.trim()}
                  className="px-2.5 py-1.5 rounded-lg text-sm transition-all disabled:opacity-40"
                  style={{ background: "#0E3A37", border: "1px solid #1C5C56", color: "#9FF3E8" }}>
                  Add
                </button>
              </div>
            ) : (
              <button onClick={() => setShowNewPatientInput(true)} title="New patient: fresh, untouched dataset"
                className="px-2.5 py-1.5 rounded-lg text-sm transition-all flex items-center gap-1"
                style={{ background: "#0E1626", border: "1px dashed #2C3A57", color: "#7C8BA8" }}>
                <Plus className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

        </div>
      </header>

      {/* STAT STRIP */}
      <div className="wrap px-6 pt-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { k: "Notes in memory", v: stats.notes, ic: FileText },
            { k: "Clinical concepts", v: stats.entities, ic: Database },
            { k: "Graph relationships", v: stats.links, ic: Network },
            { k: "Specialties linked", v: stats.sessions, ic: Stethoscope },
          ].map((s) => (
            <div key={s.k} className="rounded-xl px-4 py-3 flex items-center justify-between"
              style={{ background: "#0E1626", border: "1px solid #16223A" }}>
              <div>
                <div className="disp text-2xl font-bold leading-none">{s.v}</div>
                <div className="text-[11px] mt-1" style={{ color: "#6B7A99" }}>{s.k}</div>
              </div>
              <s.ic className="h-5 w-5" style={{ color: "#2C3A57" }} />
            </div>
          ))}
        </div>
      </div>

      {/* MAIN GRID */}
      <main className="wrap px-6 py-4 mainGrid">
        {/* LEFT: INGEST + LIFECYCLE */}
        <section className="space-y-4">
          <Panel title="Ingest specialty record" icon={Plus} accent="#36D6C3">
            <div className="grid grid-cols-2 gap-1.5 mb-3">
              {SPECIALTIES.map((s) => (
                <button key={s.name} onClick={() => setSpecialty(s.name)}
                  className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-[12px] font-medium transition-all"
                  style={ specialty === s.name
                    ? { background: "#11233E", border: "1px solid #2C5C8E", color: "#CFE3FF" }
                    : { background: "#0A111D", border: "1px solid #16223A", color: "#8A99B4" } }>
                  <s.icon className="h-3.5 w-3.5" /> {s.name}
                </button>
              ))}
            </div>
            <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} rows={5}
              placeholder={`Dictate the ${specialty} note…  e.g. "Initiated Amiodarone 200mg for atrial fibrillation."`}
              className="w-full rounded-lg p-3 text-sm resize-none outline-none"
              style={{ background: "#0A111D", border: "1px solid #16223A", color: "#E8EEF7" }} />
            <button onClick={commit} disabled={busy || !noteText.trim()}
              className="w-full mt-2.5 py-2.5 rounded-lg font-semibold text-sm transition-all disabled:opacity-40"
              style={{ background: "#0E3A37", border: "1px solid #1C5C56", color: "#9FF3E8" }}>
              {busy ? "Processing…" : "Commit to memory  ·  remember()"}
            </button>

            <div className="mt-3 pt-3" style={{ borderTop: "1px solid #16223A" }}>
              <div className="text-[11px] font-semibold mb-1.5 flex items-center gap-1.5" style={{ color: "#8A99B4" }}>
                <FileText className="h-3.5 w-3.5" /> Upload clinical document (PDF / CSV)
              </div>
              <label className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-[12px] cursor-pointer transition-all mb-1.5"
                style={{ background: "#0A111D", border: "1px dashed #2C5C8E", color: documentFile ? "#CFE3FF" : "#7C8BA8" }}>
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{documentFile ? documentFile.name : "Click to choose a PDF, CSV, or doc file…"}</span>
                <input type="file" accept=".pdf,.csv,.txt,.docx,.doc,.xlsx,.xls,.pptx,.ppt"
                  onChange={(e) => setDocumentFile(e.target.files?.[0] || null)}
                  className="hidden" />
              </label>
              <button onClick={commitDocument} disabled={documentBusy || !documentFile}
                className="w-full py-2 rounded-lg text-[12px] font-medium transition-all disabled:opacity-40"
                style={{ background: "#0E3A37", border: "1px solid #1C5C56", color: "#9FF3E8" }}>
                {documentBusy ? "Extracting…" : "Upload & extract document"}
              </button>
              <p className="text-[9.5px] mt-1" style={{ color: "#4A5775" }}>
                Cognee's native document types (pypdf, csv) extract text server-side. A discharge
                summary or lab export gets linked into the graph the same way a typed note does.
              </p>
              {documentResult && (
                <div className="rounded-lg p-2.5 mt-2"
                  style={{ background: "#0A1522", border: "1px solid #16223A", color: "#9AA8C2" }}>
                  <div className="mono text-[9px] uppercase tracking-wider mb-1.5" style={{ color: "#6B9BFF" }}>Result</div>
                  <Markdown>{documentResult}</Markdown>
                </div>
              )}
            </div>
          </Panel>

          <Panel title="Memory lifecycle" icon={Sparkles} accent="#C792EA">
            <p className="text-[12px] mb-3 leading-relaxed" style={{ color: "#8A99B4" }}>
              remember() and recall() run as you work above. improve() runs inside Confirm/Dismiss
              on each finding. forget() clears this patient's memory below.
            </p>
            <button onClick={forget} disabled={busy}
              className="w-full py-2.5 rounded-lg font-semibold text-sm transition-all disabled:opacity-40 flex items-center justify-center gap-2"
              style={{ background: "#2E0E14", border: "1px solid #5C1C2C", color: "#FF9FAE" }}>
              <Trash2 className="h-4 w-4" /> Forget · clear this patient
            </button>
          </Panel>

          {/* TIMELINE */}
          <Panel title="Session timeline" icon={Clock} accent="#FFB454">
            {notes.length === 0 ? (
              <p className="text-[12px]" style={{ color: "#5C6B85" }}>
                No sessions yet. Each committed note becomes a permanent, recallable memory.
              </p>
            ) : (
              <div className="space-y-2 overflow-y-auto scrolln pr-1" style={{ maxHeight: 220 }}>
                {[...notes].reverse().map((n) => (
                  <div key={n.id} className="rounded-lg p-2.5 pop"
                    style={{ background: "#0A111D", border: "1px solid #16223A" }}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] font-semibold" style={{ color: C.specialty }}>{n.specialty}</span>
                      <span className="mono text-[9px]" style={{ color: "#4A5775" }}>
                        {n.ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <p className="text-[11px] leading-snug" style={{ color: "#9AA8C2" }}>{n.text}</p>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </section>

        {/* RIGHT: GRAPH + FINDINGS */}
        <section className="space-y-4">
          <Panel title="Patient knowledge graph" icon={Network} accent="#5BA8FF"
            right={
              <div className="flex gap-1">
                {["synth", "cognee"].map((v) => (
                  <button key={v} onClick={() => setGraphView(v)}
                    className="mono text-[10px] px-2 py-1 rounded transition-all"
                    style={ graphView === v
                      ? { background: "#11233E", border: "1px solid #2C5C8E", color: "#CFE3FF" }
                      : { background: "#0A111D", border: "1px solid #16223A", color: "#6B7A99" } }>
                    {v === "synth" ? "SYNTHESIZED" : "COGNEE NATIVE"}
                  </button>
                ))}
              </div>
            }>
            {graphView === "synth" ? (
              <GraphCanvas graph={graph} onSelect={setSelected} selected={selected} />
            ) : (
              <iframe title="cognee-graph" src={`${BACKEND_URL}/graph`}
                className="w-full rounded-lg" style={{ height: 440, border: "1px solid #16223A", background: "#fff" }} />
            )}
            <Legend />
          </Panel>

          {/* RECALL */}
          <Panel title="Cross-consultation synthesis" icon={ShieldAlert} accent="#FF6B9D">
            <div className="flex gap-2 mb-3">
              <input value={query} onChange={(e) => setQuery(e.target.value)}
                className="flex-1 rounded-lg px-3 py-2 text-sm outline-none"
                style={{ background: "#0A111D", border: "1px solid #16223A", color: "#E8EEF7" }} />
              <button onClick={runAnalyze} disabled={busy || notes.length === 0}
                className="px-4 py-2 rounded-lg font-semibold text-sm transition-all disabled:opacity-40 whitespace-nowrap"
                style={{ background: "#11233E", border: "1px solid #2C5C8E", color: "#CFE3FF" }}>
                {busy ? "Synthesizing…" : "Recall · run()"}
              </button>
            </div>

            {cogneeText && (
              <div className="rounded-lg p-3 mb-3 flex gap-2"
                style={{ background: "#08120F", border: "1px solid #0E3A37", color: "#9FE6DC" }}>
                <Brain className="h-4 w-4 shrink-0 mt-0.5" style={{ color: C.patient }} />
                <div className="flex-1 min-w-0"><Markdown>{cogneeText}</Markdown></div>
              </div>
            )}

            {findings === null ? (
              <Empty text="Run recall to traverse memory across every specialty and surface hidden risks." />
            ) : findings.length === 0 ? (
              <Empty text="No cross-consultation risks detected for the current record." ok />
            ) : (
              <div className="space-y-2.5">
                {findings.map((f, i) => (
                  <Finding key={i} f={f}
                    reviewedJudgment={reviewed[`${activeId}::${f.title}`]}
                    onFeedback={(judgment) => submitFeedback(f.title, judgment)}
                    explainState={explainByTitle[f.title]}
                    onExplain={() => runExplain(f)}
                    ledger={ledgerByTitle[f.title]} />
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Simulation mode · what if…" icon={FlaskConical} accent="#B78FFF">
            <p className="text-[12px] mb-3 leading-relaxed" style={{ color: "#8A99B4" }}>
              Check a drug BEFORE prescribing it. Nothing here is written to the patient's record.
            </p>
            <div className="flex gap-2 mb-3">
              <input value={simDrug} onChange={(e) => setSimDrug(e.target.value)}
                placeholder="e.g. Sildenafil"
                className="flex-1 rounded-lg px-3 py-2 text-sm outline-none"
                style={{ background: "#0A111D", border: "1px solid #16223A", color: "#E8EEF7" }} />
              <button onClick={runSimulate} disabled={simBusy || !simDrug.trim() || notes.length === 0}
                className="px-4 py-2 rounded-lg font-semibold text-sm transition-all disabled:opacity-40 whitespace-nowrap"
                style={{ background: "#2E1E3E", border: "1px solid #5C3C8E", color: "#E3CFFF" }}>
                {simBusy ? "Simulating…" : "Simulate"}
              </button>
            </div>
            {simResult && (
              <div className="rounded-lg p-3"
                style={{ background: "#160F26", border: "1px solid #3C2C5E", color: "#E3CFFF" }}>
                <div className="mono text-[9px] uppercase tracking-wider mb-2 flex items-center gap-1.5" style={{ color: "#B78FFF" }}>
                  <FlaskConical className="h-3.5 w-3.5" /> Hypothetical · not committed to record
                </div>
                <Markdown>{simResult}</Markdown>
              </div>
            )}
          </Panel>

          <Panel title="Provisional findings · auto-expiring memory" icon={Trash2} accent="#FF8A4C">
            <p className="text-[12px] mb-3 leading-relaxed" style={{ color: "#8A99B4" }}>
              A speculative "rule-out" note gets a real TTL. Once expired, pruning surgically
              forgets ONLY that item via Cognee's <span className="mono">forget(data_id=..., memory_only=True)</span>,
              not a full dataset wipe.
            </p>
            <div className="flex gap-2 mb-2">
              <textarea value={provisionalText} onChange={(e) => setProvisionalText(e.target.value)} rows={2}
                placeholder={`e.g. "Rule-out: early pericarditis, pending follow-up echo."`}
                className="flex-1 rounded-lg p-2.5 text-[12px] resize-none outline-none"
                style={{ background: "#0A111D", border: "1px solid #16223A", color: "#E8EEF7" }} />
              <div className="flex flex-col gap-1.5 shrink-0" style={{ width: 90 }}>
                <input type="number" min={5} value={provisionalTTL}
                  onChange={(e) => setProvisionalTTL(Math.max(5, Number(e.target.value) || 30))}
                  className="w-full rounded-lg px-2 py-1.5 text-[12px] outline-none text-center"
                  style={{ background: "#0A111D", border: "1px solid #16223A", color: "#E8EEF7" }} />
                <span className="mono text-[9px] text-center" style={{ color: "#5C6B85" }}>TTL sec</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <button onClick={commitProvisional} disabled={provisionalBusy || !provisionalText.trim()}
                className="py-2 rounded-lg text-[12px] font-medium transition-all disabled:opacity-40"
                style={{ background: "#0A111D", border: "1px dashed #2C5C8E", color: "#7FB2F0" }}>
                Add provisional note
              </button>
              <button onClick={runPrune} disabled={provisionalBusy}
                className="py-2 rounded-lg text-[12px] font-medium transition-all disabled:opacity-40"
                style={{ background: "#1A0E14", border: "1px solid #5C1C2C", color: "#FF8FA3" }}>
                Run prune sweep now
              </button>
            </div>
            <button onClick={refreshProvisional}
              className="w-full mb-2 py-1.5 rounded-lg text-[10.5px] transition-all"
              style={{ background: "#0A111D", border: "1px solid #16223A", color: "#6B7A99" }}>
              ↻ Check status
            </button>
            {provisionalList.filter((p) => p.patient_id === activeId).length > 0 && (
              <div className="space-y-1.5">
                {provisionalList.filter((p) => p.patient_id === activeId).map((p) => (
                  <div key={p.note_key} className="rounded-lg px-2.5 py-1.5 text-[10.5px] flex items-center justify-between gap-2"
                    style={{ background: "#0A111D", border: "1px solid #16223A" }}>
                    <span className="truncate" style={{ color: "#9AA8C2" }}>{p.text}</span>
                    <span className="mono shrink-0 px-1.5 py-0.5 rounded" style={{
                      background: p.expired ? "#1A0E14" : "#08211D",
                      color: p.expired ? "#FF8FA3" : "#7FEFE0" }}>
                      {p.expired ? "EXPIRED" : "active"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Time capsule · point-in-time query" icon={History} accent="#6BCBEF">
            <p className="text-[12px] mb-3 leading-relaxed" style={{ color: "#8A99B4" }}>
              Ask what was true as of a PAST date, not just "current status": genuine historical
              reconstruction using temporal reasoning over notes on or before that date only.
            </p>
            <div className="flex gap-2 mb-3">
              <input type="date" value={snapshotDate} onChange={(e) => setSnapshotDate(e.target.value)}
                className="flex-1 rounded-lg px-3 py-2 text-sm outline-none"
                style={{ background: "#0A111D", border: "1px solid #16223A", color: "#E8EEF7" }} />
              <button onClick={runSnapshot} disabled={snapshotBusy || !snapshotDate || notes.length === 0}
                className="px-4 py-2 rounded-lg font-semibold text-sm transition-all disabled:opacity-40 whitespace-nowrap"
                style={{ background: "#11233E", border: "1px solid #2C5C8E", color: "#CFE3FF" }}>
                {snapshotBusy ? "Reconstructing…" : "Open time capsule"}
              </button>
            </div>
            {snapshotResult && (
              <div className="rounded-lg p-3"
                style={{ background: "#0A1522", border: "1px solid #16223A", color: "#9AA8C2" }}>
                <div className="mono text-[9px] uppercase tracking-wider mb-2" style={{ color: "#6B9BFF" }}>
                  As of {snapshotDate}
                </div>
                <Markdown>{snapshotResult}</Markdown>
              </div>
            )}
          </Panel>

          <Panel title="Population insight · privacy-safe aggregation" icon={Users} accent="#4ADE80">
            <p className="text-[12px] mb-3 leading-relaxed" style={{ color: "#8A99B4" }}>
              For a pharmacy or safety team gauging population-wide exposure after an alert, not
              for reviewing one patient's chart. Each dataset is checked in isolation, only
              aggregate counts return.
            </p>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <input value={popA} onChange={(e) => setPopA(e.target.value)} placeholder="e.g. Amiodarone"
                className="rounded-lg px-3 py-2 text-sm outline-none"
                style={{ background: "#0A111D", border: "1px solid #16223A", color: "#E8EEF7" }} />
              <input value={popB} onChange={(e) => setPopB(e.target.value)} placeholder="e.g. Simvastatin"
                className="rounded-lg px-3 py-2 text-sm outline-none"
                style={{ background: "#0A111D", border: "1px solid #16223A", color: "#E8EEF7" }} />
            </div>
            <button onClick={runPopulationInsight} disabled={popBusy || !popA.trim() || !popB.trim()}
              className="w-full py-2 rounded-lg font-semibold text-sm transition-all disabled:opacity-40"
              style={{ background: "#11233E", border: "1px solid #2C5C8E", color: "#CFE3FF" }}>
              {popBusy ? "Checking each isolated dataset…" : "Check across patient population"}
            </button>
            {popResult && (
              <div className="rounded-lg p-3 mt-3 text-[12px] leading-relaxed" style={{ background: "#0A1522", border: "1px solid #16223A" }}>
                <p style={{ color: "#B7C4DC" }}>
                  {popResult.note || `${popResult.count} of ${popResult.checked} known patient(s) currently have both active.`}
                </p>
                {popResult.matching_patients?.length > 0 && (
                  <p className="mono text-[10px] mt-1.5" style={{ color: "#7FB2F0" }}>
                    Matching: {popResult.matching_patients.join(", ")}
                  </p>
                )}
              </div>
            )}
          </Panel>

          <Panel title="Signal discovery · fleet-wide pattern mining" icon={Radar} accent="#F472B6">
            <p className="text-[12px] mb-3 leading-relaxed" style={{ color: "#8A99B4" }}>
              Real drug-safety issues are usually caught this way, a pattern across many patients,
              noticed before it's written down anywhere. This flags undocumented pairs for a
              pharmacy review, not a diagnosis, using the same PRR method FDA FAERS uses.
            </p>
            <button onClick={runDiscoverSignals} disabled={discoverBusy}
              className="w-full py-2 rounded-lg font-semibold text-sm transition-all disabled:opacity-40"
              style={{ background: "#3A1530", border: "1px solid #6B2C56", color: "#FFCFE8" }}>
              {discoverBusy ? "Scanning fleet memory…" : "Scan population for undocumented signals"}
            </button>
            {discoverResult && (
              <div className="rounded-lg p-3 mt-3 text-[12px] leading-relaxed" style={{ background: "#0A1522", border: "1px solid #16223A" }}>
                {discoverResult.note ? (
                  <p style={{ color: "#B7C4DC" }}>{discoverResult.note}</p>
                ) : discoverResult.candidate_signals?.length ? (
                  <div className="space-y-2">
                    {discoverResult.candidate_signals.map((s, i) => (
                      <div key={i} className="rounded-lg p-2.5" style={{ background: "#1A0E20", border: "1px solid #6B2C56" }}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="disp font-semibold text-[13px]" style={{ color: "#FFCFE8" }}>
                            {titleCase(s.drug_a)} + {titleCase(s.drug_b)}
                          </span>
                          <span className="mono text-[9px] px-1.5 py-0.5 rounded" style={{ background: "#3A1530", color: "#FFCFE8" }}>
                            PRR {s.prr}×
                          </span>
                        </div>
                        <p className="text-[11px]" style={{ color: "#B7C4DC" }}>
                          Not in Synapse's known-interaction list. {titleCase(s.symptom)} appears in{" "}
                          {s.a} of {s.a + s.b} patients on both drugs, vs {s.c} of {s.c + s.d} patients not on both.
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ color: "#B7C4DC" }}>
                    Scanned {discoverResult.patients_scanned} patient(s) · no undocumented
                    disproportionate signal found yet. More patients and shared drug pairs
                    give this more to work with.
                  </p>
                )}
              </div>
            )}
          </Panel>

          <p className="mono text-[10px] text-center pb-4" style={{ color: "#3A4661" }}>
            PROTOTYPE FOR HACKATHON DEMONSTRATION · NOT A MEDICAL DEVICE · NOT FOR CLINICAL USE
          </p>
        </section>
      </main>

      {/* node detail drawer */}
      {selected && <NodeDrawer node={selected} notes={notes} onClose={() => setSelected(null)} />}

      {/* toast */}
      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-30 pop">
          <div className="px-4 py-2.5 rounded-xl text-sm flex items-center gap-2 shadow-2xl"
            style={{ background: "#0E1626", border: "1px solid #1C5C56", color: "#9FF3E8" }}>
            <Activity className="h-4 w-4" /> {toast}
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── GRAPH CANVAS ──────────────────────── */
function GraphCanvas({ graph, onSelect, selected }) {
  const W = 720, H = 440;
  const svgRef = useRef(null);
  const simRef = useRef(null);
  const nodesRef = useRef([]);
  const linksRef = useRef([]);
  const [, force] = useState(0);
  const dragId = useRef(null);

  useEffect(() => {
    // preserve positions across rebuilds
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const nodes = graph.nodes.map((n) => {
      const p = prev.get(n.id);
      return { ...n, x: p?.x ?? W / 2 + (Math.random() - 0.5) * 120,
        y: p?.y ?? H / 2 + (Math.random() - 0.5) * 120, fx: p?.fx, fy: p?.fy };
    });
    const idset = new Set(nodes.map((n) => n.id));
    const links = graph.links
      .filter((l) => idset.has(typeof l.source === "object" ? l.source.id : l.source) &&
                     idset.has(typeof l.target === "object" ? l.target.id : l.target))
      .map((l) => ({ ...l }));
    nodesRef.current = nodes; linksRef.current = links;

    const sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id((d) => d.id).distance((l) => l.kind === "risk" ? 110 : 78).strength(0.5))
      .force("charge", d3.forceManyBody().strength(-340))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .force("collide", d3.forceCollide().radius((d) => (d.type === "patient" ? 38 : 26)))
      .alpha(0.9).alphaDecay(0.045)
      .on("tick", () => force((v) => v + 1));
    simRef.current = sim;
    return () => sim.stop();
  }, [graph]);

  const toSvg = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const onDown = (e, n) => {
    dragId.current = n.id; onSelect(n);
    simRef.current.alphaTarget(0.2).restart();
  };
  const onMove = (e) => {
    if (!dragId.current) return;
    const p = toSvg(e); const n = nodesRef.current.find((x) => x.id === dragId.current);
    if (n) { n.fx = p.x; n.fy = p.y; }
  };
  const onUp = () => {
    const n = nodesRef.current.find((x) => x.id === dragId.current);
    if (n) { n.fx = null; n.fy = null; }
    dragId.current = null; simRef.current?.alphaTarget(0);
  };

  const R = (n) => (n.type === "patient" ? 22 : n.type === "specialty" ? 15 : 12);
  const nodes = nodesRef.current, links = linksRef.current;

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg select-none"
      style={{ height: 440, background: "radial-gradient(circle at 50% 40%, #0D1726, #090E17)", border: "1px solid #16223A" }}
      onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
      {links.map((l, i) => {
        const s = l.source, t = l.target; if (!s.x || !t.x) return null;
        const risk = l.kind === "risk";
        const resolved = l.kind === "resolved";
        const col = risk ? (SEV[l.severity]?.color || "#FF5C72")
                  : resolved ? "#2E8B7F" : "#1F3252";
        return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y}
          stroke={col} strokeWidth={risk ? 2.4 : resolved ? 2 : 1.2}
          strokeDasharray={risk || resolved ? "5 4" : "0"}
          style={risk ? { animation: "pulseRed 1.6s ease-in-out infinite" } : undefined} />;
      })}
      {nodes.map((n) => {
        const col = C[n.type] || "#6B7A99";
        const sel = selected?.id === n.id;
        return (
          <g key={n.id} transform={`translate(${n.x},${n.y})`} style={{ cursor: "grab" }}
            onPointerDown={(e) => onDown(e, n)}>
            <circle r={R(n) + (sel ? 5 : 0)} fill={`${col}1F`} stroke={col}
              strokeWidth={sel ? 2.5 : 1.6} />
            {n.type === "patient" && <circle r={R(n) - 7} fill={col} opacity={0.9} />}
            <text textAnchor="middle" y={R(n) + 13} fontSize="10.5"
              fill={n.type === "patient" ? "#E8EEF7" : "#9AA8C2"}
              fontFamily="Inter, sans-serif" fontWeight={n.type === "patient" ? 600 : 400}>
              {n.label.length > 16 ? n.label.slice(0, 15) + "…" : n.label}
            </text>
          </g>
        );
      })}
      {nodes.length <= 1 && (
        <text x={W / 2} y={H / 2 + 60} textAnchor="middle" fill="#3A4661" fontSize="12"
          fontFamily="Inter, sans-serif">Commit a note to grow the memory graph</text>
      )}
    </svg>
  );
}

/* ─────────────────── AI-output markdown renderer ───────────────── */
function Markdown({ children }) {
  if (!children) return null;
  const drop = ({ node, ...rest }) => rest;
  return (
    <div className="text-[12px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <div className="disp font-semibold text-[13px] mt-2 mb-1 first:mt-0" style={{ color: "#CFE3FF" }} {...drop(p)} />,
          h2: (p) => <div className="disp font-semibold text-[12.5px] mt-2 mb-1 first:mt-0" style={{ color: "#CFE3FF" }} {...drop(p)} />,
          h3: (p) => <div className="mono text-[10px] uppercase tracking-wider mt-2 mb-1 first:mt-0" style={{ color: "#6B9BFF" }} {...drop(p)} />,
          p: (p) => <p className="mb-1.5 last:mb-0" {...drop(p)} />,
          strong: (p) => <strong style={{ color: "#E8EEF7" }} {...drop(p)} />,
          em: (p) => <em style={{ color: "#9AA8C2" }} {...drop(p)} />,
          ul: (p) => <ul className="list-disc pl-4 mb-1.5 space-y-0.5" {...drop(p)} />,
          ol: (p) => <ol className="list-decimal pl-4 mb-1.5 space-y-0.5" {...drop(p)} />,
          li: (p) => <li {...drop(p)} />,
          hr: (p) => <div className="my-2" style={{ borderTop: "1px solid #16223A" }} {...drop(p)} />,
          code: (p) => <code className="mono px-1 py-0.5 rounded" style={{ background: "#11233E", color: "#9FE6DC", fontSize: "10.5px" }} {...drop(p)} />,
          table: (p) => (
            <div className="overflow-x-auto mb-2 rounded-lg" style={{ border: "1px solid #16223A" }}>
              <table className="w-full text-left" style={{ borderCollapse: "collapse" }} {...drop(p)} />
            </div>
          ),
          thead: (p) => <thead style={{ background: "#11233E" }} {...drop(p)} />,
          th: (p) => <th className="px-2 py-1.5 text-[10px] uppercase tracking-wide font-semibold whitespace-nowrap" style={{ color: "#7FB2F0", borderBottom: "1px solid #16223A" }} {...drop(p)} />,
          td: (p) => <td className="px-2 py-1.5 align-top" style={{ borderTop: "1px solid #16223A" }} {...drop(p)} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/* ─────────────────── small presentational bits ───────────────── */
function Panel({ title, icon: Icon, right, children, accent = "#36D6C3" }) {
  return (
    <div className="rounded-2xl p-4" style={{
      background: `linear-gradient(165deg, ${accent}17 0%, #0C1320 45%)`,
      border: "1px solid #16223A", borderLeft: `3px solid ${accent}`,
    }}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="disp text-[13px] font-semibold tracking-wide flex items-center gap-2"
          style={{ color: "#C3D0E6" }}>
          <Icon className="h-4 w-4" style={{ color: accent }} /> {title}
        </h2>
        {right}
      </div>
      {children}
    </div>
  );
}

function Legend() {
  const items = [
    ["Patient", C.patient], ["Specialty", C.specialty], ["Drug", C.drug],
    ["Condition", C.condition], ["Symptom", C.symptom],
    ["Active risk", "#FF5C72"], ["Resolved", "#2E8B7F"],
  ];
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 px-1">
      {items.map(([l, c]) => (
        <span key={l} className="flex items-center gap-1.5 text-[10.5px]" style={{ color: "#7C8BA8" }}>
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: `${c}33`, border: `1.5px solid ${c}` }} /> {l}
        </span>
      ))}
    </div>
  );
}

function Finding({ f, reviewedJudgment, onFeedback, explainState, onExplain, ledger }) {
  const sev = f.resolved ? SEV.resolved : SEV[f.severity]; const Icon = sev.icon;
  // Confidence derived from /explain's real graph path length: a direct 1-2
  // hop link is a stronger graph-grounded claim than a finding Cognee
  // reported that Explain hasn't traced onto the graph yet.
  let confidence = null;
  if (explainState && !explainState.busy) {
    confidence = explainState.path
      ? (explainState.path.length <= 3 ? "High · direct graph link" : "Medium · multi-hop graph link")
      : "Not yet graph-traced · run Explain";
  }
  // Cognee's improve()-driven feedback weighting isn't available on this
  // tenant, so cross-patient consensus is computed client-side from the
  // fleet ledger. A vote across patients changes the finding's label,
  // tone, and framing directly, not just a passive counter.
  let consensus = null;
  if (ledger) {
    const c = ledger.confirm || 0, d = ledger.dismiss || 0, total = c + d;
    if (total >= 2) {
      if (c > d) consensus = { tone: "confirm",
        label: `Clinician consensus CONFIRMS this alert (${c} confirmed vs ${d} dismissed across patients)` };
      else if (d > c) consensus = { tone: "dismiss",
        label: `Clinician consensus leans DISMISS, possible false positive (${d} dismissed vs ${c} confirmed across patients)` };
      else consensus = { tone: "mixed",
        label: `Clinician feedback is mixed across patients (${c} confirmed, ${d} dismissed), use clinical judgment` };
    }
  }
  const consensusStyle = {
    confirm: { background: "#08211D", border: "1px solid #1C5C56", color: "#7FEFE0" },
    dismiss: { background: "#1A0E14", border: "1px solid #5C1C2C", color: "#FF8FA3" },
    mixed: { background: "#241A08", border: "1px solid #5C4C1C", color: "#FFD37F" },
  };
  return (
    <div className="rounded-xl p-3.5 pop" style={{ background: "#0A111D", border: `1px solid ${sev.color}40` }}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4" style={{ color: sev.color }} />
          <span className="disp font-semibold text-[14px]">{f.title}</span>
        </div>
        <span className="mono text-[9px] px-2 py-0.5 rounded uppercase tracking-wider"
          style={{ background: `${sev.color}1A`, color: sev.color, border: `1px solid ${sev.color}40` }}>
          {sev.label}
        </span>
      </div>
      {confidence && (
        <div className="text-[12.5px] font-medium mb-2.5" style={{ color: "#6B9BFF" }}>◆ Confidence: {confidence}</div>
      )}
      {consensus && (
        <div className="rounded-lg px-2.5 py-1.5 mb-2 text-[11px] flex items-center gap-1.5" style={consensusStyle[consensus.tone]}>
          <Users className="h-3.5 w-3.5 shrink-0" />
          {consensus.label}
        </div>
      )}
      {f.resolved && (
        <div className="rounded-lg px-2.5 py-1.5 mb-2 text-[11px] flex items-center gap-1.5"
          style={{ background: "#08211D", border: "1px solid #1C5C56", color: "#7FEFE0" }}>
          <Clock className="h-3.5 w-3.5" />
          Resolved by temporal reasoning. A drug was discontinued, so this risk is no longer active.
        </div>
      )}
      <Row label="Mechanism" v={f.mechanism} />
      <Row label={f.resolved ? "Was" : "Risk"} v={f.effect} />
      {!f.resolved && <Row label="Action" v={f.action} accent="#9FF3E8" />}
      <div className="flex flex-wrap items-center gap-1.5 mt-2.5 pt-2.5" style={{ borderTop: "1px solid #16223A" }}>
        {f.crossSpecialty && (
          <span className="mono text-[9px] px-1.5 py-0.5 rounded" style={{ background: "#11233E", color: "#7FB2F0" }}>
            CROSS-SPECIALTY
          </span>
        )}
        {f.sources?.map((s) => (
          <span key={s} className="text-[10px] flex items-center gap-1" style={{ color: "#6B7A99" }}>
            <ChevronRight className="h-3 w-3" />{s}
          </span>
        ))}
        {f.corro?.length > 0 && (
          <span className="text-[10px] ml-auto flex items-center gap-1" style={{ color: "#FFB454" }}>
            <AlertTriangle className="h-3 w-3" />
            Corroborating symptom on record: {f.corro[0]}
          </span>
        )}
        {ledger && (ledger.confirm > 0 || ledger.dismiss > 0) && (
          <span className="mono text-[9px] px-1.5 py-0.5 rounded flex items-center gap-1" style={{ background: "#1A1230", color: "#C792EA" }}>
            Fleet: confirmed {ledger.confirm || 0}× · dismissed {ledger.dismiss || 0}× across patients
          </span>
        )}
        {ledger?.prr?.signal && (
          <span className="mono text-[9px] px-1.5 py-0.5 rounded flex items-center gap-1" style={{ background: "#241A08", color: "#FFD37F" }}
            title="Proportional Reporting Ratio, adapted from spontaneous-report pharmacovigilance signal detection (Evans, Waller & Davis, 2001)">
            PRR {ledger.prr.prr}× · disproportionate signal ({ledger.prr.reports} reports)
          </span>
        )}
      </div>
      {f.temporal && (
        <div className="text-[10px] mt-1.5 flex items-center gap-1" style={{ color: f.temporal.verdict === "consistent" ? "#7FEFE0" : "#8A99B4" }}
          title="Sequence Symmetry Analysis (Hallas, 1996)">
          <Clock className="h-3 w-3" />
          {f.temporal.verdict === "consistent" &&
            `Sequence check: symptom followed drug start by ${f.temporal.days} day${f.temporal.days === 1 ? "" : "s"}, temporally consistent`}
          {f.temporal.verdict === "precedes" &&
            `Sequence check: symptom predates this drug by ${Math.abs(f.temporal.days)} day${Math.abs(f.temporal.days) === 1 ? "" : "s"}, weaker evidence of causation`}
          {f.temporal.verdict === "distant" &&
            `Sequence check: symptom trails drug start by ${f.temporal.days} days, too distant for strong temporal evidence`}
        </div>
      )}
      <div className="flex items-center gap-1.5 mt-2.5 pt-2.5" style={{ borderTop: "1px solid #16223A" }}>
        {reviewedJudgment ? (
          <span className="mono text-[9px] px-2 py-1 rounded flex items-center gap-1.5"
            style={{ background: reviewedJudgment === "confirm" ? "#08211D" : "#1A0E14",
              color: reviewedJudgment === "confirm" ? "#7FEFE0" : "#FF8FA3",
              border: `1px solid ${reviewedJudgment === "confirm" ? "#1C5C56" : "#5C1C2C"}` }}>
            {reviewedJudgment === "confirm" ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            Clinician {reviewedJudgment}ed · reviewed
          </span>
        ) : (
          <>
            <button onClick={() => onFeedback("confirm")}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-all"
              style={{ background: "#08211D", border: "1px solid #1C5C56", color: "#7FEFE0" }}>
              <Check className="h-3 w-3" /> Confirm
            </button>
            <button onClick={() => onFeedback("dismiss")}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-all"
              style={{ background: "#1A0E14", border: "1px solid #5C1C2C", color: "#FF8FA3" }}>
              <X className="h-3 w-3" /> Dismiss
            </button>
          </>
        )}
        <button onClick={onExplain} disabled={explainState?.busy}
          className="ml-auto flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-all disabled:opacity-40"
          style={{ background: "#11233E", border: "1px solid #2C5C8E", color: "#CFE3FF" }}>
          <Network className="h-3 w-3" /> {explainState?.busy ? "Tracing…" : "Explain"}
        </button>
      </div>
      {explainState && !explainState.busy && (
        <div className="rounded-lg p-2.5 mt-2 text-[10.5px]"
          style={{ background: "#0A1522", border: "1px solid #16223A", color: "#9AA8C2" }}>
          <div className="mono text-[9px] uppercase tracking-wider mb-1.5" style={{ color: "#6B9BFF" }}>
            Deterministic graph traceability
          </div>
          {explainState.path ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {explainState.path.map((hop, i) => (
                <React.Fragment key={i}>
                  {i > 0 && (
                    <span className="mono text-[9px] flex items-center gap-1" style={{ color: "#5C6B85" }}>
                      <span>→</span>
                      <span style={{ color: "#7FB2F0" }}>({hop.relation})</span>
                      <span>→</span>
                    </span>
                  )}
                  <span className="px-1.5 py-0.5 rounded" style={{ background: "#11233E", color: "#CFE3FF" }}>{hop.node}</span>
                </React.Fragment>
              ))}
            </div>
          ) : (
            <p>{explainState.note}</p>
          )}
        </div>
      )}
    </div>
  );
}
function Row({ label, v, accent }) {
  return (
    <div className="flex gap-2 text-[12px] leading-snug mb-1">
      <span className="mono text-[9px] uppercase tracking-wider shrink-0 mt-0.5 w-[68px]" style={{ color: "#5C6B85" }}>{label}</span>
      <span style={{ color: accent || "#B7C4DC" }}>{v}</span>
    </div>
  );
}

function Empty({ text, ok }) {
  return (
    <div className="rounded-lg py-7 px-4 text-center" style={{ background: "#0A111D", border: "1px dashed #1E2A40" }}>
      {ok
        ? <ShieldAlert className="h-6 w-6 mx-auto mb-2" style={{ color: "#36D6C3" }} />
        : <Network className="h-6 w-6 mx-auto mb-2" style={{ color: "#2C3A57" }} />}
      <p className="text-[12px]" style={{ color: "#8A99B4" }}>{text}</p>
    </div>
  );
}

function NodeDrawer({ node, notes, onClose }) {
  const mentions = notes.filter((n) => {
    const all = [...n.entities.drugs, ...n.entities.conditions, ...n.entities.symptoms];
    return all.some((k) => node.id.endsWith(k));
  });
  return (
    <div className="fixed inset-y-0 right-0 z-30 p-5 pop overflow-y-auto scrolln"
      style={{ width: 320, background: "#0C1320", borderLeft: "1px solid #1C5C56" }}>
      <div className="flex items-center justify-between mb-4">
        <span className="mono text-[10px] uppercase tracking-wider" style={{ color: C[node.type] || "#6B7A99" }}>
          {node.type}
        </span>
        <button onClick={onClose}><X className="h-4 w-4" style={{ color: "#6B7A99" }} /></button>
      </div>
      <h3 className="disp text-xl font-bold mb-1">{node.label}</h3>
      <p className="text-[12px] mb-4" style={{ color: "#8A99B4" }}>
        {mentions.length} session{mentions.length === 1 ? "" : "s"} reference this node.
      </p>
      <div className="space-y-2">
        {mentions.map((m) => (
          <div key={m.id} className="rounded-lg p-2.5" style={{ background: "#0A111D", border: "1px solid #16223A" }}>
            <div className="text-[11px] font-semibold mb-1" style={{ color: "#8A99B4" }}>{m.specialty}</div>
            <p className="text-[11px] leading-snug" style={{ color: "#9AA8C2" }}>{m.text}</p>
          </div>
        ))}
        {mentions.length === 0 && (
          <p className="text-[12px]" style={{ color: "#5C6B85" }}>This node anchors the patient's record.</p>
        )}
      </div>
    </div>
  );
}
