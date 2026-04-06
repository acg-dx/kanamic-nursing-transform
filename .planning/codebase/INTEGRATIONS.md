# External Integrations

**Analysis Date:** 2026-04-06

## APIs & External Services

**TRITRUS Portal (Kanamick) — Primary Healthcare RPA System:**
- Service: TRITRUS ポータルサイト (Kanamic health records management)
- Purpose: HAM (訪問看護記録管理) data entry, schedule management, patient records
- Auth: Username/password SSO via JOSSO (TRITRUS proprietary)
- Connection: Playwright browser automation
  - Entry: `KanamickAuthService` (`src/services/kanamick-auth.service.ts`)
  - Flow: TRITRUS → JOSSO SSO → HAM multi-frame system
  - HAM structure:
    - Main frame: `kanamicmain` with `topFrame` and `mainFrame`
    - Operations: Form-based navigation via `commontarget.jsp`
- Workflows:
  - `TranscriptionWorkflow`: 14-step process for entering 訪問看護実績 (visit results)
  - `DeletionWorkflow`: Remove incorrect transcriptions
  - `BuildingManagementWorkflow`: Update facility/resident assignments

**HAM 8-1 CSV (Step 8-1 Schedule Data Export) — Post-Registration Verification:**
- Service: HAM スケジュールデータ出力機能 (8-1 report)
- Purpose: Extract monthly predicted/actual visit schedule for reconciliation
- Mechanism:
  - Page: HAM メインメニュー → act_k11_1 → 8-1 スケジュールデータ出力
  - Date range: Configurable (targetMonth based)
  - Export: `submitTargetFormForSlowCSV()` → Playwright download event
  - Format: Shift-JIS encoded CSV with 17+ columns
- Download Service: `ScheduleCsvDownloaderService` (`src/services/schedule-csv-downloader.service.ts`)
  - Cached locally to `./downloads/schedule_8-1_YYYYMM*.csv`
  - File size validation: Minimum 100 bytes
  - Timeout: 120 seconds (large files)

**CSV Reconciliation Engine (Verification Pipeline Step 8-1):**
- Service: `ReconciliationService` (`src/services/reconciliation.service.ts`)
- Purpose: Compare Google Sheets 転記済み records vs HAM 8-1 CSV actual data
- CSV Parsing:
  - Input: HAM 8-1 CSV (Shift-JIS)
  - Decoder: TextDecoder('shift-jis') in `parseScheduleCsv()`
  - Column Detection: Regex-based header matching (automatic, resilient to layout changes)
  - Column Mapping:
    - Col 0: サービス日付 (service date)
    - Col 2-3: 開始/終了時刻 (start/end time)
    - Col 4: 利用者名 (patient name)
    - Col 7: スタッフ名 (staff name)
    - Col 11-12: サービス種類 & サービス内容 (service type & content)
    - Col 16: サービス実績 (result flag)

**Data Comparison & Matching:**
- Match Key: Normalized patient name + visit date + start time
- Name Normalization: `normalizeCjkName()` for CJK variant mapping (e.g., 髙 → 高)
- Date Normalization: YYYY/MM/DD format conversion from YYYYMMDD, YYYY-MM-DD, etc.
- Time Normalization: HH:MM format from HHMM, "XX時YY分" patterns

**Reconciliation Output (3-way verification):**
1. **Sheets → HAM Detection (転記漏れ):**
   - Records in Google Sheets 転記済み but missing from HAM CSV
   - Indicates: Transcription not actually registered in HAM system
   - Type: `missingFromHam[]`

2. **HAM → Sheets Detection (二重登録 or 手動追加):**
   - Records in HAM CSV but missing from Google Sheets
   - Indicates: Manual adds or system duplicates
   - Type: `extraInHam[]`

3. **Qualification Mismatch Detection (准看護師誤登録):**
   - SmartHR staff qualifications vs HAM service content matching
   - Rule: Qualified 准看護師 must have「准」in HAM service content; 看護師 must NOT have「准」
   - Source: SmartHR staff qualifications map
   - Type: `qualificationMismatches[]`

**Rehabilitation Segment Merging:**
- Issue: HAM splits 訪看Ⅰ５ (rehab 20-min sessions) into 20-minute segments
- Google Sheets records: Single visit with merged duration
- Solution: Group by (patient + date + staff) and merge consecutive segments
- Merge: First segment start time + last segment end time

**Filtering Rules (テスト患者 & 月次加算除外):**
- Exclude: Test patient names (青空, 練習, テスト prefixes)
- Exclude: 12:00-12:00 records (月次加算 — no staff assigned)
- Exclude: 超減算, 月超 service content (HAM auto-generated)

---

## Data Storage

**Databases:**
- No active database configured
- `mysql2` package present but not utilized in current codebase
- Future expansion capability for patient/staff master data

**File Storage — Local Filesystem:**
- CSV Downloads: `./downloads/`
  - Patient master: `*userallfull_YYYYMM*.csv` (Shift-JIS)
  - Schedule 8-1: `schedule_8-1_YYYYMM*.csv` (Shift-JIS)
  - Cache validation: File size > 100 bytes
  - Usage: Local cache to avoid repeated HAM exports

- Logs: `./logs/` (configurable via `LOG_DIR`)
  - Winston output
  - Daily reports

- Screenshots: `./screenshots/` (configurable via `SCREENSHOT_DIR`)
  - For AI healing (selector repair)
  - Retained for debugging failed steps

**Caching Strategy:**
- Monthly CSV files cached locally after first download
- Force re-download: `force: true` option in `ensurePatientCsv()` / `ensureScheduleCsv()`
- Prevents repeated Playwright navigation to HAM 8-1 export page

**Google Sheets (Primary Data Store):**
- See integrations section below — `SpreadsheetService`

---

## Authentication & Identity

**Auth Provider — TRITRUS/Kanamick JOSSO:**
- Mechanism: Custom JOSSO (Java Open Single Sign-On) integration
- Implementation: `KanamickAuthService` (`src/services/kanamick-auth.service.ts`)
- Login Flow:
  1. TRITRUS portal login page (initial)
  2. JOSSO redirect to `bi.kanamic.net/josso/signon/login.do`
  3. Username (#josso_username) + Password (#josso_password) entry
  4. Submit via `input.submit-button[type="button"]`
  5. Redirect to TRITRUS マイページ
  6. Click `goCicHam.jsp` (target="_blank" for new window)
  7. Auto-redirect to HAM login gateway
  8. HAM session established

- Context Management:
  - BrowserContext per workflow execution
  - Session persistence across multiple page operations
  - Automatic relaunch if context dies (OOM detection via `BrowserManager.isContextAlive()`)
  - Page death detection: `PAGE_DEATH_KEYWORDS` regex matching for crash/OOM symptoms

**Service Credentials:**
- Google Sheets: Service account JSON (path: `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`)
  - OAuth 2.0 client credentials flow
  - Scopes: `https://www.googleapis.com/auth/spreadsheets`

- OpenAI API: Bearer token (env: `OPENAI_API_KEY`)
  - Used for: `AIHealingService` screenshot-based selector repair

- SmartHR: Bearer token (env: `SMARTHR_ACCESS_TOKEN`)
  - Used for: Staff qualifications API (`SmartHRService`)

- Kintone: API token (env: `KINTONE_APP_197_TOKEN`)
  - Used for: Resident data retrieval (`KintoneService`)

---

## Monitoring & Observability

**Error Tracking:**
- None actively integrated
- Manual logging via custom logger (`src/core/logger.ts` wraps console)
- Future: Could integrate Sentry or DataDog

**Logs:**
- Approach: Winston logger with file output
  - Location: `./logs/` (configurable)
  - Levels: debug, info, warn, error
  - Structured logging throughout services and workflows

**Workflow Execution Reporting:**
- Daily report generation: `NotificationService` (`src/services/notification.service.ts`)
- Report contents: Workflow name, location, processed records, error count, duration
- Output: Email via webhook to notification service

---

## CI/CD & Deployment

**Hosting:**
- Self-hosted or on-premise (not cloud-specific)
- Requires Node.js 18+ runtime environment
- Headless Playwright browser support (chromium binary)

**CI Pipeline:**
- Not detected — no GitHub Actions, GitLab CI, or Jenkins config found
- Manual execution via npm scripts
- Cron triggers: node-cron scheduled within process (not systemd/cron)

**Deployment:**
- No Docker/Kubernetes config detected
- Direct Node.js process execution
- npm scripts: `npm run workflow:transcription`, `npm run dev`

---

## Environment Configuration

**Required Env Vars (Critical for Startup):**
```
KANAMICK_URL                    # TRITRUS portal URL
KANAMICK_USERNAME              # Login username
KANAMICK_PASSWORD              # Login password
```

**Optional Env Vars (Graceful Degradation):**
```
SMARTHR_ACCESS_TOKEN            # Staff qualifications (skip if empty)
SMARTHR_BASE_URL                # Defaults to https://acg.smarthr.jp/api/v1
KINTONE_BASE_URL                # Resident data source
KINTONE_APP_197_TOKEN           # Kintone API token
GH_SHEET_ID_KAGOSHIMA           # Shared living (鹿児島)
GH_SHEET_ID_FUKUOKA             # Shared living (福岡)
NOTIFICATION_WEBHOOK_URL        # Daily report webhook
NOTIFICATION_TO                 # Email recipients
```

**Google Sheets IDs (Hardcoded in Config):**
- 4 nursing offices with separate sheets:
  - 姶良: `12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M`
  - 荒田: `1dri7Bgj0gk3zq7giZ0690rQq0zYbKjKtBIKK5UtQJJ4`
  - 谷山: `1JCtgIVXaAxRXjpOP9YbRGosYYm-j7835oOPCBccu3s8`
  - 福岡: `1xRnQ6d2rKKDvJvVPHPpAhyySvZFdjQ5gK3iBahYzmTg`
- Building management: `18DueDsYPsNmePiYIp9hVpD1rIWWMCyPX5SdWzXOnZBY`

**Secrets Location:**
- `.env` file (root of project)
- Never committed to git (added to `.gitignore`)

---

## Webhooks & Callbacks

**Incoming:**
- None detected (system is outbound-only)

**Outgoing:**

**Notification Webhook (Daily Report):**
- URL: `NOTIFICATION_WEBHOOK_URL` (optional)
- Method: POST
- Content-Type: application/json
- Payload:
  ```json
  {
    "to": "email1@example.com,email2@example.com",
    "subject": "[カナミックRPA] 転記処理結果 YYYY-MM-DD",
    "htmlBody": "<html>...</html>"
  }
  ```
- Service: `NotificationService.sendDailyReport()`
- Condition: Only sent if `totalProcessed > 0` or `totalErrors > 0`

---

## Google Sheets Integration (Primary Data Hub)

**Service:** Google Sheets API v4 (`googleapis` v144.0.0)

**Authentication:**
- Service account key JSON file
- Path: Specified by `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` or default `./kangotenki.json`
- Scope: `https://www.googleapis.com/auth/spreadsheets`

**SpreadsheetService (`src/services/spreadsheet.service.ts`):**
- CRUD operations for all workflows
- Methods:
  - `getTranscriptionRecords()`: Fetch row data from 転記用 (transcription) sheets
  - `updateTranscriptionStatus()`: Update status columns (転記フラグ, エラー詳細, etc.)
  - `getDeletionRecords()`: Fetch deletion targets
  - `getTranscriptionRecords()`: Support for multiple sheets via `tab` parameter

**Sheet Schemas:**

**Transcription Sheet (転記タブ, e.g. "2026年03月"):**
- Row 1: Headers
- Rows 2+: Transcription records
- Columns (26 total):
  - A(0): 記録ID (record ID)
  - B(1): タイムスタンプ (timestamp)
  - C(2): 更新日時 (updated at)
  - D(3): スタッフ番号 (staff number)
  - E(4): スタッフ名 (staff name)
  - F(5): あおぞらID (Aozora ID)
  - G(6): 患者名 (patient name)
  - H(7): 訪問日 (visit date)
  - I(8): 開始時間 (start time)
  - J(9): 終了時間 (end time)
  - K(10): サービス種別1 (service type 1: 医療/介護/精神医療)
  - L(11): サービス種別2 (service type 2: specific service)
  - M(12): 完了状態 (completion status)
  - N(13): 同行チェック (companion check)
  - O(14): 緊急フラグ (emergency flag)
  - P(15): 同行事務員チェック (admin check)
  - Q(16): 複数訪問 (multiple visit flag)
  - R(17): 緊急時事務員チェック (emergency admin check)
  - S(18): 加算対象の理由 (surcharge reason) — **NEW in C1 column shift**
  - T(19): 転記フラグ (transcription flag: "", "転記済み", "修正あり", "エラー：マスタ不備", "エラー：システム")
  - U(20): マスタ修正フラグ (master correction flag: boolean)
  - V(21): エラー詳細 (error detail: text)
  - W(22): データ取得日時 (data fetched at: timestamp)
  - X(23): サービス票チェック (service ticket check: boolean)
  - Y(24): 備考 (notes: text)
  - Z(25): 実績ロック (record locked: boolean)
  - AA(26): HAM assignId (assignment ID used for deletion)

**Building Management Sheet (同一建物管理):**
- Facility definitions tab (施設定義)
- Monthly tabs (月度タブ, e.g. "2026/03")
- Records: Facility name, resident, Aozora ID, move-in/out dates, status, new flag

**Deletion Sheet Schema:**
- Similar structure to transcription, tracks deletion operations
- Status: "", "削除対象", "削除済み", "削除エラー"

---

## SmartHR Integration (Staff Qualifications)

**Service:** SmartHR API v1 (`SmartHRService`, `src/services/smarthr.service.ts`)

**Authentication:**
- Bearer token: `SMARTHR_ACCESS_TOKEN` (optional)
- Base URL: `https://acg.smarthr.jp/api/v1` (configurable)

**Endpoints:**
- `GET /crews` — Fetch all employees with pagination
  - Query params: `per_page=100, page=N`
  - Header: `x-total-count` for pagination
  - Returns: Name, emp_code, custom fields

**Custom Fields (Staff Qualifications):**
- Resource: 資格1 through 資格8 (qualifications 1-8)
- Used for: Reconciliation qualification mismatch detection
- Extraction: `getCrewByEmpCode()` for single lookup, `getAllCrews()` for bulk
- Normalization: Space removal (SmartHR uses "姓 名" with space; Sheet uses "姓名" without)

**Usage in Reconciliation:**
- `ReconciliationService.setStaffQualifications()` populates map
- Qualification check: "准看護師" requires「准」in HAM service content
- Detection: Automatic mismatch reporting for qualification violations

---

## Kintone Integration (Resident Data — Building Management)

**Service:** Kintone REST API (`KintoneService`, `src/services/kintone.service.ts`)

**Configuration:**
- Base URL: `KINTONE_BASE_URL` (optional, e.g. `https://acgaozora.cybozu.com`)
- App ID: 197 (居室利用変更履歴)
- API Token: `KINTONE_APP_197_TOKEN`

**Endpoint:**
- `GET {baseUrl}/k/v1/records.json` — Query resident records
- Authentication: `X-Cybozu-API-Token` header

**Query Logic:**
- Condition: Contract start date ≤ target month end AND moving out date ≥ target month start
- Pagination: limit=500 offset-based
- Fields: Facility_Name, User_Name, Aozora_Id, Contract_Start_Date, Moving_Out_Date, Provided_Business

**Data Mapping:**
- Kintone facility names → Kanamick facility names (via `KINTONE_SPECIAL_MAPPINGS` hardcode)
- Examples:
  - "うらら1・認知症GH" → "グループホームうらら"
  - "田上・有料" → "有料老人ホームあおぞら"

---

## GH Spreadsheet Integration (Shared Living Facilities)

**Service:** `GHSpreadsheetService` (`src/services/gh-spreadsheet.service.ts`)

**Configuration:**
- Kagoshima Sheet ID: `GH_SHEET_ID_KAGOSHIMA`
- Fukuoka Sheet ID: `GH_SHEET_ID_FUKUOKA`
- Both optional (graceful degradation)

**Purpose:**
- Extract 共同生活援助 (group home / shared living) resident data
- Supplement Kintone for building management

---

## Patient Master CSV (利用者マスタ)

**Service:** `PatientCsvDownloaderService`, `PatientMasterService`

**CSV Source:** HAM u1-1 (利用者マスタ管理)
- Download: `ensurePatientCsv()` via HAM UI
- Format: Shift-JIS CSV
- File name: `*userallfull_YYYYMM*.csv`

**Usage:**
- Service code validation (patient name ↔ Aozora ID matching)
- Patient existence verification before transcription

**Parsing:**
- `PatientMasterService` parses local CSV to Map<AozoraId, PatientInfo>

---

## Staff Info CSV (TRITRUS Export)

**Service:** `parseStaffInfoCSV()` (`src/utils/staff-csv-parser.ts`)

**CSV Source:** TRITRUS staff_info.csv
- Format: Shift-JIS with quoted fields (multiline support)
- Columns: Employee name (kana/kanji), employee number, office name, main office
- Parsing: Quoted CSV parser with multiline support (cols 22-24 may contain newlines)

---

*Integration audit: 2026-04-06*
