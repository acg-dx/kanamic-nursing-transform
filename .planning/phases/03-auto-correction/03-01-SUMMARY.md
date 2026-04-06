---
phase: 03-auto-correction
plan: 01
subsystem: workflow
tags: [ham-deletion, auto-correction, re-transcription, verification]

requires:
  - phase: 02-workflow-integration
    provides: writeVerificationStatus, runVerification, TranscriptionRecord verification fields
provides:
  - deleteHamRecord() for assignId-based HAM record deletion
  - retranscribeRecords() for dedicated re-transcription (D-06)
  - runAutoCorrection() orchestrating delete -> reset -> re-transcribe -> re-verify
  - resetForRetranscription() for T/AB/AC column clearing
affects: [03-02-PLAN, processLocation integration]

tech-stack:
  added: []
  patterns: [assignId-based deletion in transcription workflow, dedicated re-transcription path separate from processLocation]

key-files:
  created: []
  modified:
    - src/services/spreadsheet.service.ts
    - src/workflows/transcription/transcription.workflow.ts

key-decisions:
  - "D-06: retranscribeRecords calls processRecord directly, avoiding processLocation recursion (no re-login, no CSV reload, no staff pre-check)"
  - "D-03/D-04: missingFromHam records skip HAM deletion and only reset T column; time/service/staff mismatches require full HAM deletion"
  - "FIX-03: re-verification and failure recording are self-contained within runAutoCorrection"

patterns-established:
  - "Auto-correction error isolation: each record wrapped in try-catch, failures do not stop the correction loop (D-09)"
  - "Dedicated re-transcription: retranscribeRecords is a lightweight path that reuses processRecord without processLocation overhead"

requirements-completed: [FIX-01, FIX-02, FIX-03]

duration: 5min
completed: 2026-04-06
---

# Phase 03 Plan 01: Auto-Correction Core Summary

**HAM assignId-based deletion + dedicated re-transcription + re-verification with result recording for automatic mismatch correction**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-06T06:59:20Z
- **Completed:** 2026-04-06T07:04:39Z
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments

### Task 1: resetForRetranscription in SpreadsheetService
- Added method that clears T column (transcription flag), AB column (verification timestamp), and AC column (verification error)
- Follows same batch-update-loop pattern as writeVerificationStatus
- Commit: `eadbe93`

### Task 2: deleteHamRecord in TranscriptionWorkflow
- Navigates HAM via k2_1 -> k2_2 to patient schedule
- Deletes records by assignId using confirmDelete pattern adapted from DeletionWorkflow
- Handles record2flag check (cannot delete with active record-II), missing buttons, and saves with act_update
- Commit: `ae1eb4b`

### Task 3: retranscribeRecords + runAutoCorrection in TranscriptionWorkflow
- **retranscribeRecords**: D-06 dedicated re-transcription path calling processRecord directly with 5-minute timeout and withRetry
- **runAutoCorrection**: 5-phase orchestration:
  - Phase A: Delete time/service/staff mismatches from HAM + reset sheets
  - Phase B: Reset-only for missingInHam records (no HAM deletion needed)
  - Phase C: Re-transcribe all reset records via retranscribeRecords
  - Phase D: Re-verify corrected records and write AB/AC columns
  - Phase E: Write auto_correction_failed to AC column for failed records
- Commit: `8e89b62`

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None - all methods are fully implemented with real HAM navigation and Sheets API calls.

## Verification

- TypeScript compilation: 0 new errors
- All 3 methods exist with correct signatures
- D-03/D-04 separation (missingFromHam vs other mismatches) verified
- D-06 (dedicated retranscribeRecords, not processLocation recursion) verified
- D-09 (try-catch per record) verified
- FIX-03 (re-verification + auto_correction_failed recording) verified
