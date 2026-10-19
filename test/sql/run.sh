#!/usr/bin/env bash
# Applies the migration to a fresh database and runs the SQL acceptance tests.
set -euo pipefail
DB=${1:-js2_test}
psql -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB" -c "create database $DB"
psql -d "$DB" -v ON_ERROR_STOP=1 -q -f supabase/migrations/0001_fortville_release1.sql
psql -d "$DB" -v ON_ERROR_STOP=1 -q -f test/sql/release1.sql | grep -E "PASSED|ERROR"
