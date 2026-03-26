#!/usr/bin/env bash
# ============================================================
# 転記RPA — Cloud Run Job デプロイスクリプト
#
# 4事業所それぞれに独立した Cloud Run Job を作成:
#   tenki-transcription-aira   (姶良)
#   tenki-transcription-arata  (荒田)
#   tenki-transcription-taniyama (谷山)
#   tenki-transcription-fukuoka (福岡)
#   tenki-building-data        (同一建物データ取得 — 共通)
#
# 使用方法:
#   ./deploy.sh build          # イメージをビルド＆プッシュのみ
#   ./deploy.sh jobs           # Cloud Run Jobs を作成/更新のみ
#   ./deploy.sh scheduler      # Cloud Scheduler を作成/更新のみ
#   ./deploy.sh all            # 全部実行（build + jobs + scheduler）
#   ./deploy.sh                # = all
# ============================================================
set -euo pipefail

# === 設定 ===
PROJECT_ID="acg-rpa-playwright"
REGION="asia-northeast1"
IMAGE="asia-northeast1-docker.pkg.dev/${PROJECT_ID}/nursing-record/tenki-rpa:latest"
SA="324463713340-compute@developer.gserviceaccount.com"
VPC_CONNECTOR="nursing-connector"

# === 共通環境変数 ===
COMMON_ENV="TZ=Asia/Tokyo"
COMMON_ENV+=",NODE_ENV=production"
COMMON_ENV+=",HEADLESS=true"
COMMON_ENV+=",GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./kangotenki.json"
COMMON_ENV+=",NOTIFICATION_WEBHOOK_URL=${NOTIFICATION_WEBHOOK_URL:-https://script.google.com/macros/s/AKfycbzkOEXAoXzLWXPLQF-eT2UnPuAXvHbucXBtv6O5b_KWTHrRaVwLXclBs3JrJs0KwKxpDQ/exec}"
COMMON_ENV+=",NOTIFICATION_TO=${NOTIFICATION_TO:-dx@aozora-cg.com}"
COMMON_ENV+=",OPENAI_API_KEY=${OPENAI_API_KEY:-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}"
COMMON_ENV+=",SMARTHR_ACCESS_TOKEN=${SMARTHR_ACCESS_TOKEN:-shr_307f_kZFPn3MXM6QuLDShCev5sKusWMsPHzdM}"
COMMON_ENV+=",KANAMICK_URL=${KANAMICK_URL:-https://portal.kanamic.net/tritrus/index/}"
COMMON_ENV+=",KANAMICK_USERNAME=${KANAMICK_USERNAME:-ACGPdx@aozora-cg.com}"
COMMON_ENV+=",KANAMICK_PASSWORD=${KANAMICK_PASSWORD:-Acgp2308!}"

# === 4事業所の定義 ===
# 配列: JOB名 | 事業所名 | RUN_LOCATIONS | stationName | hamOfficeCode | スケジュール時刻(JST)
declare -a OFFICES=(
  "tenki-transcription-aira|姶良|姶良|訪問看護ステーションあおぞら姶良|400021814|0 13 * * *"
  "tenki-transcription-arata|荒田|荒田|訪問看護ステーションあおぞら荒田|109152|10 13 * * *"
  "tenki-transcription-taniyama|谷山|谷山|訪問看護ステーションあおぞら谷山|400011055|20 13 * * *"
  "tenki-transcription-fukuoka|福岡|福岡|訪問看護ステーションあおぞら福岡|103435|30 13 * * *"
)

# 同一建物データ取得 Job
JOB_BUILDING_DATA="tenki-building-data"

# ============================================================
# 関数定義
# ============================================================

build_image() {
  echo "=== イメージビルド＆プッシュ ==="
  gcloud builds submit \
    --config=cloudbuild.yaml \
    --project="${PROJECT_ID}" \
    --substitutions=SHORT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo 'manual')" \
    .
  echo "=== ビルド完了: ${IMAGE} ==="
}

deploy_transcription_job() {
  local job_name="$1"
  local location_label="$2"
  local run_locations="$3"
  local station_name="$4"
  local ham_office_code="$5"

  local job_env="${COMMON_ENV}"
  job_env+=",RUN_LOCATIONS=${run_locations}"
  job_env+=",KANAMICK_STATION_NAME=${station_name}"
  job_env+=",KANAMICK_HAM_OFFICE_KEY=6"
  job_env+=",KANAMICK_HAM_OFFICE_CODE=${ham_office_code}"

  echo "--- ${job_name} (${location_label}) ---"
  if gcloud run jobs describe "${job_name}" --project="${PROJECT_ID}" --region="${REGION}" &>/dev/null; then
    gcloud run jobs update "${job_name}" \
      --project="${PROJECT_ID}" \
      --region="${REGION}" \
      --image="${IMAGE}" \
      --command="node" \
      --args="dist/scripts/run-transcription.js" \
      --set-env-vars="${job_env}" \
      --task-timeout=86400s \
      --max-retries=1 \
      --memory=8Gi \
      --cpu=2 \
      --vpc-connector="${VPC_CONNECTOR}" \
      --vpc-egress=all-traffic \
      --no-execute-now
  else
    gcloud run jobs create "${job_name}" \
      --project="${PROJECT_ID}" \
      --region="${REGION}" \
      --image="${IMAGE}" \
      --command="node" \
      --args="dist/scripts/run-transcription.js" \
      --set-env-vars="${job_env}" \
      --task-timeout=86400s \
      --max-retries=1 \
      --memory=8Gi \
      --cpu=2 \
      --service-account="${SA}" \
      --vpc-connector="${VPC_CONNECTOR}" \
      --vpc-egress=all-traffic
  fi
  echo "--- ${job_name} (${location_label}) デプロイ完了 ---"
}

deploy_jobs() {
  echo "=== Cloud Run Jobs デプロイ ==="

  # --- 4事業所の転記 Job ---
  for office in "${OFFICES[@]}"; do
    IFS='|' read -r job_name location_label run_locations station_name ham_office_code _schedule <<< "${office}"
    deploy_transcription_job "${job_name}" "${location_label}" "${run_locations}" "${station_name}" "${ham_office_code}"
  done

  # --- 旧 tenki-transcription Job を削除（姶良専用に置き換え済み） ---
  if gcloud run jobs describe "tenki-transcription" --project="${PROJECT_ID}" --region="${REGION}" &>/dev/null; then
    echo "--- 旧 tenki-transcription Job を検出。手動で削除してください:"
    echo "    gcloud run jobs delete tenki-transcription --project=${PROJECT_ID} --region=${REGION}"
  fi

  # --- 同一建物データ取得 Job ---
  local building_env="${COMMON_ENV}"
  building_env+=",KINTONE_BASE_URL=${KINTONE_BASE_URL:-}"
  building_env+=",KINTONE_APP_197_TOKEN=${KINTONE_APP_197_TOKEN:-}"
  building_env+=",GH_SHEET_ID_KAGOSHIMA=${GH_SHEET_ID_KAGOSHIMA:-}"
  building_env+=",GH_SHEET_ID_FUKUOKA=${GH_SHEET_ID_FUKUOKA:-}"
  building_env+=",BUILDING_MGMT_SHEET_ID=18DueDsYPsNmePiYIp9hVpD1rIWWMCyPX5SdWzXOnZBY"

  echo "--- ${JOB_BUILDING_DATA} ---"
  if gcloud run jobs describe "${JOB_BUILDING_DATA}" --project="${PROJECT_ID}" --region="${REGION}" &>/dev/null; then
    gcloud run jobs update "${JOB_BUILDING_DATA}" \
      --project="${PROJECT_ID}" \
      --region="${REGION}" \
      --image="${IMAGE}" \
      --command="node" \
      --args="dist/scripts/run-building-data.js" \
      --set-env-vars="${building_env}" \
      --task-timeout=1800s \
      --max-retries=1 \
      --memory=1Gi \
      --cpu=1 \
      --vpc-connector="${VPC_CONNECTOR}" \
      --vpc-egress=all-traffic \
      --no-execute-now
  else
    gcloud run jobs create "${JOB_BUILDING_DATA}" \
      --project="${PROJECT_ID}" \
      --region="${REGION}" \
      --image="${IMAGE}" \
      --command="node" \
      --args="dist/scripts/run-building-data.js" \
      --set-env-vars="${building_env}" \
      --task-timeout=1800s \
      --max-retries=1 \
      --memory=1Gi \
      --cpu=1 \
      --service-account="${SA}" \
      --vpc-connector="${VPC_CONNECTOR}" \
      --vpc-egress=all-traffic
  fi
  echo "--- ${JOB_BUILDING_DATA} デプロイ完了 ---"
}

deploy_scheduler() {
  echo "=== Cloud Scheduler デプロイ ==="

  # --- 4事業所の転記スケジューラー（1時間ずつずらす） ---
  for office in "${OFFICES[@]}"; do
    IFS='|' read -r job_name location_label _run_locations _station_name _ham_office_code schedule <<< "${office}"

    local sched_name="${job_name}-daily"
    local job_uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${job_name}:run"

    echo "--- ${sched_name} (${location_label}) ---"
    if gcloud scheduler jobs describe "${sched_name}" --project="${PROJECT_ID}" --location="${REGION}" &>/dev/null; then
      gcloud scheduler jobs update http "${sched_name}" \
        --project="${PROJECT_ID}" \
        --location="${REGION}" \
        --schedule="${schedule}" \
        --time-zone="Asia/Tokyo" \
        --uri="${job_uri}" \
        --http-method=POST \
        --oauth-service-account-email="${SA}"
    else
      gcloud scheduler jobs create http "${sched_name}" \
        --project="${PROJECT_ID}" \
        --location="${REGION}" \
        --schedule="${schedule}" \
        --time-zone="Asia/Tokyo" \
        --uri="${job_uri}" \
        --http-method=POST \
        --oauth-service-account-email="${SA}"
    fi
    echo "--- ${sched_name}: ${schedule} JST (${location_label}) ---"
  done

  # --- 旧スケジューラーの通知 ---
  if gcloud scheduler jobs describe "tenki-transcription-daily" --project="${PROJECT_ID}" --location="${REGION}" &>/dev/null; then
    echo "--- 旧 tenki-transcription-daily スケジューラーを検出。手動で削除してください:"
    echo "    gcloud scheduler jobs delete tenki-transcription-daily --project=${PROJECT_ID} --location=${REGION}"
  fi

  # --- 同一建物データ取得: 毎月3日 6:00 JST ---
  local sched_building="tenki-building-data-monthly"
  local building_uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_BUILDING_DATA}:run"

  if gcloud scheduler jobs describe "${sched_building}" --project="${PROJECT_ID}" --location="${REGION}" &>/dev/null; then
    gcloud scheduler jobs update http "${sched_building}" \
      --project="${PROJECT_ID}" \
      --location="${REGION}" \
      --schedule="0 6 3 * *" \
      --time-zone="Asia/Tokyo" \
      --uri="${building_uri}" \
      --http-method=POST \
      --oauth-service-account-email="${SA}"
  else
    gcloud scheduler jobs create http "${sched_building}" \
      --project="${PROJECT_ID}" \
      --location="${REGION}" \
      --schedule="0 6 3 * *" \
      --time-zone="Asia/Tokyo" \
      --uri="${building_uri}" \
      --http-method=POST \
      --oauth-service-account-email="${SA}"
  fi
  echo "--- ${sched_building}: 毎月3日 6:00 JST ---"
}

# ============================================================
# メイン
# ============================================================
ACTION="${1:-all}"

case "${ACTION}" in
  build)
    build_image
    ;;
  jobs)
    deploy_jobs
    ;;
  scheduler)
    deploy_scheduler
    ;;
  all)
    build_image
    deploy_jobs
    deploy_scheduler
    ;;
  *)
    echo "Usage: $0 {build|jobs|scheduler|all}"
    exit 1
    ;;
esac

echo ""
echo "=== デプロイ完了 ==="
echo ""
echo "Cloud Run Jobs:"
for office in "${OFFICES[@]}"; do
  IFS='|' read -r job_name location_label _ _ _ schedule <<< "${office}"
  echo "  ${job_name} (${location_label}) — ${schedule} JST"
done
echo "  ${JOB_BUILDING_DATA} — 毎月3日 6:00 JST"
echo ""
echo "確認コマンド:"
echo "  gcloud run jobs list --project=${PROJECT_ID} --region=${REGION}"
echo "  gcloud scheduler jobs list --project=${PROJECT_ID} --location=${REGION}"
echo ""
echo "手動実行:"
for office in "${OFFICES[@]}"; do
  IFS='|' read -r job_name location_label _ _ _ _ <<< "${office}"
  echo "  gcloud run jobs execute ${job_name} --project=${PROJECT_ID} --region=${REGION}  # ${location_label}"
done
echo "  gcloud run jobs execute ${JOB_BUILDING_DATA} --project=${PROJECT_ID} --region=${REGION}"
