# Smart Scheduling System

Modern timetable management platform with real-time schedule updates, drag-and-drop class movement, conflict-aware validation, and persistent JSON storage.

## Why This Project

- Visual day/time timetable board (like an academic operations console)
- Drag a class card to a new slot and save instantly
- Conflict checks for faculty, batch, and room before update
- Full timetable generator for scaled demo data
- Auto-sync updates on the website

## Tech Stack

### Frontend

- HTML5
- CSS3 (custom design system, gradients, responsive layout)
- Vanilla JavaScript (ES6+)
- Browser Drag and Drop API
- Fetch API for backend calls

### Backend

- Python 3
- Flask (REST API + static frontend serving)
- Flask-CORS
- JSON file persistence (no DB required)
- pathlib, random, json (Python stdlib)

### Timetable Engine

- C++17
- STL containers and utility headers:
- vector, map, set, algorithm, random, string, iostream, fstream

### Data Layer

- data.json as source of truth for timetable entries

## Architecture

1. Frontend loads timetable from API.
2. Frontend renders grid: rows = days, columns = time slots.
3. User drags a class card into another slot.
4. Frontend calls move API.
5. Backend validates constraints and updates data.json.
6. Frontend updates instantly and keeps syncing in background.

## Algorithms Used

### 1) Timetable Generation Heuristic (Python + C++)

Approach: randomized heuristic placement with constraints.

Hard constraints:

- No faculty overlap at same day/time
- No batch overlap at same day/time
- No room overlap at same day/time

Soft constraints:

- Teacher daily workload cap (max 4 classes/day)
- Avoid 3 consecutive slots for a teacher

Generation scale:

- 5 days
- 5 time slots/day
- 10 batches
- 5 subjects
- 5 teachers
- 10 rooms
- 2 sessions per subject per batch per week

Expected volume:

- 100 classes (10 batches x 5 subjects x 2 sessions)

### 2) Reschedule Suggestion Scoring

Approach: evaluate candidate day/time/room options and rank by minimal-disruption score.

Checks:

- Faculty conflict detection
- Batch conflict detection
- Room conflict detection

Ranking idea:

- Prefer same day/time/room proximity with zero conflicts
- Return top valid alternatives

### 3) Drag-and-Drop Move Algorithm

When a class is dropped:

1. Validate target slot is legal for faculty and batch.
2. Resolve room availability:
- Keep current room if free.
- Else pick first available room at that slot.
3. Persist update to data.json.
4. Return updated class object to frontend.

## API Endpoints

### GET /api/timetable

- Returns full timetable list.

### POST /api/timetable/generate

- Generates a full timetable and saves into data.json.
- Returns generatedClasses count.

### POST /api/timetable/move

- Body: id, newDay, newTimeSlot
- Moves class after conflict checks and room resolution.
- Persists to data.json.

### POST /api/reschedule/suggest

- Returns ranked alternative slots for a class.

### POST /api/reschedule/confirm

- Confirms selected slot and persists update.
- Returns updated class and sent status metadata.

## Project Structure

- backend/app.py: Flask server, APIs, validation, persistence
- backend/data.json: timetable storage
- backend/scheduler.cpp: C++ generator engine
- backend/generate.cpp: C++ full generator variant
- frontend/index.html: UI markup
- frontend/style.css: visual system and responsive styles
- frontend/script.js: rendering, drag-drop, sync, API orchestration

## Real-Time Behavior

- Instant local UI update after successful move/confirm
- Background sync polling every 5 seconds to reflect external updates

## Run Locally (Windows)

1. Open terminal in project backend folder.
2. Install dependencies:

```bash
pip install flask flask-cors
```

3. Start backend:

```bash
python app.py
```

4. Open in browser:

```text
http://127.0.0.1:5000
```

## Build C++ Generator (Optional)

From backend folder:

```bash
g++ -std=c++17 scheduler.cpp -o scheduler.exe
g++ -std=c++17 generate.cpp -o generate.exe
```

## Troubleshooting

### python app.py exits with code 1

Cause:

- Flask packages are missing in your current Python environment.

Fix:

```bash
pip install flask flask-cors
python app.py
```

### Drag drop does not save

Check:

- Backend is running on port 5000
- Move request to /api/timetable/move returns success
- data.json is writable

## Version Snapshot

- Frontend: Custom board UI with drag-and-drop cards
- Backend: Flask APIs with conflict-safe persistence
- Generator: Scaled timetable heuristic with workload balancing

---

Built for fast scheduling operations, clean UX, and practical academic constraints.
