"""
normalize.py: clinical terminology normalization middleware
============================================================
Why this exists: doctors write the same concept many ways ("high BP",
"hypertension", "elevated blood pressure"; "Zocor" vs "simvastatin"). If those
reach the knowledge graph as-is, they become SEPARATE nodes and the graph can no
longer connect facts that are really about the same thing. This module collapses
each variant to ONE canonical concept *before* it reaches cognee.remember().

  Drugs      -> RxNorm RxCUI (a national identifier) via the free NIH RxNav API.
                No license or key needed for the API.
  Conditions -> a curated canonical map. (Full SNOMED-CT needs a UMLS license;
                this license-free map is the honest stand-in and easy to extend.)

Requires:  pip install requests
"""
import re
import requests

RXNAV = "https://rxnav.nlm.nih.gov/REST"
_cache = {}  # term -> (rxcui, canonical_name), so we don't hit the API twice

# Drug terms we watch for (brands included). Extend freely.
DRUG_TERMS = [
    "amiodarone", "simvastatin", "atorvastatin", "zocor", "rosuvastatin", "crestor",
    "pravastatin", "warfarin", "coumadin", "apixaban", "eliquis", "rivaroxaban", "xarelto",
    "verapamil", "diltiazem", "amlodipine", "norvasc", "metoprolol", "propranolol",
    "lisinopril", "enalapril", "losartan", "clonidine", "hydrochlorothiazide",
    "furosemide", "lasix", "spironolactone", "digoxin",
    "metformin", "glucophage", "glipizide", "insulin", "lantus",
    "levothyroxine", "synthroid",
    "clopidogrel", "plavix", "omeprazole", "prilosec", "pantoprazole", "protonix",
    "sildenafil", "viagra", "nitroglycerin", "aspirin", "ibuprofen", "advil", "motrin",
    "naproxen", "aleve", "celecoxib", "acetaminophen", "tylenol",
    "sertraline", "zoloft", "fluoxetine", "prozac", "citalopram", "celexa",
    "escitalopram", "lexapro", "venlafaxine", "effexor",
    "alprazolam", "xanax", "lorazepam", "ativan", "quetiapine", "gabapentin",
    "tramadol", "oxycodone", "hydrocodone", "morphine",
    "amoxicillin", "azithromycin", "ciprofloxacin", "doxycycline",
    "albuterol", "montelukast", "prednisone",
]

# Brand -> ingredient, applied BEFORE lookup so e.g. "Zocor" and "simvastatin" unify.
BRAND_TO_INGREDIENT = {
    "zocor": "simvastatin", "coumadin": "warfarin", "plavix": "clopidogrel",
    "viagra": "sildenafil", "advil": "ibuprofen", "motrin": "ibuprofen",
    "zoloft": "sertraline", "crestor": "rosuvastatin", "eliquis": "apixaban",
    "xarelto": "rivaroxaban", "norvasc": "amlodipine", "lasix": "furosemide",
    "synthroid": "levothyroxine", "glucophage": "metformin", "lantus": "insulin",
    "xanax": "alprazolam", "ativan": "lorazepam", "prozac": "fluoxetine",
    "lexapro": "escitalopram", "celexa": "citalopram", "effexor": "venlafaxine",
    "tylenol": "acetaminophen", "aleve": "naproxen", "prilosec": "omeprazole",
    "protonix": "pantoprazole",
}

# Condition / symptom synonyms -> canonical label (license-free stand-in for SNOMED)
CONDITION_CANON = {
    "high blood pressure": "Hypertension", "elevated bp": "Hypertension",
    "raised bp": "Hypertension", "high bp": "Hypertension", "htn": "Hypertension",
    "hypertension": "Hypertension",
    "high cholesterol": "Hyperlipidemia", "elevated cholesterol": "Hyperlipidemia",
    "hyperlipidemia": "Hyperlipidemia", "dyslipidemia": "Hyperlipidemia",
    "afib": "Atrial Fibrillation", "a-fib": "Atrial Fibrillation",
    "atrial fibrillation": "Atrial Fibrillation",
    "irregular heartbeat": "Arrhythmia", "arrhythmia": "Arrhythmia",
    "diabetes": "Diabetes Mellitus", "high sugar": "Diabetes Mellitus",
    "asthma": "Asthma", "reflux": "GERD", "gerd": "GERD", "heartburn": "GERD",
    "muscle fatigue": "Myalgia", "muscle pain": "Myalgia", "muscle aches": "Myalgia",
    "weakness": "Muscle weakness",
    "copd": "COPD", "chronic obstructive pulmonary disease": "COPD",
    "underactive thyroid": "Hypothyroidism", "hypothyroidism": "Hypothyroidism",
    "anxiety": "Anxiety", "insomnia": "Insomnia", "trouble sleeping": "Insomnia",
    "migraine": "Migraine", "migraines": "Migraine",
    "osteoporosis": "Osteoporosis", "obesity": "Obesity",
    "chronic kidney disease": "Chronic Kidney Disease", "ckd": "Chronic Kidney Disease",
}


def _rxnorm_lookup(ingredient):
    """Return (rxcui, canonical_name) for a drug ingredient, or (None, title-cased)."""
    key = ingredient.lower()
    if key in _cache:
        return _cache[key]
    rxcui, canonical = None, ingredient.title()
    try:
        # 1) normalized string search: expands abbreviations, ignores salt forms
        r = requests.get(f"{RXNAV}/rxcui.json",
                         params={"name": ingredient, "search": 2}, timeout=6)
        ids = r.json().get("idGroup", {}).get("rxnormId")
        if ids:
            rxcui = ids[0]
        else:
            # 2) fuzzy fallback for typos / partial names
            r = requests.get(f"{RXNAV}/approximateTerm.json",
                             params={"term": ingredient, "maxEntries": 1}, timeout=6)
            cands = r.json().get("approximateGroup", {}).get("candidate") or []
            if cands:
                rxcui = cands[0].get("rxcui")
        # 3) resolve the official RxNorm name for that identifier
        if rxcui:
            p = requests.get(f"{RXNAV}/rxcui/{rxcui}/properties.json", timeout=6)
            name = p.json().get("properties", {}).get("name")
            if name:
                canonical = name
    except Exception:
        pass  # network hiccup: fall back to the title-cased term, never crash
    _cache[key] = (rxcui, canonical)
    return _cache[key]


def normalize_note(text):
    """
    Detect clinical terms in a note and map them to canonical concepts.
    Returns (annotated_text, mappings):
      annotated_text = original note + an explicit 'Normalized concepts' block
                       that Cognee stores, so canonical nodes are unambiguous.
      mappings       = list of {raw, type, canonical, rxcui} for the UI to show.
    """
    low = text.lower()
    mappings, seen = [], set()

    # drugs -> ingredient -> RxNorm
    for term in DRUG_TERMS:
        if re.search(r"\b" + re.escape(term) + r"\b", low):
            ingredient = BRAND_TO_INGREDIENT.get(term, term)
            if ingredient in seen:
                continue
            seen.add(ingredient)
            rxcui, canonical = _rxnorm_lookup(ingredient)
            mappings.append({"raw": term, "type": "drug",
                             "canonical": canonical, "rxcui": rxcui})

    # conditions/symptoms -> canonical (longest phrases first to prefer specifics)
    for phrase in sorted(CONDITION_CANON, key=len, reverse=True):
        if phrase in low:
            canon = CONDITION_CANON[phrase]
            if canon in seen:
                continue
            seen.add(canon)
            mappings.append({"raw": phrase, "type": "condition",
                             "canonical": canon, "rxcui": None})

    if not mappings:
        return text, mappings

    lines = []
    for m in mappings:
        if m["rxcui"]:
            lines.append(f"- {m['canonical']} (RxNorm RxCUI {m['rxcui']})")
        else:
            lines.append(f"- {m['canonical']}")
    annotated = text + "\n\nNormalized clinical concepts:\n" + "\n".join(lines)
    return annotated, mappings


# quick manual test:  python normalize.py
if __name__ == "__main__":
    demo = "Started patient on Zocor 40mg for high cholesterol and high BP."
    out, maps = normalize_note(demo)
    print("ANNOTATED:\n", out, "\n\nMAPPINGS:")
    for m in maps:
        print(" ", m)
