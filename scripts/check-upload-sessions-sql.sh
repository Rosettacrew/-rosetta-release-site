#!/usr/bin/env bash
# LOCAL-ONLY: applies the Issue #91 migration (twice, for idempotency), the optional cron
# migration (pg_cron absent -> notice + skip), and the rollback to a THROWAWAY vanilla
# Postgres with stubbed Supabase schemas. Never point this at a Supabase project.
# Usage: PGHOST=/tmp PGPORT=54391 PGUSER=postgres scripts/check-upload-sessions-sql.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB="issue91_check_$$"
case "${PGHOST:-}" in *supabase*|*pooler*) echo "Refusing: PGHOST looks like Supabase." >&2; exit 2;; esac
createdb "$DB"
trap 'dropdb --if-exists "$DB" >/dev/null 2>&1 || true' EXIT
run() { psql -X -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }
run -f scripts/sql/issue91-local-stub.sql
run -f supabase/migrations/20260925_issue91_upload_sessions.sql
run -f supabase/migrations/20260925_issue91_upload_sessions.sql   # idempotent re-run
run -f supabase/migrations/20260925_issue91_upload_sessions_cron_optional.sql
run -f scripts/sql/issue91-local-assert.sql
# rollback refuses while a beat points at a chunked manifest
run -c "insert into public.beatbay_beats (status, full_audio_path) values ('draft', 'uploads/00000000-0000-4000-8000-000000000000/manifest.json');"
if run -f supabase/rollback/20260925_issue91_upload_sessions_rollback.sql 2>/dev/null; then echo "rollback guard missing" >&2; exit 1; fi
run -c "update public.beatbay_beats set full_audio_path = null;"
run -f supabase/rollback/20260925_issue91_upload_sessions_rollback.sql
run -tA -c "select case when to_regclass('public.upload_sessions') is null and not (select allowed_mime_types @> array['video/mp4'] from storage.buckets where id = 'release-private') then 'rollback ok' else 'rollback FAILED' end;" | grep -qx "rollback ok"
echo "Issue #91 SQL checks passed (local throwaway Postgres)."
