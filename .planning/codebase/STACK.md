# Technology Stack

**Analysis Date:** 2026-04-06

## Languages

**Primary:**
- TypeScript 5.7.0 - Core application logic, workflows, services, type safety

**Secondary:**
- JavaScript - Build output (CommonJS compiled from TypeScript)
- Shift-JIS Text Processing - CSV file parsing for HAM exports (patient master, schedule data 8-1)

## Runtime

**Environment:**
- Node.js (target: ES2022, CommonJS module output)

**Package Manager:**
- npm (package-lock.json present)

## Frameworks

**Build/Compilation:**
- TypeScript 5.7.0 - Static type checking and transpilation to ES2022

**Testing:**
- Vitest 4.0.18 - Test runner for unit and integration tests
  - Configuration: `vitest.config.ts`
  - Test files: `src/**/*.test.ts`
  - Environment: Node.js

**Browser Automation:**
- Playwright 1.50.0 - RPA automation for HAM (Kanamick) and TRITRUS portal navigation
  - Used for: Form submission, page navigation, download event handling, screenshot capture
  - Pages: HAM (訪問看護記録管理), TRITRUS portal (ポータルサイト)
  - Async download handling for CSV files (patient master, schedule data)

**Cron/Scheduling:**
- node-cron 3.0.3 - Scheduled daily transcription and monthly building management workflows
  - Default: transcription at 13:00 daily, building management at 06:00 on 3rd of month
  - Configurable via `TRANSCRIPTION_CRON` and `BUILDING_MGMT_CRON` env vars

**Logging:**
- Winston 3.17.0 - Structured logging and log file management
  - Custom logger wrapper in `src/core/logger.ts`
  - Log directory: configurable via `LOG_DIR` env var (default: `./logs`)

## Key Dependencies

**Critical - External APIs:**
- `googleapis` 144.0.0 - Google Sheets API v4 client for reading/writing transcription records
  - Auth: Service account key (JSON file specified by `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`)
  - Used by: `SpreadsheetService` for CRUD operations on all sheets (transcription, deletion, building management)

- `openai` 6.25.0 - OpenAI API client for AI-powered CSS selector repair
  - Model: Configurable via `AI_HEALING_MODEL` env var (default: gpt-4o)
  - Used by: `AIHealingService` for screenshot + HTML analysis to fix broken Playwright selectors
  - Image format: base64-encoded PNG screenshots

- `@anthropic-ai/sdk` 0.39.0 - Anthropic Claude API (optional/future expansion capability)

**Infrastructure:**
- `mysql2` 3.20.0 - MySQL client library for data queries
  - Connection: Not actively used in current codebase (may be for future database integration)

- `nodemailer` 6.9.16 - SMTP email client for notifications
  - Used by: Notification webhook system for daily reports
  - Configured via webhook URL (`NOTIFICATION_WEBHOOK_URL`)

**Encoding/Decoding:**
- `iconv-lite` 0.7.2 - Character encoding converter (dev dependency)
  - Used for: Converting Shift-JIS CSV files to UTF-8 for parsing
  - Critical for: `PatientCsvDownloaderService`, `StaffInfoCSVParser`, `ReconciliationService`

**Development Tools:**
- `tsx` 4.19.0 - TypeScript executor for running `.ts` scripts directly (dev dependency)
  - Used for: npm scripts (`workflow:*`, `reconciliation`, test scripts)

## Configuration

**Environment Variables:**
- `KANAMICK_URL` - TRITRUS portal base URL (required)
- `KANAMICK_USERNAME` - Portal login username (required)
- `KANAMICK_PASSWORD` - Portal login password (required)
- `KANAMICK_HAM_OFFICE_KEY` - HAM office selector key (optional, default: '6')
- `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` - Path to Google service account JSON (default: `./kangotenki.json`)
- `OPENAI_API_KEY` - OpenAI API key for AI healing (optional if not using AI-powered selector repair)
- `AI_HEALING_MODEL` - Model name for selector repair (default: `gpt-4o`)
- `AI_HEALING_MAX_ATTEMPTS` - Retry attempts for AI healing (default: `3`)
- `SMARTHR_ACCESS_TOKEN` - SmartHR API bearer token for staff qualifications (optional)
- `SMARTHR_BASE_URL` - SmartHR API base URL (default: `https://acg.smarthr.jp/api/v1`)
- `KINTONE_BASE_URL` - Kintone API base URL for resident data (optional)
- `KINTONE_APP_197_TOKEN` - API token for Kintone App 197 (居室利用変更履歴)
- `GH_SHEET_ID_KAGOSHIMA` - Google Sheets ID for shared living facilities (鹿児島) (optional)
- `GH_SHEET_ID_FUKUOKA` - Google Sheets ID for shared living facilities (福岡) (optional)
- `BUILDING_MGMT_SHEET_ID` - Google Sheets ID for building management (default: hardcoded ID)
- `RUN_LOCATIONS` - Comma-separated office names to run (optional, default: all 4 offices)
- `NOTIFICATION_WEBHOOK_URL` - Webhook URL for email notifications (optional)
- `NOTIFICATION_TO` - Comma-separated email addresses for daily reports (optional)
- `DRY_RUN` - Set to 'true' for dry-run mode (default: false)
- `LOG_LEVEL` - Logging level (default: `info`)
- `LOG_DIR` - Log file directory (default: `./logs`)
- `SCREENSHOT_DIR` - Screenshot storage for AI healing (default: `./screenshots`)

**Config Loading:**
- Entry point: `src/config/app.config.ts`
- Loads via `dotenv` from `.env` file
- Multi-location support: 4 nursing stations with separate Google Sheets IDs
  - 姶良 (Aira)
  - 荒田 (Arata)
  - 谷山 (Taniyama)
  - 福岡 (Fukuoka)

## Platform Requirements

**Development:**
- Node.js 18+ (for ES2022 features)
- TypeScript 5.7.0
- .env file with required credentials
- Google service account JSON key file
- Playwright system dependencies (browser binaries installed on first run)

**Production:**
- Node.js 18+
- Headless browser environment (Playwright with chromium)
- Network access to:
  - TRITRUS portal (KANAMICK_URL)
  - Google Sheets API
  - OpenAI API (if AI healing enabled)
  - SmartHR API (if enabled)
  - Kintone API (if enabled)
  - Notification webhook endpoint (if enabled)
- Disk space for: CSV downloads (`./downloads`), logs (`./logs`), screenshots (`./screenshots`)

## Build & Execution

**Build:**
```bash
npm run build    # Compiles TypeScript to dist/
```

**Execution:**
```bash
npm start                          # Start compiled dist/index.js
npm run dev                        # Run src/index.ts directly via tsx
npm run workflow:transcription     # Run transcription workflow
npm run workflow:deletion          # Run deletion workflow
npm run workflow:building          # Run building management workflow
npm run reconciliation             # Run reconciliation check (step 8-1)
npm run test                       # Run all tests
npm run test:watch                 # Watch mode testing
```

**Entry Points:**
- `src/index.ts` - Main orchestrator for daily jobs and workflow selection
- `src/scripts/` - Standalone utility and debugging scripts (70+ helper scripts)

---

*Stack analysis: 2026-04-06*
