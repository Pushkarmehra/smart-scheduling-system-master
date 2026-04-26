from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import json
from pathlib import Path
import re
import os
import subprocess
from datetime import datetime, timedelta, timezone
import jwt

app = Flask(__name__)
CORS(app)

BASE_DIR = Path(__file__).resolve().parent
TIMETABLE_FILE = BASE_DIR / 'timetable_cleaned.json'
SHIFT_REQUESTS_FILE = BASE_DIR / 'shift_requests.json'
FRONTEND_DIR = BASE_DIR.parent / 'frontend'
JWT_SECRET = os.environ.get('SMART_SCHED_JWT_SECRET', 'smart-scheduling-dev-secret-change-me')
JWT_ALGORITHM = 'HS256'
JWT_EXP_HOURS = 8
OLLAMA_MODEL = os.environ.get('OLLAMA_MODEL', 'llama3').strip()
DEFAULT_SLOT_ORDER = ['09:00-10:00', '10:00-11:00', '11:00-12:00', '13:00-14:00', '14:00-15:00']
DAY_MAP = {
    'MON': 'Monday',
    'TUE': 'Tuesday',
    'WED': 'Wednesday',
    'THU': 'Thursday',
    'FRI': 'Friday',
    'SAT': 'Saturday',
    'SUN': 'Sunday',
}
DAY_TO_SHORT = {v: k for k, v in DAY_MAP.items()}


def _ensure_data_shape(data):
    if 'timetable' not in data or not isinstance(data['timetable'], list):
        data['timetable'] = []
    if 'shiftRequests' not in data or not isinstance(data['shiftRequests'], list):
        data['shiftRequests'] = []
    return data


def _next_request_id(requests):
    max_id = 0
    for req in requests:
        try:
            max_id = max(max_id, int(req.get('id', 0)))
        except (TypeError, ValueError):
            continue
    return str(max_id + 1)


def _safe_ratio(numerator, denominator):
    if denominator <= 0:
        return 0.0
    return float(numerator) / float(denominator)


def _as_positive_int(value, field_name, minimum=1):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None, f'{field_name} must be an integer'

    if parsed < minimum:
        return None, f'{field_name} must be at least {minimum}'
    return parsed, None


def _as_bounded_int(value, field_name, minimum, maximum):
    parsed, error = _as_positive_int(value, field_name, minimum)
    if error:
        return None, error
    if parsed > maximum:
        return None, f'{field_name} must be at most {maximum}'
    return parsed, None


def _normalize_name(value):
    return ' '.join(str(value or '').strip().lower().split())


def _slot_index(slot):
    if slot in DEFAULT_SLOT_ORDER:
        return DEFAULT_SLOT_ORDER.index(slot)

    try:
        start = slot.split('-')[0].strip()
        hour_str, minute_str = start.split(':')
        return int(hour_str) * 60 + int(minute_str)
    except Exception:
        return 10_000


def _normalize_day(value):
    token = str(value or '').strip()
    if not token:
        return ''

    if token in DAY_TO_SHORT:
        return token

    compact = ''.join(ch for ch in token.upper() if ch.isalpha())
    if compact in DAY_MAP:
        return DAY_MAP[compact]

    title_token = token.title()
    if title_token in DAY_TO_SHORT:
        return title_token

    return token


def _day_sort_key(day_name):
    ordered_days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    day = _normalize_day(day_name)
    if day in ordered_days:
        return ordered_days.index(day)
    return len(ordered_days) + 1


def _parse_time_component(value, fallback_meridiem=None):
    cleaned = str(value or '').strip().upper().replace(' ', '')
    match = re.match(r'^(\d{1,2}):(\d{2})(AM|PM)?$', cleaned)
    if not match:
        return None, fallback_meridiem

    hour = int(match.group(1))
    minute = int(match.group(2))
    meridiem = match.group(3) or fallback_meridiem

    if meridiem == 'AM':
        hour24 = 0 if hour == 12 else hour
    elif meridiem == 'PM':
        hour24 = 12 if hour == 12 else hour + 12
    else:
        hour24 = hour

    return f'{hour24:02d}:{minute:02d}', meridiem


def _normalize_time_slot(value):
    raw = str(value or '').strip()
    if not raw or '-' not in raw:
        return raw

    left, right = raw.split('-', 1)
    start24, meridiem = _parse_time_component(left, None)
    end24, _ = _parse_time_component(right, meridiem)

    if start24 and end24:
        return f'{start24}-{end24}'

    return raw


def _infer_required_room_type(subject_name):
    token = str(subject_name or '').lower()
    if 'lab' in token or 'practical' in token or token.startswith('cl'):
        return 'lab'
    if 'lecture' in token or token.startswith('lt'):
        return 'lecture'
    return 'any'


def _room_type(room_name):
    room_token = str(room_name or '').upper()
    if 'CL' in room_token or 'LAB' in room_token:
        return 'lab'
    if 'LT' in room_token or 'LECTURE' in room_token:
        return 'lecture'
    return 'any'


def _build_llm_prompt_from_entries(entries, constraints):
    lines = []
    for index, entry in enumerate(entries, start=1):
        lines.append(
            f"{index}. Subject={entry['subjectName']}; Teacher={entry['subjectTeacher']}; "
            f"Batch={entry['batch']}; PreferredDay={entry['day']}"
        )

    food_break_slots = constraints.get('foodBreakSlotsPerDay', 1)
    additional_constraints = constraints.get('additionalConstraints') or 'None'

    return (
        'You are an academic timetable scheduling expert. Generate a complete, conflict-free timetable.\n\n'
        '=== HARD RULES (must never be violated) ===\n'
        '1. No teacher may be scheduled in two different classes at the same day and time slot.\n'
        '2. No batch may have two classes at the same day and time slot.\n'
        '3. No room may be used by two classes at the same day and time slot.\n'
        '4. You MUST decide the time slots yourself. Use realistic 1-hour blocks between 09:00 and 17:00.\n'
        '   Example slots: 09:00-10:00, 10:00-11:00, 11:00-12:00, 13:00-14:00, 14:00-15:00, 15:00-16:00, 16:00-17:00\n'
        f'5. Reserve {food_break_slots} lunch/food break slot(s) per day (12:00-13:00 must stay free).\n'
        '6. Assign rooms smartly: CL/LAB/Practical subjects → lab rooms (CL-xxx); Lectures → lecture rooms (LT-xxx).\n\n'
        + (
            f'=== ADDITIONAL CONSTRAINTS (apply these strictly) ===\n{additional_constraints}\n\n'
            if additional_constraints and additional_constraints.lower() != 'none'
            else ''
        )
        + '=== INPUT SUBJECTS (assign time slots for each) ===\n'
        + '\n'.join(lines)
        + '\n\n=== OUTPUT FORMAT ===\n'
        'Return ONLY a raw JSON array. No markdown, no explanation, no extra text.\n'
        'Each item must have exactly these fields: day, timeSlot, course, faculty, batch, room.\n'
        'Example: [{"day":"Monday","timeSlot":"09:00-10:00","course":"DSA","faculty":"Dr. Sharma","batch":"CSE-A","room":"LT-101"}]'
    )


def _extract_first_json_array(text):
    content = str(text or '')
    start = content.find('[')
    end = content.rfind(']')
    if start < 0 or end <= start:
        return None

    candidate = content[start:end + 1]
    try:
        parsed = json.loads(candidate)
        if isinstance(parsed, list):
            return parsed
    except Exception:
        return None
    return None


def _try_generate_with_ollama(entries, constraints):
    if not OLLAMA_MODEL:
        return None, 'Ollama not configured — generated using built-in optimized algorithm'

    prompt = _build_llm_prompt_from_entries(entries, constraints)
    try:
        # Use local Ollama CLI directly so no HTTP API integration is required.
        result = subprocess.run(
            ['ollama', 'run', OLLAMA_MODEL, prompt],
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
        if result.returncode != 0:
            error_out = (result.stderr or result.stdout or '').strip()
            return None, f'Ollama CLI failed: {error_out or "unknown error"}'

        llm_text = (result.stdout or '').strip()
    except FileNotFoundError:
        error_message = 'Ollama CLI not found. Install Ollama and ensure "ollama" is on PATH.'
        print(error_message)
        return None, error_message
    except subprocess.TimeoutExpired:
        error_message = 'Ollama CLI timed out while generating timetable'
        print(error_message)
        return None, error_message
    except Exception as exc:
        error_message = f'Ollama error: {exc}'
        print(error_message)
        return None, error_message

    rows = _extract_first_json_array(llm_text)
    if not rows:
        return None, 'Ollama response did not contain a valid JSON array'

    validated_rows = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        day = _normalize_day(row.get('day'))
        slot = _normalize_time_slot(row.get('timeSlot'))
        course = str(row.get('course') or '').strip()
        faculty = str(row.get('faculty') or '').strip()
        batch = str(row.get('batch') or '').strip() or 'General'
        room = str(row.get('room') or '').strip() or 'Room-101'
        if not day or not slot or not course or not faculty:
            continue
        validated_rows.append({
            'day': day,
            'timeSlot': slot,
            'course': course,
            'faculty': faculty,
            'batch': batch,
            'room': room,
        })

    if not validated_rows:
        return None, 'Ollama returned rows but none were valid timetable items'

    validated_rows.sort(key=lambda row: (_day_sort_key(row.get('day')), _slot_index(row.get('timeSlot')), row.get('batch', ''), row.get('course', '')))
    return validated_rows, None


def _pick_room_for_slot(room_pool, room_usage, day, slot, required_room_type):
    used = room_usage.get((day, slot), set())

    def compatible(room):
        if required_room_type == 'any':
            return True
        return _room_type(room) == required_room_type

    for room in room_pool:
        if room not in used and compatible(room):
            return room

    if required_room_type != 'any':
        for room in room_pool:
            if room not in used:
                return room

    return None


def _build_optimized_timetable_from_entries(entries, constraints, room_pool):
    normalized_entries = []
    for entry in entries:
        normalized_entries.append({
            'subjectName': str(entry.get('subjectName') or '').strip(),
            'subjectTeacher': str(entry.get('subjectTeacher') or '').strip(),
            'batch': str(entry.get('batch') or '').strip() or 'General',
            'day': _normalize_day(entry.get('day')),
        })

    day_order = sorted({item['day'] for item in normalized_entries if item['day']}, key=_day_sort_key)
    if not day_order:
        day_order = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

    slot_order = DEFAULT_SLOT_ORDER

    food_break_slots = constraints.get('foodBreakSlotsPerDay', 1)
    food_break_indices = set()
    if slot_order and food_break_slots > 0:
        center = len(slot_order) // 2
        food_break_indices.add(center)
        if food_break_slots == 2 and len(slot_order) > 1:
            food_break_indices.add(max(0, center - 1))

    teacher_usage = {}
    batch_usage = {}
    room_usage = {}

    generated = []

    # Prefer stable output by sorting before assignment.
    normalized_entries.sort(key=lambda x: (x['day'], x['subjectTeacher'], x['batch'], x['subjectName']))

    for item in normalized_entries:
        preferred_day = item['day'] if item['day'] in day_order else day_order[0]
        preferred_slot = slot_order[0]
        required_room_type = _infer_required_room_type(item['subjectName'])

        candidate_pairs = [(preferred_day, preferred_slot)]
        for day in day_order:
            for slot in slot_order:
                candidate_pairs.append((day, slot))

        assigned = None
        seen = set()
        for day, slot in candidate_pairs:
            key = (day, slot)
            if key in seen:
                continue
            seen.add(key)

            slot_idx = slot_order.index(slot) if slot in slot_order else 0
            if slot_idx in food_break_indices:
                continue

            teachers_here = teacher_usage.setdefault(key, set())
            batches_here = batch_usage.setdefault(key, set())

            if item['subjectTeacher'] in teachers_here:
                continue
            if item['batch'] in batches_here:
                continue

            room = _pick_room_for_slot(room_pool, room_usage, day, slot, required_room_type)
            if not room:
                continue

            teachers_here.add(item['subjectTeacher'])
            batches_here.add(item['batch'])
            room_usage.setdefault(key, set()).add(room)

            assigned = {
                'day': day,
                'timeSlot': slot,
                'course': item['subjectName'],
                'faculty': item['subjectTeacher'],
                'batch': item['batch'],
                'room': room,
            }
            break

        if not assigned:
            fallback_day = preferred_day
            fallback_slot = preferred_slot
            assigned = {
                'day': fallback_day,
                'timeSlot': fallback_slot,
                'course': item['subjectName'],
                'faculty': item['subjectTeacher'],
                'batch': item['batch'],
                'room': room_pool[0] if room_pool else 'Room-101',
            }

        generated.append(assigned)

    generated.sort(key=lambda row: (_day_sort_key(row.get('day')), _slot_index(row.get('timeSlot')), row.get('batch', ''), row.get('course', '')))
    return generated


def _normalize_generated_timetable_rows(rows):
    normalized = []
    for index, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            return None, f'Row {index} must be an object'

        day = _normalize_day(row.get('day'))
        slot = _normalize_time_slot(row.get('timeSlot'))
        course = str(row.get('course') or '').strip()
        faculty = str(row.get('faculty') or '').strip()
        batch = str(row.get('batch') or '').strip() or 'General'
        room = str(row.get('room') or '').strip() or 'Room-101'

        if not day:
            return None, f'Row {index}: day is required'
        if not slot or '-' not in slot:
            return None, f'Row {index}: timeSlot must be in HH:MM-HH:MM format'
        if not course:
            return None, f'Row {index}: course is required'
        if not faculty:
            return None, f'Row {index}: faculty is required'

        normalized.append({
            'id': str(index),
            'day': day,
            'timeSlot': slot,
            'course': course,
            'faculty': faculty,
            'batch': batch,
            'room': room,
        })

    return normalized, None


def _to_12h(value):
    try:
        hour_str, minute_str = str(value).split(':')
        hour = int(hour_str)
        minute = int(minute_str)
    except Exception:
        return str(value)

    suffix = 'AM' if hour < 12 else 'PM'
    hour12 = hour % 12
    if hour12 == 0:
        hour12 = 12
    return f'{hour12:02d}:{minute:02d} {suffix}'


def _denormalize_time_slot(value):
    token = str(value or '').strip()
    if '-' not in token:
        return token

    left, right = token.split('-', 1)
    return f'{_to_12h(left.strip())} - {_to_12h(right.strip())}'


def _normalize_timetable_rows(rows):
    normalized = []
    for idx, row in enumerate(rows or [], start=1):
        normalized.append({
            'id': str(idx),
            'day': _normalize_day(row.get('Day')),
            'timeSlot': _normalize_time_slot(row.get('Time')),
            'course': str(row.get('Subject Code') or '').strip(),
            'batch': str(row.get('Batch') or '').strip(),
            'faculty': str(row.get('Teacher') or '').strip(),
            'room': str(row.get('Venue') or '').strip(),
        })
    return normalized


def _timetable_to_cleaned_rows(timetable):
    def key_fn(item):
        try:
            return int(item.get('id', 0))
        except (TypeError, ValueError):
            return 0

    rows = []
    for item in sorted(timetable or [], key=key_fn):
        day_full = str(item.get('day') or '').strip()
        day_short = DAY_TO_SHORT.get(day_full, day_full[:3].upper())
        rows.append({
            'Day': day_short,
            'Time': _denormalize_time_slot(item.get('timeSlot')),
            'Subject Code': str(item.get('course') or '').strip(),
            'Batch': str(item.get('batch') or '').strip(),
            'Teacher': str(item.get('faculty') or '').strip(),
            'Venue': str(item.get('room') or '').strip(),
        })
    return rows


def _validate_teacher_workload(timetable, teacher, day, new_slot, exclude_class_id=None):
    teacher_slots = []
    for course in timetable:
        if exclude_class_id and course.get('id') == exclude_class_id:
            continue
        if course.get('faculty') == teacher and course.get('day') == day:
            teacher_slots.append(course.get('timeSlot'))

    teacher_slots.append(new_slot)
    unique_slots = sorted(set(teacher_slots), key=_slot_index)

    # Soft cap: keep teacher to max 4 classes/day.
    if len(unique_slots) > 4:
        return False, 'Teacher daily workload exceeded (max 4 classes/day)'

    return True, None


def _issue_token(user_payload):
    now = datetime.now(timezone.utc)
    payload = {
        **user_payload,
        'iat': int(now.timestamp()),
        'exp': int((now + timedelta(hours=JWT_EXP_HOURS)).timestamp()),
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    if isinstance(token, bytes):
        return token.decode('utf-8')
    return token


def _require_auth(allowed_roles=None):
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return None, (jsonify({'error': 'Missing Bearer token'}), 401)

    token = auth_header.split(' ', 1)[1].strip()
    if not token:
        return None, (jsonify({'error': 'Missing token value'}), 401)

    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        return None, (jsonify({'error': 'Session expired. Please login again.'}), 401)
    except jwt.InvalidTokenError:
        return None, (jsonify({'error': 'Invalid session token'}), 401)

    role = str(payload.get('role') or '').lower()
    if allowed_roles and role not in allowed_roles:
        return None, (jsonify({'error': 'Permission denied'}), 403)

    user = {
        'role': role,
        'name': payload.get('name'),
        'batch': payload.get('batch'),
    }
    return user, None


def load_data():
    timetable_rows = []
    if TIMETABLE_FILE.exists():
        with TIMETABLE_FILE.open('r', encoding='utf-8') as f:
            loaded = json.load(f)
            if isinstance(loaded, list):
                timetable_rows = loaded

    shift_requests = []
    if SHIFT_REQUESTS_FILE.exists():
        with SHIFT_REQUESTS_FILE.open('r', encoding='utf-8') as f:
            loaded = json.load(f)
            if isinstance(loaded, list):
                shift_requests = loaded

    return _ensure_data_shape({
        'timetable': _normalize_timetable_rows(timetable_rows),
        'shiftRequests': shift_requests,
    })


def save_data(data):
    safe_data = _ensure_data_shape(data)

    with TIMETABLE_FILE.open('w', encoding='utf-8') as f:
        json.dump(_timetable_to_cleaned_rows(safe_data.get('timetable', [])), f, indent=2)

    with SHIFT_REQUESTS_FILE.open('w', encoding='utf-8') as f:
        json.dump(safe_data.get('shiftRequests', []), f, indent=2)


@app.route('/', methods=['GET'])
def frontend_index():
    return send_from_directory(FRONTEND_DIR, 'index.html')


@app.route('/<path:path>', methods=['GET'])
def frontend_assets(path):
    # Allow loading CSS/JS/assets directly from the frontend folder.
    asset = FRONTEND_DIR / path
    if asset.exists() and asset.is_file():
        return send_from_directory(FRONTEND_DIR, path)
    return jsonify({'error': 'Not Found'}), 404


def _build_reschedule_options(target, timetable):
    ordered_days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    timetable_days = {c.get('day') for c in timetable if c.get('day')}
    days = [d for d in ordered_days if d in timetable_days] + [d for d in ordered_days if d not in timetable_days]

    slots = sorted({c.get('timeSlot') for c in timetable if c.get('timeSlot')}, key=_slot_index)
    rooms = sorted({c.get('room') for c in timetable if c.get('room')})

    if not slots:
        slots = ['09:00-10:00', '10:00-11:00', '11:00-12:00', '13:00-14:00', '14:00-15:00']
    if not rooms:
        rooms = [f'Room-{100 + idx}' for idx in range(1, 11)]

    options = []
    target_id = target.get('id')
    target_day = target.get('day')
    target_slot = target.get('timeSlot')
    target_room = target.get('room')
    target_faculty = target.get('faculty')
    target_batch = target.get('batch')

    def is_conflict(day, slot, room):
        for course in timetable:
            if course.get('id') == target_id:
                continue
            if course.get('day') == day and course.get('timeSlot') == slot:
                if course.get('faculty') == target_faculty:
                    return True
                if course.get('batch') == target_batch:
                    return True
                if course.get('room') == room:
                    return True
        return False

    for day in days:
        for slot in slots:
            for room in rooms:
                if day == target_day and slot == target_slot and room == target_room:
                    continue
                if is_conflict(day, slot, room):
                    continue
                score = 0
                if day != target_day:
                    score += 2
                if slot != target_slot:
                    score += 1
                if room != target_room:
                    score += 1
                options.append({
                    'day': day,
                    'timeSlot': slot,
                    'room': room,
                    'score': score,
                })

    options.sort(key=lambda x: (x['score'], x['day'], x['timeSlot'], x['room']))
    # Return a broader recommendation set so UI can offer richer day/slot choices.
    max_options = 120
    return [{'day': o['day'], 'timeSlot': o['timeSlot'], 'room': o['room']} for o in options[:max_options]]


def _resolve_room_for_move(timetable, class_id, day, slot, preferred_room):
    def room_type(room_name):
        token = str(room_name or '').upper()
        if 'CL' in token:
            return 'lab'
        if 'LT' in token:
            return 'lecture'
        return 'other'

    used_rooms = {
        c.get('room')
        for c in timetable
        if c.get('id') != class_id and c.get('day') == day and c.get('timeSlot') == slot
    }

    current = next((c for c in timetable if c.get('id') == class_id), None)
    source_type = room_type(current.get('room') if current else preferred_room)

    def is_compatible(room_name):
        if source_type == 'other':
            return True
        return room_type(room_name) == source_type

    if preferred_room and preferred_room not in used_rooms and is_compatible(preferred_room):
        return preferred_room

    known_rooms = sorted({c.get('room') for c in timetable if c.get('room')})
    for room in known_rooms:
        if room not in used_rooms and is_compatible(room):
            return room

    return None


def _move_class(data, class_id, new_day, new_slot, persist=True):
    timetable = data.get('timetable', [])
    target = next((c for c in timetable if c.get('id') == class_id), None)
    if not target:
        return None, 'Class not found', 404

    faculty = target.get('faculty')
    batch = target.get('batch')
    current_room = target.get('room')

    for course in timetable:
        if course.get('id') == class_id:
            continue
        if course.get('day') == new_day and course.get('timeSlot') == new_slot:
            if course.get('faculty') == faculty:
                return None, 'Faculty conflict at target slot', 409
            if course.get('batch') == batch:
                return None, 'Batch conflict at target slot', 409

    valid_workload, workload_message = _validate_teacher_workload(
        timetable,
        faculty,
        new_day,
        new_slot,
        exclude_class_id=class_id,
    )
    if not valid_workload:
        return None, workload_message, 409

    resolved_room = _resolve_room_for_move(timetable, class_id, new_day, new_slot, current_room)
    if not resolved_room:
        return None, 'No room available at target slot', 409

    target['day'] = new_day
    target['timeSlot'] = new_slot
    target['room'] = resolved_room
    if persist:
        save_data(data)
    return target, None, 200


def _can_move_class(actor_role, actor_name, target_class):
    if actor_role == 'admin':
        return True
    if actor_role == 'teacher' and target_class.get('faculty') == actor_name:
        return True
    return False


def _send_reschedule_email_for_class(course, recipient_email):
    subject = 'Class Rescheduling Notification'
    email_body = (
        f"Dear Students ({course.get('batch')}),\n\n"
        f"Your class for {course.get('course')} conducted by {course.get('faculty')} has been rescheduled.\n"
        f"New Time: {course.get('day')} | {course.get('timeSlot')}\n"
        f"Room: {course.get('room')}\n\n"
        "Please attend the lecture as per the updated schedule.\n\n"
        "Regards,\nAcademic Office"
    )
    print("--- BATCH EMAIL SENT ---")
    print(f"To: {recipient_email}")
    print(f"Subject: {subject}")
    print(email_body)
    return {
        'to': recipient_email,
        'subject': subject,
        'body': email_body,
    }

@app.route('/api/timetable', methods=['GET'])
def get_timetable():
    return jsonify(load_data().get('timetable', []))


@app.route('/api/meta', methods=['GET'])
def get_meta():
    data = load_data()
    timetable = data.get('timetable', [])

    days = sorted({c.get('day') for c in timetable if c.get('day')})
    slots = sorted({c.get('timeSlot') for c in timetable if c.get('timeSlot')})
    batches = sorted({c.get('batch') for c in timetable if c.get('batch')})
    rooms = sorted({c.get('room') for c in timetable if c.get('room')})
    teachers = sorted({c.get('faculty') for c in timetable if c.get('faculty')})

    return jsonify({
        'days': days,
        'slots': slots,
        'batches': batches,
        'rooms': rooms,
        'teachers': teachers,
    })


@app.route('/api/auth/login', methods=['POST'])
def login():
    req = request.json or {}
    role = (req.get('role') or '').strip().lower()
    name = (req.get('name') or '').strip()
    batch = (req.get('batch') or '').strip()

    data = load_data()
    timetable = data.get('timetable', [])
    teachers = {c.get('faculty') for c in timetable if c.get('faculty')}
    batches = {c.get('batch') for c in timetable if c.get('batch')}

    if role == 'admin':
        if name.lower() != 'admin':
            return jsonify({'error': 'Admin login requires name: admin'}), 400
        token = _issue_token({'role': 'admin', 'name': 'admin'})
        return jsonify({'status': 'success', 'role': 'admin', 'name': 'admin', 'token': token})

    if role == 'teacher':
        normalized_name = _normalize_name(name)
        canonical_teacher = next((t for t in teachers if _normalize_name(t) == normalized_name), None)
        if not canonical_teacher:
            return jsonify({'error': 'Teacher not found in timetable'}), 404
        token = _issue_token({'role': 'teacher', 'name': canonical_teacher})
        return jsonify({'status': 'success', 'role': 'teacher', 'name': canonical_teacher, 'token': token})

    if role == 'student':
        if not name:
            return jsonify({'error': 'Student name is required'}), 400
        if batch not in batches:
            return jsonify({'error': 'Batch not found'}), 404
        token = _issue_token({'role': 'student', 'name': name, 'batch': batch})
        return jsonify({'status': 'success', 'role': 'student', 'name': name, 'batch': batch, 'token': token})

    return jsonify({'error': 'Invalid role'}), 400


@app.route('/api/timetable/generate', methods=['POST'])
def generate_timetable():
    return jsonify({
        'error': 'Random timetable generation is disabled. The system uses timetable_cleaned.json as the source of truth.'
    }), 400


@app.route('/api/timetable/plan', methods=['POST'])
def create_timetable_plan():
    auth_user, auth_error = _require_auth({'admin'})
    if auth_error:
        return auth_error

    req = request.json or {}
    working_days = req.get('workingDays')
    if not isinstance(working_days, list) or len(working_days) == 0:
        return jsonify({'error': 'workingDays must be a non-empty list'}), 400

    normalized_days = [str(day).strip() for day in working_days if str(day).strip()]
    if len(normalized_days) == 0:
        return jsonify({'error': 'workingDays must contain valid day names'}), 400

    unique_days = list(dict.fromkeys(normalized_days))

    total_batches, err = _as_positive_int(req.get('totalBatches'), 'totalBatches')
    if err:
        return jsonify({'error': err}), 400

    total_teachers, err = _as_positive_int(req.get('totalTeachers'), 'totalTeachers')
    if err:
        return jsonify({'error': err}), 400

    total_rooms, err = _as_positive_int(req.get('totalRooms'), 'totalRooms')
    if err:
        return jsonify({'error': err}), 400

    slots_per_day, err = _as_positive_int(req.get('slotsPerDay'), 'slotsPerDay', minimum=3)
    if err:
        return jsonify({'error': err}), 400

    classes_per_batch_week, err = _as_positive_int(req.get('classesPerBatchPerWeek'), 'classesPerBatchPerWeek')
    if err:
        return jsonify({'error': err}), 400

    max_teacher_day, err = _as_positive_int(req.get('maxTeacherClassesPerDay'), 'maxTeacherClassesPerDay')
    if err:
        return jsonify({'error': err}), 400

    food_break_slots, err = _as_positive_int(req.get('foodBreakSlotsPerDay'), 'foodBreakSlotsPerDay')
    if err:
        return jsonify({'error': err}), 400
    if food_break_slots < 1 or food_break_slots > 2:
        return jsonify({'error': 'foodBreakSlotsPerDay must be 1 or 2'}), 400

    if slots_per_day <= food_break_slots:
        return jsonify({'error': 'slotsPerDay must be greater than foodBreakSlotsPerDay'}), 400

    additional_constraints = str(req.get('additionalConstraints') or '').strip()

    constraints = {
        'workingDays': unique_days,
        'totalBatches': total_batches,
        'totalTeachers': total_teachers,
        'totalRooms': total_rooms,
        'slotsPerDay': slots_per_day,
        'classesPerBatchPerWeek': classes_per_batch_week,
        'maxTeacherClassesPerDay': max_teacher_day,
        'foodBreakSlotsPerDay': food_break_slots,
        'additionalConstraints': additional_constraints,
    }

    ollama_prompt = (
        'Create an academic timetable with strict constraints.\n'
        f'- Working days: {", ".join(unique_days)}\n'
        f'- Total batches: {total_batches}\n'
        f'- Total teachers: {total_teachers}\n'
        f'- Total rooms: {total_rooms}\n'
        f'- Slots per day: {slots_per_day}\n'
        f'- Classes per batch per week: {classes_per_batch_week}\n'
        f'- Max teacher classes per day: {max_teacher_day}\n'
        f'- Mandatory food break slots per day: {food_break_slots} (must keep 1-2 slots for food)\n'
        '- Hard constraints: no faculty overlap, no batch overlap, no room overlap at same day/time.\n'
        '- Respect room type compatibility for class types where applicable (CL->lab, LT->lecture).\n'
        f'- Additional constraints: {additional_constraints or "None"}.\n'
        'Return a valid timetable plan and explain how each constraint is satisfied.'
    )

    return jsonify({
        'status': 'success',
        'message': 'Constraints validated. Plan is ready for Ollama-assisted generation.',
        'constraints': constraints,
        'ollamaPrompt': ollama_prompt,
        'generatedBy': auth_user.get('name'),
    })


@app.route('/api/timetable/llm/convert', methods=['POST'])
def convert_llm_rows_to_timetable():
    auth_user, auth_error = _require_auth({'admin'})
    if auth_error:
        return auth_error

    req = request.json or {}
    entries = req.get('entries')
    if not isinstance(entries, list) or not entries:
        return jsonify({'error': 'entries must be a non-empty array'}), 400

    for index, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            return jsonify({'error': f'Entry {index} must be an object'}), 400

        subject_name = str(entry.get('subjectName') or '').strip()
        subject_teacher = str(entry.get('subjectTeacher') or '').strip()
        day = _normalize_day(entry.get('day'))

        if not subject_name:
            return jsonify({'error': f'Entry {index}: subjectName is required'}), 400
        if not subject_teacher:
            return jsonify({'error': f'Entry {index}: subjectTeacher is required'}), 400
        if not day:
            return jsonify({'error': f'Entry {index}: day is required'}), 400

    constraints_req = req.get('constraints') if isinstance(req.get('constraints'), dict) else {}
    food_break_slots, error = _as_bounded_int(
        constraints_req.get('foodBreakSlotsPerDay', 1),
        'foodBreakSlotsPerDay',
        1,
        2,
    )
    if error:
        return jsonify({'error': error}), 400

    constraints = {
        'foodBreakSlotsPerDay': food_break_slots,
        'additionalConstraints': str(constraints_req.get('additionalConstraints') or '').strip(),
    }

    data = load_data()
    room_pool = sorted({item.get('room') for item in data.get('timetable', []) if item.get('room')})
    if not room_pool:
        room_pool = ['LT-101', 'LT-102', 'CL-201', 'CL-202', 'Room-301']

    llm_generated, llm_error = _try_generate_with_ollama(entries, constraints)
    mode = 'llm'
    warning = None

    if llm_generated:
        generated = llm_generated
    else:
        generated = _build_optimized_timetable_from_entries(entries, constraints, room_pool)
        mode = 'optimized-fallback'
        warning = llm_error

    prompt = _build_llm_prompt_from_entries(entries, constraints)

    return jsonify({
        'status': 'success',
        'mode': mode,
        'generatedBy': auth_user.get('name'),
        'constraints': constraints,
        'inputCount': len(entries),
        'generatedTimetable': generated,
        'ollamaPrompt': prompt,
        'warning': warning,
    })


@app.route('/api/timetable/apply-generated', methods=['POST'])
def apply_generated_timetable():
    auth_user, auth_error = _require_auth({'admin'})
    if auth_error:
        return auth_error

    req = request.json or {}
    rows = req.get('generatedTimetable')
    if not isinstance(rows, list) or not rows:
        return jsonify({'error': 'generatedTimetable must be a non-empty array'}), 400

    normalized_rows, error = _normalize_generated_timetable_rows(rows)
    if error:
        return jsonify({'error': error}), 400

    data = load_data()
    data['timetable'] = normalized_rows
    save_data(data)

    return jsonify({
        'status': 'success',
        'message': 'Generated timetable is now set as the official timetable.',
        'savedCount': len(normalized_rows),
        'updatedBy': auth_user.get('name'),
    })

@app.route('/api/reschedule/suggest', methods=['POST'])
def suggest_reschedule():
    req = request.json

    try:
        data = load_data()
        options = _build_reschedule_options(req or {}, data.get('timetable', []))
        return jsonify({'options': options})
    except Exception as e:
        print(f"Error generating suggestions: {e}")
        return jsonify({"error": "Failed to generate suggestions"}), 500

@app.route('/api/reschedule/confirm', methods=['POST'])
def confirm_reschedule():
    auth_user, auth_error = _require_auth({'admin', 'teacher'})
    if auth_error:
        return auth_error

    req = request.json or {}
    data = load_data()
    updated_course = next((course for course in data.get('timetable', []) if course.get('id') == req.get('id')), None)
    if not updated_course:
        return jsonify({'error': 'Class not found for reschedule'}), 404

    if not _can_move_class(auth_user.get('role'), auth_user.get('name'), updated_course):
        return jsonify({'error': 'Permission denied for this reschedule'}), 403

    updated_course['day'] = req.get('newDay')
    updated_course['timeSlot'] = req.get('newTimeSlot')
    updated_course['room'] = req.get('newRoom')
            
    # Save the changes permanently to timetable_cleaned.json
    save_data(data)
    
    email_body = f"""
    Subject: Class Rescheduling Notification
    Dear Students,
    Your class for {req.get('course')} conducted by {req.get('faculty')} has been rescheduled.
    New Time: {req.get('newDay')} | {req.get('newTimeSlot')}
    Room: {req.get('newRoom')}
    Please attend the lecture as per the new schedule.
    Regards, Academic Office
    """
    print("--- EMAIL SENT ---")
    print(email_body)
    
    return jsonify({
        'status': 'success',
        'message': 'Timetable updated and students notified.',
        'emailStatus': 'sent',
        'updatedClass': updated_course,
    })


@app.route('/api/timetable/update', methods=['PUT'])
def update_timetable_entry():
    auth_user, auth_error = _require_auth({'admin', 'teacher'})
    if auth_error:
        return auth_error

    req = request.json or {}
    class_id = req.get('id')
    actor_role = auth_user.get('role')
    actor_name = auth_user.get('name')

    if not class_id:
        return jsonify({'error': 'Class id is required'}), 400
    data = load_data()
    timetable = data.get('timetable', [])

    target = next((c for c in timetable if c.get('id') == class_id), None)
    if not target:
        return jsonify({'error': 'Class not found'}), 404

    if actor_role == 'teacher' and target.get('faculty') != actor_name:
        return jsonify({'error': 'Teachers can edit only their own classes'}), 403

    new_day = req.get('newDay', target.get('day'))
    new_slot = req.get('newTimeSlot', target.get('timeSlot'))
    new_batch = req.get('newBatch', target.get('batch'))
    new_course = req.get('newCourse', target.get('course'))
    new_faculty = req.get('newFaculty', target.get('faculty'))
    requested_room = req.get('newRoom', target.get('room'))

    for course in timetable:
        if course.get('id') == class_id:
            continue
        if course.get('day') == new_day and course.get('timeSlot') == new_slot:
            if course.get('batch') == new_batch:
                return jsonify({'error': 'Batch conflict at selected slot'}), 409
            if course.get('faculty') == new_faculty:
                return jsonify({'error': 'Teacher conflict at selected slot'}), 409

    valid_workload, workload_message = _validate_teacher_workload(
        timetable,
        new_faculty,
        new_day,
        new_slot,
        exclude_class_id=class_id,
    )
    if not valid_workload:
        return jsonify({'error': workload_message}), 409

    resolved_room = _resolve_room_for_move(timetable, class_id, new_day, new_slot, requested_room)
    if not resolved_room:
        return jsonify({'error': 'No room available at selected slot'}), 409

    target['day'] = new_day
    target['timeSlot'] = new_slot
    target['batch'] = new_batch
    target['course'] = new_course
    target['faculty'] = new_faculty
    target['room'] = resolved_room

    save_data(data)
    return jsonify({'status': 'success', 'updatedClass': target})


@app.route('/api/timetable/move', methods=['POST'])
def move_class():
    auth_user, auth_error = _require_auth({'admin', 'teacher'})
    if auth_error:
        return auth_error

    req = request.json or {}
    class_id = req.get('id')
    new_day = req.get('newDay')
    new_slot = req.get('newTimeSlot')
    actor_role = auth_user.get('role')
    actor_name = str(auth_user.get('name') or '').strip()

    if not class_id or not new_day or not new_slot:
        return jsonify({'error': 'id, newDay and newTimeSlot are required'}), 400
    if not actor_name:
        return jsonify({'error': 'actorName is required'}), 400

    data = load_data()
    target = next((c for c in data.get('timetable', []) if c.get('id') == class_id), None)
    if not target:
        return jsonify({'error': 'Class not found'}), 404
    if not _can_move_class(actor_role, actor_name, target):
        return jsonify({'error': 'Permission denied for this class move'}), 403

    updated_course, error_message, status_code = _move_class(data, class_id, new_day, new_slot)
    if status_code != 200:
        return jsonify({'error': error_message}), status_code

    return jsonify({
        'status': 'success',
        'message': 'Class moved successfully.',
        'updatedClass': updated_course,
    })


@app.route('/api/timetable/move/batch', methods=['POST'])
def move_classes_batch():
    auth_user, auth_error = _require_auth({'admin', 'teacher'})
    if auth_error:
        return auth_error

    req = request.json or {}
    moves = req.get('moves')
    if not isinstance(moves, list) or not moves:
        return jsonify({'error': 'moves must be a non-empty array'}), 400

    data = load_data()
    saved = []

    for move in moves:
        class_id = move.get('id')
        new_day = move.get('newDay')
        new_slot = move.get('newTimeSlot')
        if not class_id or not new_day or not new_slot:
            return jsonify({'error': 'Each move requires id, newDay and newTimeSlot'}), 400

        target = next((c for c in data.get('timetable', []) if c.get('id') == class_id), None)
        if not target:
            return jsonify({'error': f'Class not found: {class_id}'}), 404
        if not _can_move_class(auth_user.get('role'), auth_user.get('name'), target):
            return jsonify({'error': f'Permission denied for class {class_id}'}), 403

        updated_course, error_message, status_code = _move_class(data, class_id, new_day, new_slot, persist=False)
        if status_code != 200:
            return jsonify({'error': error_message, 'failedMove': move}), status_code

        saved.append(updated_course)

    save_data(data)
    return jsonify({
        'status': 'success',
        'savedCount': len(saved),
        'updatedClasses': saved,
        'timetable': data.get('timetable', []),
    })


@app.route('/api/notifications/reschedule', methods=['POST'])
def send_reschedule_notification():
    auth_user, auth_error = _require_auth({'admin', 'teacher'})
    if auth_error:
        return auth_error

    req = request.json or {}
    class_id = req.get('classId')
    recipient_email = (req.get('recipientEmail') or 'aryansuneja121@gmail.com').strip()
    actor_role = auth_user.get('role')
    actor_name = str(auth_user.get('name') or '').strip()

    if not class_id:
        return jsonify({'error': 'classId is required'}), 400
    if not actor_name:
        return jsonify({'error': 'actorName is required'}), 400

    data = load_data()
    target = next((c for c in data.get('timetable', []) if c.get('id') == class_id), None)
    if not target:
        return jsonify({'error': 'Class not found'}), 404
    if not _can_move_class(actor_role, actor_name, target):
        return jsonify({'error': 'Permission denied for sending this notification'}), 403

    mail_draft = _send_reschedule_email_for_class(target, recipient_email)
    return jsonify({
        'status': 'success',
        'message': f"Notification sent to batch {target.get('batch')}.",
        'notifiedBatch': target.get('batch'),
        'classId': class_id,
        'mailDraft': mail_draft,
    })


@app.route('/api/teacher/classes', methods=['GET'])
def teacher_classes():
    teacher = request.args.get('teacher', '').strip()
    if not teacher:
        return jsonify({'error': 'teacher query parameter is required'}), 400

    timetable = load_data().get('timetable', [])
    classes = [c for c in timetable if c.get('faculty') == teacher]
    return jsonify(classes)


@app.route('/api/requests', methods=['POST'])
def create_shift_request():
    auth_user, auth_error = _require_auth({'student'})
    if auth_error:
        return auth_error

    req = request.json or {}
    class_id = req.get('classId')
    student_name = auth_user.get('name')
    reason = req.get('reason', '').strip()
    preferred_day = req.get('preferredDay')
    preferred_slot = req.get('preferredTimeSlot')

    support_count = int(req.get('supportCount', 0) or 0)
    class_strength = int(req.get('classStrength', 0) or 0)

    if not class_id or not student_name:
        return jsonify({'error': 'classId and studentName are required'}), 400
    if class_strength <= 0:
        return jsonify({'error': 'classStrength must be greater than 0'}), 400
    if support_count < 0:
        return jsonify({'error': 'supportCount cannot be negative'}), 400

    data = load_data()
    timetable = data.get('timetable', [])
    target_class = next((c for c in timetable if c.get('id') == class_id), None)
    if not target_class:
        return jsonify({'error': 'Class not found'}), 404

    support_ratio = _safe_ratio(support_count, class_strength)
    sent_to_teacher = support_ratio > 0.5

    request_item = {
        'id': _next_request_id(data.get('shiftRequests', [])),
        'classId': class_id,
        'studentName': student_name,
        'batch': target_class.get('batch'),
        'teacher': target_class.get('faculty'),
        'course': target_class.get('course'),
        'currentDay': target_class.get('day'),
        'currentTimeSlot': target_class.get('timeSlot'),
        'preferredDay': preferred_day,
        'preferredTimeSlot': preferred_slot,
        'reason': reason,
        'supportCount': support_count,
        'classStrength': class_strength,
        'supportRatio': round(support_ratio, 3),
        'status': 'sent_to_teacher' if sent_to_teacher else 'pending_threshold',
    }

    data['shiftRequests'].append(request_item)
    save_data(data)

    return jsonify({
        'status': 'success',
        'request': request_item,
        'sentToTeacher': sent_to_teacher,
        'message': 'Request sent to teacher.' if sent_to_teacher else 'Need more than 50% support to send this request to teacher.',
    })


@app.route('/api/requests/teacher', methods=['GET'])
def teacher_requests():
    auth_user, auth_error = _require_auth({'teacher'})
    if auth_error:
        return auth_error

    teacher = str(auth_user.get('name') or '').strip()
    if not teacher:
        return jsonify({'error': 'teacher query parameter is required'}), 400

    data = load_data()
    items = [
        r for r in data.get('shiftRequests', [])
        if r.get('teacher') == teacher and r.get('status') == 'sent_to_teacher'
    ]
    return jsonify(items)


@app.route('/api/requests/<request_id>/decision', methods=['POST'])
def teacher_request_decision(request_id):
    auth_user, auth_error = _require_auth({'teacher'})
    if auth_error:
        return auth_error

    req = request.json or {}
    decision = (req.get('decision') or '').lower()
    teacher = auth_user.get('name')

    if decision not in {'approved', 'rejected'}:
        return jsonify({'error': 'decision must be approved or rejected'}), 400

    data = load_data()
    requests = data.get('shiftRequests', [])
    target = next((r for r in requests if r.get('id') == request_id), None)
    if not target:
        return jsonify({'error': 'Request not found'}), 404
    if target.get('teacher') != teacher:
        return jsonify({'error': 'Only assigned teacher can decide this request'}), 403

    if decision == 'rejected':
        target['status'] = 'rejected'
        save_data(data)
        return jsonify({'status': 'success', 'request': target})

    preferred_day = target.get('preferredDay')
    preferred_slot = target.get('preferredTimeSlot')
    if not preferred_day or not preferred_slot:
        return jsonify({'error': 'Request has no preferred day/time to apply'}), 400

    moved, error_message, status_code = _move_class(data, target.get('classId'), preferred_day, preferred_slot, persist=False)
    if status_code != 200:
        return jsonify({'error': error_message}), status_code

    target['status'] = 'approved'
    target['resolvedDay'] = moved.get('day')
    target['resolvedTimeSlot'] = moved.get('timeSlot')
    target['resolvedRoom'] = moved.get('room')
    save_data(data)

    return jsonify({'status': 'success', 'request': target, 'updatedClass': moved})

if __name__ == '__main__':
    app.run(debug=True, port=5000)