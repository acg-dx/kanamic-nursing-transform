# ============================================================
# 転記RPA — Cloud Run Job 用 Docker イメージ
#
# Playwright Chromium + Node.js ランタイム
# エントリポイントは Cloud Run Job の command で切り替え:
#   転記:           node dist/scripts/run-transcription.js
#   同一建物データ取得: node dist/scripts/run-building-data.js
# ============================================================

# --- Stage 1: Build ---
FROM node:20-slim AS builder

WORKDIR /app

# 依存関係インストール（キャッシュ効率のため先にコピー）
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# ソースコードコピー + TypeScript コンパイル
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# --- Stage 2: Runtime ---
FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

# Node.js は Playwright イメージに含まれている
# 本番依存のみインストール
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# ビルド済み JS をコピー
COPY --from=builder /app/dist/ ./dist/

# Google Service Account キー（Sheets API 用）
COPY kangotenki.json ./kangotenki.json

# タイムゾーン設定
ENV TZ=Asia/Tokyo
ENV NODE_ENV=production
ENV HEADLESS=true
ENV GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./kangotenki.json

# デフォルトは転記ワークフロー
CMD ["node", "dist/scripts/run-transcription.js"]
