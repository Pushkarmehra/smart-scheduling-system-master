from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import json
from pathlib import Path
import re

app = Flask(__name__)
CORS(app)

BASE_DIR = Path(__file__).resolve().parent
TIMETABLE_FILE = BASE_DIR / 'timetable_cleaned.json'
SHIFT_REQUESTS_FILE = BASE_DIR / 'shift_requests.json'
FRONTEND_DIR = BASE_DIR.parent / 'frontend'
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
    days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
    slots = sorted({c.get('timeSlot') for c in timetable if c.get('timeSlot')})
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
    return [{'day': o['day'], 'timeSlot': o['timeSlot'], 'room': o['room']} for o in options[:6]]


def _resolve_room_for_move(timetable, class_id, day, slot, preferred_room):
    used_rooms = {
        c.get('room')
        for c in timetable
        if c.get('id') != class_id and c.get('day') == day and c.get('timeSlot') == slot
    }

    if preferred_room and preferred_room not in used_rooms:
        return preferred_room

    known_rooms = sorted({c.get('room') for c in timetable if c.get('room')})
    for room in known_rooms:
        if room not in used_rooms:
            return room

    return None


def _move_class(data, class_id, new_day, new_slot):
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
        return jsonify({'status': 'success', 'role': 'admin', 'name': 'admin'})

    if role == 'teacher':
        normalized_name = _normalize_name(name)
        canonical_teacher = next((t for t in teachers if _normalize_name(t) == normalized_name), None)
        if not canonical_teacher:
            return jsonify({'error': 'Teacher not found in timetable'}), 404
        return jsonify({'status': 'success', 'role': 'teacher', 'name': canonical_teacher})

    if role == 'student':
        if not name:
            return jsonify({'error': 'Student name is required'}), 400
        if batch not in batches:
            return jsonify({'error': 'Batch not found'}), 404
        return jsonify({'status': 'success', 'role': 'student', 'name': name, 'batch': batch})

    return jsonify({'error': 'Invalid role'}), 400


@app.route('/api/timetable/generate', methods=['POST'])
def generate_timetable():
    return jsonify({
        'error': 'Random timetable generation is disabled. The system uses timetable_cleaned.json as the source of truth.'
    }), 400

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
    req = request.json
    data = load_data()
    updated = False
    updated_course = None
    
    # Update the specific class details
    for course in data['timetable']:
        if course['id'] == req.get('id'):
            course['day'] = req.get('newDay')
            course['timeSlot'] = req.get('newTimeSlot')
            course['room'] = req.get('newRoom')
            updated = True
            updated_course = course
            break

    if not updated:
        return jsonify({'error': 'Class not found for reschedule'}), 404
            
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
    req = request.json or {}
    class_id = req.get('id')
    actor_role = (req.get('actorRole') or '').lower()
    actor_name = req.get('actorName')

    if not class_id:
        return jsonify({'error': 'Class id is required'}), 400
    if actor_role not in {'admin', 'teacher'}:
        return jsonify({'error': 'actorRole must be admin or teacher'}), 400

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
    req = request.json or {}
    class_id = req.get('id')
    new_day = req.get('newDay')
    new_slot = req.get('newTimeSlot')
    actor_role = (req.get('actorRole') or '').strip().lower()
    actor_name = (req.get('actorName') or '').strip()

    if not class_id or not new_day or not new_slot:
        return jsonify({'error': 'id, newDay and newTimeSlot are required'}), 400
    if actor_role not in {'admin', 'teacher'}:
        return jsonify({'error': 'actorRole must be admin or teacher'}), 400
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


@app.route('/api/notifications/reschedule', methods=['POST'])
def send_reschedule_notification():
    req = request.json or {}
    class_id = req.get('classId')
    recipient_email = (req.get('recipientEmail') or 'aryansuneja121@gmail.com').strip()
    actor_role = (req.get('actorRole') or '').strip().lower()
    actor_name = (req.get('actorName') or '').strip()

    if not class_id:
        return jsonify({'error': 'classId is required'}), 400
    if actor_role not in {'admin', 'teacher'}:
        return jsonify({'error': 'actorRole must be admin or teacher'}), 400
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
    req = request.json or {}
    class_id = req.get('classId')
    student_name = req.get('studentName')
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
    teacher = request.args.get('teacher', '').strip()
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
    req = request.json or {}
    decision = (req.get('decision') or '').lower()
    teacher = req.get('teacher')

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

    moved, error_message, status_code = _move_class(data, target.get('classId'), preferred_day, preferred_slot)
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