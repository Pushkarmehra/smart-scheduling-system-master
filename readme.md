# Smart Scheduling System

Smart Scheduling System is a Flask + Vanilla JavaScript web app for managing timetable operations with conflict-aware class moves, teacher request workflows, and JSON-based persistence.

## Features

- Role-based access for admin, teacher, and student flows
- Timetable board served from Flask with live frontend updates
- Conflict-safe class movement with room auto-resolution
- Teacher workload guard (max 4 classes per day)
- Student shift requests with support-threshold logic
- Teacher approve/reject flow for shift requests
- Notification draft generation for batch reschedule alerts

## Tech Stack

- Backend: Python 3, Flask, Flask-CORS
- Frontend: HTML, CSS, Vanilla JavaScript
- Storage: JSON files (no database required)

## Data Files

- backend/timetable_cleaned.json: timetable source of truth
- backend/shift_requests.json: student shift request records

## API Overview

- GET /api/timetable
  - Returns the full timetable.

- GET /api/meta
  - Returns available days, slots, batches, rooms, and teachers.

- POST /api/auth/login
  - Role-based login for admin, teacher, or student.

- PUT /api/timetable/update
  - Updates a class entry with validation.

- POST /api/timetable/move
  - Moves a class to a new day/slot with conflict checks.

- POST /api/reschedule/suggest
  - Returns ranked valid alternatives for a class.

- POST /api/reschedule/confirm
  - Applies a selected reschedule option.

- POST /api/notifications/reschedule
  - Builds and returns a notification draft for affected students.

- GET /api/teacher/classes
  - Returns classes for a teacher.

- POST /api/requests
  - Creates a student shift request.

- GET /api/requests/teacher
  - Lists teacher-visible pending requests.

- POST /api/requests/<request_id>/decision
  - Teacher approves or rejects a request.

## Project Structure

- backend/app.py: Flask app, API routes, business rules, JSON I/O
- backend/timetable_cleaned.json: timetable data
- backend/shift_requests.json: shift requests data
- frontend/index.html: UI markup
- frontend/style.css: UI styles
- frontend/script.js: UI behavior and API integration

## Run Locally (Windows)

1. Open a terminal in the backend folder.
2. Install dependencies:

```bash
pip install flask flask-cors pyjwt
```

3. Start the server:

```bash
python app.py
```

4. Open the app:

```text
http://127.0.0.1:5000
```

## How To Use The App

### 1) Login flow

- Open the app in your browser.
- Select role and login:
  - Admin: use name admin
  - Teacher: use a teacher name already present in timetable data
  - Student: provide your name and a valid batch

### 2) View timetable

- The UI loads timetable and metadata from:
  - GET /api/timetable
  - GET /api/meta

### 3) Move or update a class (admin/teacher)

- Drag-and-drop or edit a class from the UI.
- Backend validates:
  - No faculty conflict at same day/time
  - No batch conflict at same day/time
  - Teacher daily workload cap
  - Room availability
- Successful updates are saved to backend/timetable_cleaned.json.

### 4) Get reschedule suggestions

- Send class details to POST /api/reschedule/suggest.
- System returns ranked valid alternatives (day, timeSlot, room).

### 5) Confirm a reschedule

- Submit selected slot to POST /api/reschedule/confirm.
- Updated class is persisted and notification content is generated.

### 6) Student shift request flow

- Student creates request with POST /api/requests.
- Request is sent to teacher only if support ratio is above 50%.
- Teacher checks requests via GET /api/requests/teacher.
- Teacher approves/rejects via POST /api/requests/<request_id>/decision.

### 7) Send reschedule notification

- Admin/teacher can call POST /api/notifications/reschedule.
- API returns a mail draft payload for the affected batch.

## Notes

- The legacy random generation endpoint is intentionally disabled.
- The app persists changes directly to backend/timetable_cleaned.json and backend/shift_requests.json.
