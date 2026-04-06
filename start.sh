#!/bin/sh
cd "$(dirname "$0")"

# Start backend
source .venv/bin/activate
SCHEDULER_ENABLED=true uvicorn backend.main:app --reload --port 8000 &
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
