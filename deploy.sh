#!/usr/bin/env bash
# ============================================================
# 転記RPA — Cloud Run Job デプロイスクリプト
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

# Cloud Run Job 名
JOB_TRANSCRIPTION="tenki-transcription"
JOB_BUILDING_DATA="tenki-building-data"

# === 環境変数（Secret Manager に入れない非機密値） ===
# 機密情報は gcloud run jobs update --set-secrets で別途設定する
COMMON_ENV="TZ=Asia/Tokyo"
COMMON_ENV+=",NODE_ENV=production"
COMMON_ENV+=",HEADLESS=true"
COMMON_ENV+=",GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./kangotenki.json"
COMMON_ENV+=",NOTIFICATION_WEBHOOK_URL=${NOTIFICATION_WEBHOOK_URL:-https://script.google.com/macros/s/AKfycbzkOEXAoXzLWXPLQF-eT2UnPuAXvHbucXBtv6O5b_KWTHrRaVwLXclBs3JrJs0KwKxpDQ/exec}"
COMMON_ENV+=",NOTIFICATION_TO=${NOTIFICATION_TO:-dxgroup@aozora-cg.com}"

# 転記 Job 用の環境変数
TRANSCRIPTION_ENV="${COMMON_ENV}"
TRANSCRIPTION_ENV+=",KANAMICK_URL=${KANAMICK_URL:-}"
TRANSCRIPTION_ENV+=",KANAMICK_USERNAME=${KANAMICK_USERNAME:-}"
TRANSCRIPTION_ENV+=",KANAMICK_PASSWORD=${KANAMICK_PASSWORD:-}"
TRANSCRIPTION_ENV+=",KANAMICK_STATION_NAME=訪問看護ステーションあおぞら姶良"
TRANSCRIPTION_ENV+=",KANAMICK_HAM_OFFICE_KEY=6"
TRANSCRIPTION_ENV+=",KANAMICK_HAM_OFFICE_CODE=400021814"
TRANSCRIPTION_ENV+=",RUN_LOCATIONS=姶良"
TRANSCRIPTION_ENV+=",OPENAI_API_KEY=${OPENAI_API_KEY:-}"
TRANSCRIPTION_ENV+=",SMARTHR_ACCESS_TOKEN=${SMARTHR_ACCESS_TOKEN:-}"

# 同一建物データ取得 Job 用の環境変数
BUILDING_DATA_ENV="${COMMON_ENV}"
BUILDING_DATA_ENV+=",KINTONE_BASE_URL=${KINTONE_BASE_URL:-}"
BUILDING_DATA_ENV+=",KINTONE_APP_197_TOKEN=${KINTONE_APP_197_TOKEN:-}"
BUILDING_DATA_ENV+=",GH_SHEET_ID_KAGOSHIMA=${GH_SHEET_ID_KAGOSHIMA:-}"
BUILDING_DATA_ENV+=",GH_SHEET_ID_FUKUOKA=${GH_SHEET_ID_FUKUOKA:-}"
BUILDING_DATA_ENV+=",BUILDING_MGMT_SHEET_ID=18DueDsYPsNmePiYIp9hVpD1rIWWMCyPX5SdWzXOnZBY"

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

deploy_jobs() {
  echo "=== Cloud Run Jobs デプロイ ==="

  # --- 転記 Job ---
  echo "--- ${JOB_TRANSCRIPTION} ---"
  if gcloud run jobs describe "${JOB_TRANSCRIPTION}" --project="${PROJECT_ID}" --region="${REGION}" &>/dev/null; then
    gcloud run jobs update "${JOB_TRANSCRIPTION}" \
      --project="${PROJECT_ID}" \
      --region="${REGION}" \
      --image="${IMAGE}" \
      --command="node" \
      --args="dist/scripts/run-transcription.js" \
      --set-env-vars="${TRANSCRIPTION_ENV}" \
      --task-timeout=3600s \
      --max-retries=1 \
      --memory=2Gi \
      --cpu=2 \
      --vpc-connector="${VPC_CONNECTOR}" \
      --vpc-egress=all-traffic \
      --execute-now=false
  else
    gcloud run jobs create "${JOB_TRANSCRIPTION}" \
      --project="${PROJECT_ID}" \
      --region="${REGION}" \
      --image="${IMAGE}" \
      --command="node" \
      --args="dist/scripts/run-transcription.js" \
      --set-env-vars="${TRANSCRIPTION_ENV}" \
      --task-timeout=3600s \
      --max-retries=1 \
      --memory=2Gi \
      --cpu=2 \
      --service-account="${SA}" \
      --vpc-connector="${VPC_CONNECTOR}" \
      --vpc-egress=all-traffic
  fi
  echo "--- ${JOB_TRANSCRIPTION} デプロイ完了 ---"

  # --- 同一建物データ取得 Job ---
  echo "--- ${JOB_BUILDING_DATA} ---"
  if gcloud run jobs describe "${JOB_BUILDING_DATA}" --project="${PROJECT_ID}" --region="${REGION}" &>/dev/null; then
    gcloud run jobs update "${JOB_BUILDING_DATA}" \
      --project="${PROJECT_ID}" \
      --region="${REGION}" \
      --image="${IMAGE}" \
      --command="node" \
      --args="dist/scripts/run-building-data.js" \
      --set-env-vars="${BUILDING_DATA_ENV}" \
      --task-timeout=1800s \
      --max-retries=1 \
      --memory=1Gi \
      --cpu=1 \
      --vpc-connector="${VPC_CONNECTOR}" \
      --vpc-egress=all-traffic \
      --execute-now=false
  else
    gcloud run jobs create "${JOB_BUILDING_DATA}" \
      --project="${PROJECT_ID}" \
      --region="${REGION}" \
      --image="${IMAGE}" \
      --command="node" \
      --args="dist/scripts/run-building-data.js" \
      --set-env-vars="${BUILDING_DATA_ENV}" \
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

  # --- 転記: 毎日 13:00 JST ---
  SCHED_TRANSCRIPTION="tenki-transcription-daily"
  JOB_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_TRANSCRIPTION}:run"

  if gcloud scheduler jobs describe "${SCHED_TRANSCRIPTION}" --project="${PROJECT_ID}" --location="${REGION}" &>/dev/null; then
    gcloud scheduler jobs update http "${SCHED_TRANSCRIPTION}" \
      --project="${PROJECT_ID}" \
      --location="${REGION}" \
      --schedule="0 13 * * *" \
      --time-zone="Asia/Tokyo" \
      --uri="${JOB_URI}" \
      --http-method=POST \
      --oauth-service-account-email="${SA}"
  else
    gcloud scheduler jobs create http "${SCHED_TRANSCRIPTION}" \
      --project="${PROJECT_ID}" \
      --location="${REGION}" \
      --schedule="0 13 * * *" \
      --time-zone="Asia/Tokyo" \
      --uri="${JOB_URI}" \
      --http-method=POST \
      --oauth-service-account-email="${SA}"
  fi
  echo "--- ${SCHED_TRANSCRIPTION}: 毎日 13:00 JST ---"

  # --- 同一建物データ取得: 毎月3日 6:00 JST ---
  SCHED_BUILDING_DATA="tenki-building-data-monthly"
  JOB_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_BUILDING_DATA}:run"

  if gcloud scheduler jobs describe "${SCHED_BUILDING_DATA}" --project="${PROJECT_ID}" --location="${REGION}" &>/dev/null; then
    gcloud scheduler jobs update http "${SCHED_BUILDING_DATA}" \
      --project="${PROJECT_ID}" \
      --location="${REGION}" \
      --schedule="0 6 3 * *" \
      --time-zone="Asia/Tokyo" \
      --uri="${JOB_URI}" \
      --http-method=POST \
      --oauth-service-account-email="${SA}"
  else
    gcloud scheduler jobs create http "${SCHED_BUILDING_DATA}" \
      --project="${PROJECT_ID}" \
      --location="${REGION}" \
      --schedule="0 6 3 * *" \
      --time-zone="Asia/Tokyo" \
      --uri="${JOB_URI}" \
      --http-method=POST \
      --oauth-service-account-email="${SA}"
  fi
  echo "--- ${SCHED_BUILDING_DATA}: 毎月3日 6:00 JST ---"
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
echo "確認コマンド:"
echo "  gcloud run jobs list --project=${PROJECT_ID} --region=${REGION}"
echo "  gcloud scheduler jobs list --project=${PROJECT_ID} --location=${REGION}"
echo ""
echo "手動実行:"
echo "  gcloud run jobs execute ${JOB_TRANSCRIPTION} --project=${PROJECT_ID} --region=${REGION}"
echo "  gcloud run jobs execute ${JOB_BUILDING_DATA} --project=${PROJECT_ID} --region=${REGION}"
