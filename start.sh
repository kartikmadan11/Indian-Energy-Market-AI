#!/bin/sh
cd "$(dirname "$0")"

# Start backend
. .venv/bin/activate

# Enable scheduler only if APScheduler is importable in this environment.
if .venv/bin/python -c "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('apscheduler') else 1)"; then
  SCHEDULER_ENABLED="${SCHEDULER_ENABLED:-true}"
else
  echo "APScheduler not available in .venv. Starting backend with scheduler disabled."
  SCHEDULER_ENABLED=false
fi

SCHEDULER_ENABLED="$SCHEDULER_ENABLED" uvicorn main:app --reload --port 8000 --app-dir backend &
BACKEND_PID=$!

# Start frontend
cd frontend
npm run dev &
FRONTEND_PID=$!

cd ..

cleanup() {
  kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
  wait $BACKEND_PID $FRONTEND_PID 2>/dev/null
}
trap cleanup EXIT INT TERM

echo ""
echo "Backend:  http://localhost:8000"
echo "Frontend: http://localhost:3000"
echo "Press Ctrl+C to stop both."
echo ""

wait
