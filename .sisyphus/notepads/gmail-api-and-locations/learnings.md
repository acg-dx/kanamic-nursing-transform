## Learnings

## 2026-02-27 Initial Context
- notification.service.ts already migrated from nodemailer to googleapis Gmail API
- notification.types.ts already updated: smtp → serviceAccountKeyPath
- index.ts and run-transcription.ts already updated to use new config shape
- Test file mock setup (lines 5-20) correctly mocks googleapis, BUT test bodies (lines 89-147) still reference `nodemailer`
- Pre-existing TS errors in test-real-transcription.ts and test-transcription-selectors.ts (Element type) — ignore these
- app.config.ts has SHEET_LOCATIONS hardcoded array of 4 offices — needs RUN_LOCATIONS env var filter
- Service account key path defaults to `./kangotenki.json`
