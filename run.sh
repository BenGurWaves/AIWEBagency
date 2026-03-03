#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# Velocity — AI Web Agency Bot Runner
# ─────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

usage() {
  echo "Usage: ./run.sh <command>"
  echo ""
  echo "Commands:"
  echo "  serve       Start the FastAPI server (website + webhooks + API)"
  echo "  pipeline    Run a single pipeline cycle (all 6 agents)"
  echo "  continuous  Run pipeline continuously (every 60 min)"
  echo "  status      Show pipeline status dashboard"
  echo "  leads       Run only the lead research agent"
  echo "  outreach    Run only the outreach agent"
  echo "  preview     Run only the design preview agent"
  echo "  sales       Run only the sales agent"
  echo "  build       Run only the web designer agent"
  echo "  success     Run only the client success agent"
  echo "  initdb      Initialize the database tables"
  echo "  test        Run tests"
  echo ""
}

case "${1:-help}" in
  serve)
    echo "Starting Velocity server on http://localhost:8000"
    python3 -m uvicorn server.app:app --host 0.0.0.0 --port 8000 --reload
    ;;
  pipeline)
    python3 -m pipeline.cli run
    ;;
  continuous)
    python3 -m pipeline.cli run --continuous
    ;;
  status)
    python3 -m pipeline.cli status
    ;;
  leads)
    python3 -m pipeline.cli stage lead_research "${@:2}"
    ;;
  outreach)
    python3 -m pipeline.cli stage outreach
    ;;
  preview)
    python3 -m pipeline.cli stage design_preview
    ;;
  sales)
    python3 -m pipeline.cli stage sales
    ;;
  build)
    python3 -m pipeline.cli stage web_design
    ;;
  success)
    python3 -m pipeline.cli stage client_success
    ;;
  initdb)
    python3 -c "
import asyncio
from models.database import engine, Base
async def init():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    print('Database initialized.')
asyncio.run(init())
"
    ;;
  test)
    python3 -m pytest tests/ -v "${@:2}"
    ;;
  help|--help|-h|*)
    usage
    ;;
esac
