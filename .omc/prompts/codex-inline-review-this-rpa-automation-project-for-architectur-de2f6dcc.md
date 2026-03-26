Review this RPA automation project for architectural completeness. The project automates 3 workflows in Kanamick healthcare software:
1. Transcription (転記): Daily nursing visit record input
2. Deletion (削除): Record deletion
3. Building Management (同一建物管理): Monthly resident registration

Key architecture:
- TypeScript + Playwright + Google Sheets API + Anthropic AI
- AI self-healing selectors: when CSS selectors fail, takes screenshot → sends to Claude API → gets new selector → validates → updates config
- SelectorEngine with primary/fallback/AI-heal chain
- BaseWorkflow abstract class with shared retry/logging
- Separate selector JSON configs per workflow

Files: src/core/selector-engine.ts, src/core/ai-healing-service.ts, src/core/browser-manager.ts, src/workflows/transcription/transcription.workflow.ts, src/workflows/deletion/deletion.workflow.ts, src/workflows/building-management/building.workflow.ts, src/index.ts

Evaluate: functional completeness, separation of concerns, error handling strategy, scalability. Keep response concise.