# Kanamick RPA Automation System - Spec

## Workflows
1. **転記 (Transcription)**: Daily - transcribe nursing visit records from Google Sheet to Kanamick
2. **削除 (Deletion)**: Delete records from Kanamick based on deletion sheet
3. **同一建物管理 (Building Management)**: Monthly - register same-building residents

## Tech Stack
- TypeScript + Node.js + Playwright + Google Sheets API + Anthropic API

## Key Feature: AI Self-Healing Selectors
- Detect selector failures → screenshot → AI analysis → new selector → validate → update → retry
