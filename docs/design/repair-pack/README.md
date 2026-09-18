# Repair-pack helper source (reference only)

Extracted verbatim on 2026-09-18 from the two HTML guides of the 2026-09-18
handoff pack (the ZIP, `code/`, `tests/` and `ACCEPTANCE_MATRIX.csv` were not
delivered). Plan and decisions: `../repair-expansion-report-and-plan.md` (§7 D6).

- `repair/` — from `theDAW_Repair_and_Expansion_Guide.html` (audited against
  `personal/main` 721ea5b). Primary set.
- `implementation/` — from `theDAW_Implementation_Guide.html` (audited against
  public 851f6a0 only). Use only `gestureMachine`, `normalizationCommand`,
  `renderRequest` from here.

Nothing in this folder is compiled, imported, or tested by the app. Functions
are ported into `frontend/src/lib/...` / `backend/...` with new tests written
against the app's own types. The pack's own tests were not shipped, so its
"101 / 56 tests passed" claims are unverified.
