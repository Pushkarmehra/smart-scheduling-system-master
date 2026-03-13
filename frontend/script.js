const API_BASE = 'http://127.0.0.1:5000/api';
const LIVE_SYNC_INTERVAL_MS = 5000;

let allClasses = [];
let meta = { days: [], slots: [], batches: [], rooms: [], teachers: [] };
let liveSyncTimer = null;
let draggedClassId = null;
let currentUser = { role: null, name: null, batch: null };

const DEFAULT_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const DEFAULT_SLOTS = ['09:00-10:00', '10:00-11:00', '11:00-12:00', '13:00-14:00', '14:00-15:00'];

const elements = {
    userChip: document.getElementById('user-chip'),
    classCount: document.getElementById('class-count'),
    statusChip: document.getElementById('status-chip'),
    scheduleGrid: document.getElementById('schedule-grid'),
    searchBar: document.getElementById('search-bar'),
    regenerateBtn: document.getElementById('regenerate-btn'),

    loginPanel: document.getElementById('login-panel'),
    roleSelect: document.getElementById('role-select'),
    nameInput: document.getElementById('name-input'),
    batchLoginWrap: document.getElementById('batch-login-wrap'),
    studentBatchSelect: document.getElementById('student-batch-select'),
    loginBtn: document.getElementById('login-btn'),
    logoutBtn: document.getElementById('logout-btn'),

    adminPanel: document.getElementById('admin-panel'),
    dragHint: document.getElementById('drag-hint'),
    adminEditorBox: document.getElementById('admin-editor-box'),
    adminTeacherFilter: document.getElementById('admin-teacher-filter'),
    adminClassSelect: document.getElementById('admin-class-select'),
    adminDaySelect: document.getElementById('admin-day-select'),
    adminSlotSelect: document.getElementById('admin-slot-select'),
    adminBatchSelect: document.getElementById('admin-batch-select'),
    adminTeacherSelect: document.getElementById('admin-teacher-select'),
    adminCourseInput: document.getElementById('admin-course-input'),
    adminRoomSelect: document.getElementById('admin-room-select'),
    adminSaveBtn: document.getElementById('admin-save-btn'),

    teacherPanel: document.getElementById('teacher-panel'),
    teacherRefreshBtn: document.getElementById('teacher-refresh-btn'),
    teacherClasses: document.getElementById('teacher-classes'),
    teacherClassSelect: document.getElementById('teacher-class-select'),
    teacherDaySelect: document.getElementById('teacher-day-select'),
    teacherSlotSelect: document.getElementById('teacher-slot-select'),
    teacherBatchSelect: document.getElementById('teacher-batch-select'),
    teacherSaveBtn: document.getElementById('teacher-save-btn'),
    teacherRequests: document.getElementById('teacher-requests'),

    studentPanel: document.getElementById('student-panel'),
    studentBatchView: document.getElementById('student-batch-view'),
    studentClassSelect: document.getElementById('student-class-select'),
    studentDaySelect: document.getElementById('student-day-select'),
    studentSlotSelect: document.getElementById('student-slot-select'),
    supportCountInput: document.getElementById('support-count-input'),
    classStrengthInput: document.getElementById('class-strength-input'),
    studentReasonInput: document.getElementById('student-reason-input'),
    studentRequestBtn: document.getElementById('student-request-btn'),
    studentRequestStatus: document.getElementById('student-request-status'),

    emailSection: document.getElementById('email-preview-section'),
    emailContent: document.getElementById('email-content'),
};

document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    await bootstrap();
});

function bindEvents() {
    elements.searchBar.addEventListener('input', renderCurrentView);
    elements.regenerateBtn.addEventListener('click', regenerateTimetable);

    elements.roleSelect.addEventListener('change', toggleLoginBatchField);
    elements.loginBtn.addEventListener('click', login);
    elements.logoutBtn.addEventListener('click', logout);

    elements.adminClassSelect.addEventListener('change', preloadAdminSelection);
    elements.adminTeacherFilter.addEventListener('change', () => {
        populateRoleDataViews();
        renderCurrentView();
    });
    elements.adminSaveBtn.addEventListener('click', saveAdminUpdate);

    elements.teacherRefreshBtn.addEventListener('click', refreshTeacherPanel);
    elements.teacherClassSelect.addEventListener('change', preloadTeacherSelection);
    elements.teacherSaveBtn.addEventListener('click', saveTeacherUpdate);

    elements.studentBatchView.addEventListener('change', populateStudentClasses);
    elements.studentRequestBtn.addEventListener('click', submitStudentRequest);
}

async function bootstrap() {
    await Promise.all([loadMeta(), loadTimetable()]);
    fillStaticSelects();
    renderRolePanels();
    startLiveSync();
}

async function loadMeta() {
    try {
        const response = await fetch(`${API_BASE}/meta`);
        if (!response.ok) {
            throw new Error(`Failed with status ${response.status}`);
        }
        meta = await response.json();
        fillStaticSelects();
    } catch (error) {
        console.error('Meta load failed:', error);
    }
}

async function loadTimetable() {
    setStatus('Loading timetable...', 'loading');

    try {
        const response = await fetch(`${API_BASE}/timetable`);
        if (!response.ok) {
            throw new Error(`Failed with status ${response.status}`);
        }

        allClasses = await response.json();
        renderCurrentView();
        updateMeta(allClasses);
        populateRoleDataViews();
        setStatus('Timetable synced', 'ok');
    } catch (error) {
        console.error('Error loading timetable:', error);
        setStatus('Unable to connect to backend', 'error');
        elements.scheduleGrid.innerHTML = '<div class="empty-state">Could not load timetable. Make sure backend is running on port 5000.</div>';
    }
}

function fillStaticSelects() {
    fillSelect(elements.studentBatchSelect, meta.batches || []);
    fillSelect(elements.studentBatchView, meta.batches || []);
    fillSelect(elements.adminDaySelect, getDayOrder(allClasses));
    fillSelect(elements.adminSlotSelect, getSlotOrder(allClasses));
    fillSelect(elements.adminBatchSelect, meta.batches || []);
    fillSelect(elements.adminRoomSelect, meta.rooms || []);
    fillSelect(elements.adminTeacherSelect, meta.teachers || []);
    fillTeacherFilter();

    fillSelect(elements.teacherDaySelect, getDayOrder(allClasses));
    fillSelect(elements.teacherSlotSelect, getSlotOrder(allClasses));
    fillSelect(elements.teacherBatchSelect, meta.batches || []);

    fillSelect(elements.studentDaySelect, getDayOrder(allClasses));
    fillSelect(elements.studentSlotSelect, getSlotOrder(allClasses));
}

function fillTeacherFilter() {
    const current = elements.adminTeacherFilter.value || 'ALL';
    const teachers = Array.from(new Set(meta.teachers || []));
    elements.adminTeacherFilter.innerHTML = '';

    const allOption = document.createElement('option');
    allOption.value = 'ALL';
    allOption.textContent = 'All Teachers';
    elements.adminTeacherFilter.appendChild(allOption);

    teachers.forEach((teacher) => {
        const option = document.createElement('option');
        option.value = teacher;
        option.textContent = teacher;
        elements.adminTeacherFilter.appendChild(option);
    });

    elements.adminTeacherFilter.value = teachers.includes(current) ? current : 'ALL';
}

function fillSelect(select, values, includeEmpty = false) {
    const unique = Array.from(new Set((values || []).filter(Boolean)));
    const current = select.value;

    select.innerHTML = '';
    if (includeEmpty) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Select';
        select.appendChild(opt);
    }

    unique.forEach((value) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = value;
        select.appendChild(opt);
    });

    if (current && unique.includes(current)) {
        select.value = current;
    }
}

function toggleLoginBatchField() {
    const role = elements.roleSelect.value;
    elements.batchLoginWrap.classList.toggle('hidden', role !== 'student');
}

async function login() {
    const role = elements.roleSelect.value;
    const name = elements.nameInput.value.trim();
    const batch = role === 'student' ? elements.studentBatchSelect.value : '';

    try {
        const response = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role, name, batch }),
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || 'Login failed');
        }

        currentUser = { role: result.role, name: result.name, batch: result.batch || null };
        elements.userChip.textContent = `User: ${currentUser.name} (${currentUser.role})`;
        elements.logoutBtn.classList.remove('hidden');
        renderRolePanels();
        populateRoleDataViews();
        renderCurrentView();
        setStatus('Login successful', 'ok');
    } catch (error) {
        setStatus(error.message, 'error');
    }
}

function logout() {
    currentUser = { role: null, name: null, batch: null };
    elements.userChip.textContent = 'User: Guest';
    elements.logoutBtn.classList.add('hidden');
    elements.studentRequestStatus.textContent = '';
    renderRolePanels();
    renderCurrentView();
    setStatus('Logged out', 'ok');
}

function renderRolePanels() {
    const role = currentUser.role;
    elements.adminPanel.classList.remove('hidden');
    elements.regenerateBtn.classList.toggle('hidden', role !== 'admin');
    elements.adminEditorBox.classList.toggle('hidden', role !== 'admin');

    if (role === 'admin') {
        elements.dragHint.textContent = 'Drag and drop enabled for all classes.';
    } else if (role === 'teacher') {
        elements.dragHint.textContent = 'Drag and drop enabled for your classes only.';
    } else {
        elements.dragHint.textContent = 'Login as admin or teacher to drag and drop classes across slots.';
    }

    elements.teacherPanel.classList.toggle('hidden', role !== 'teacher');
    elements.studentPanel.classList.toggle('hidden', role !== 'student');
    document.body.classList.toggle('teacher-mode', role === 'teacher');
}

function populateRoleDataViews() {
    fillStaticSelects();

    const classes = getAdminScopedClasses().sort((a, b) => Number(a.id) - Number(b.id));
    const classLabels = classes.map((c) => ({
        value: c.id,
        label: `${c.id} | ${c.course} | ${c.batch} | ${c.day} ${c.timeSlot}`,
    }));

    fillSelectFromObjects(elements.adminClassSelect, classLabels);
    preloadAdminSelection();

    if (currentUser.role === 'teacher') {
        refreshTeacherPanel();
    }

    if (currentUser.role === 'student') {
        elements.studentBatchView.value = currentUser.batch || elements.studentBatchView.value;
        populateStudentClasses();
    }
}

function fillSelectFromObjects(select, options) {
    const current = select.value;
    select.innerHTML = '';
    options.forEach((opt) => {
        const el = document.createElement('option');
        el.value = opt.value;
        el.textContent = opt.label;
        select.appendChild(el);
    });

    if (current && options.some((o) => o.value === current)) {
        select.value = current;
    }
}

function preloadAdminSelection() {
    const selectedId = elements.adminClassSelect.value;
    const cls = allClasses.find((c) => c.id === selectedId);
    if (!cls) {
        return;
    }

    elements.adminDaySelect.value = cls.day;
    elements.adminSlotSelect.value = cls.timeSlot;
    elements.adminBatchSelect.value = cls.batch;
    elements.adminTeacherSelect.value = cls.faculty;
    elements.adminCourseInput.value = cls.course;
    elements.adminRoomSelect.value = cls.room;
}

async function saveAdminUpdate() {
    const id = elements.adminClassSelect.value;
    const payload = {
        id,
        actorRole: 'admin',
        actorName: currentUser.name,
        newDay: elements.adminDaySelect.value,
        newTimeSlot: elements.adminSlotSelect.value,
        newBatch: elements.adminBatchSelect.value,
        newFaculty: elements.adminTeacherSelect.value,
        newCourse: elements.adminCourseInput.value.trim(),
        newRoom: elements.adminRoomSelect.value,
    };

    await updateClassByApi(payload, 'Admin update saved');
}

async function refreshTeacherPanel() {
    if (currentUser.role !== 'teacher') {
        return;
    }

    const teacherClasses = allClasses.filter((c) => c.faculty === currentUser.name);
    const options = teacherClasses.map((c) => ({
        value: c.id,
        label: `${c.id} | ${c.course} | ${c.batch} | ${c.day} ${c.timeSlot}`,
    }));
    fillSelectFromObjects(elements.teacherClassSelect, options);
    preloadTeacherSelection();

    elements.teacherClasses.innerHTML = teacherClasses.length
        ? teacherClasses.map((c) => `<div class="list-item">${escapeHtml(c.course)} | ${escapeHtml(c.batch)} | ${escapeHtml(c.day)} ${escapeHtml(c.timeSlot)} | ${escapeHtml(c.room)}</div>`).join('')
        : '<div class="empty-state">No classes assigned.</div>';

    try {
        const response = await fetch(`${API_BASE}/requests/teacher?teacher=${encodeURIComponent(currentUser.name)}`);
        const requests = await response.json();

        if (!response.ok) {
            throw new Error(requests.error || 'Failed to load requests');
        }

        renderTeacherRequests(requests);
    } catch (error) {
        elements.teacherRequests.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
}

function preloadTeacherSelection() {
    const cls = allClasses.find((c) => c.id === elements.teacherClassSelect.value);
    if (!cls) {
        return;
    }
    elements.teacherDaySelect.value = cls.day;
    elements.teacherSlotSelect.value = cls.timeSlot;
    elements.teacherBatchSelect.value = cls.batch;
}

async function saveTeacherUpdate() {
    const id = elements.teacherClassSelect.value;
    const payload = {
        id,
        actorRole: 'teacher',
        actorName: currentUser.name,
        newDay: elements.teacherDaySelect.value,
        newTimeSlot: elements.teacherSlotSelect.value,
        newBatch: elements.teacherBatchSelect.value,
    };

    await updateClassByApi(payload, 'Teacher update saved');
}

async function updateClassByApi(payload, successMessage) {
    try {
        setStatus('Saving update...', 'loading');
        const response = await fetch(`${API_BASE}/timetable/update`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || 'Update failed');
        }

        updateLocalClass(result.updatedClass);
        setStatus(successMessage, 'ok');
        showEmailPreview(result.updatedClass);
        populateRoleDataViews();
    } catch (error) {
        setStatus(error.message, 'error');
    }
}

function populateStudentClasses() {
    const batch = elements.studentBatchView.value;
    const list = allClasses
        .filter((c) => c.batch === batch)
        .map((c) => ({
            value: c.id,
            label: `${c.course} | ${c.day} ${c.timeSlot} | ${c.faculty}`,
        }));

    fillSelectFromObjects(elements.studentClassSelect, list);
}

async function submitStudentRequest() {
    if (currentUser.role !== 'student') {
        return;
    }

    const payload = {
        classId: elements.studentClassSelect.value,
        studentName: currentUser.name,
        preferredDay: elements.studentDaySelect.value,
        preferredTimeSlot: elements.studentSlotSelect.value,
        supportCount: Number(elements.supportCountInput.value || 0),
        classStrength: Number(elements.classStrengthInput.value || 0),
        reason: elements.studentReasonInput.value.trim(),
    };

    try {
        setStatus('Submitting request...', 'loading');
        const response = await fetch(`${API_BASE}/requests`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || 'Request submit failed');
        }

        const styleClass = result.sentToTeacher ? 'chip-ok' : 'chip-loading';
        elements.studentRequestStatus.className = `meta-chip ${styleClass}`;
        elements.studentRequestStatus.textContent = result.message;
        setStatus(result.sentToTeacher ? 'Request sent to teacher' : 'Support threshold not met', 'ok');
    } catch (error) {
        setStatus(error.message, 'error');
    }
}

function renderTeacherRequests(requests) {
    if (!requests.length) {
        elements.teacherRequests.innerHTML = '<div class="empty-state">No pending requests above threshold.</div>';
        return;
    }

    elements.teacherRequests.innerHTML = requests
        .map((req) => `
            <div class="request-card" data-request-id="${escapeHtml(req.id)}">
                <div><strong>${escapeHtml(req.course)}</strong> | ${escapeHtml(req.batch)}</div>
                <div>Current: ${escapeHtml(req.currentDay)} ${escapeHtml(req.currentTimeSlot)}</div>
                <div>Preferred: ${escapeHtml(req.preferredDay || '-')} ${escapeHtml(req.preferredTimeSlot || '-')}</div>
                <div>Support: ${escapeHtml(String(req.supportCount))}/${escapeHtml(String(req.classStrength))} (${escapeHtml(String(Math.round((req.supportRatio || 0) * 100)))}%)</div>
                <div>Reason: ${escapeHtml(req.reason || 'No reason given')}</div>
                <div class="action-row">
                    <button class="primary-btn" data-action="approve">Approve</button>
                    <button class="ghost-btn" data-action="reject">Reject</button>
                </div>
            </div>
        `)
        .join('');

    elements.teacherRequests.querySelectorAll('.request-card').forEach((card) => {
        card.querySelectorAll('button').forEach((btn) => {
            btn.addEventListener('click', () => handleTeacherDecision(card.dataset.requestId, btn.dataset.action));
        });
    });
}

async function handleTeacherDecision(requestId, action) {
    try {
        setStatus('Applying request decision...', 'loading');
        const response = await fetch(`${API_BASE}/requests/${encodeURIComponent(requestId)}/decision`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                decision: action === 'approve' ? 'approved' : 'rejected',
                teacher: currentUser.name,
            }),
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || 'Decision failed');
        }

        if (result.updatedClass) {
            updateLocalClass(result.updatedClass);
            showEmailPreview(result.updatedClass);
        }

        await refreshTeacherPanel();
        setStatus(`Request ${action}d`, 'ok');
    } catch (error) {
        setStatus(error.message, 'error');
    }
}

async function regenerateTimetable() {
    setStatus('Generating full timetable...', 'loading');
    elements.regenerateBtn.disabled = true;

    try {
        const response = await fetch(`${API_BASE}/timetable/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });

        if (!response.ok) {
            throw new Error(`Failed with status ${response.status}`);
        }

        const result = await response.json();
        await Promise.all([loadMeta(), loadTimetable()]);
        setStatus(`Generated ${result.generatedClasses} classes successfully`, 'ok');
    } catch (error) {
        console.error('Error generating timetable:', error);
        setStatus('Generation failed', 'error');
    } finally {
        elements.regenerateBtn.disabled = false;
    }
}

function renderCurrentView() {
    const classes = getFilteredClasses();
    renderScheduleGrid(classes);
}

function getFilteredClasses() {
    const scopedClasses = getRoleScopedClasses();
    const query = elements.searchBar.value.trim().toLowerCase();
    if (!query) {
        return scopedClasses;
    }

    return scopedClasses.filter((cls) => {
        const searchable = [
            cls.day,
            cls.timeSlot,
            cls.course,
            cls.faculty,
            cls.batch,
            cls.room,
        ]
            .join(' ')
            .toLowerCase();

        return searchable.includes(query);
    });
}

function getRoleScopedClasses() {
    if (currentUser.role === 'student' && currentUser.batch) {
        return allClasses.filter((cls) => cls.batch === currentUser.batch);
    }

    return getAdminScopedClasses();
}

function getAdminScopedClasses() {
    const teacherFilter = elements.adminTeacherFilter.value;
    if (teacherFilter && teacherFilter !== 'ALL') {
        return allClasses.filter((cls) => cls.faculty === teacherFilter);
    }
    return allClasses.slice();
}

function renderScheduleGrid(classes) {
    if (!classes.length) {
        elements.scheduleGrid.innerHTML = '<div class="empty-state">No classes match your search.</div>';
        return;
    }

    const days = getDayOrder(classes);
    const slots = getSlotOrder(classes);

    const classesByCell = new Map();
    classes.forEach((cls) => {
        const key = `${cls.day}||${cls.timeSlot}`;
        if (!classesByCell.has(key)) {
            classesByCell.set(key, []);
        }
        classesByCell.get(key).push(cls);
    });

    const table = document.createElement('table');
    table.className = 'schedule-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headerRow.innerHTML = `<th class="day-col">DAY / TIME</th>${slots.map((slot) => `<th>${escapeHtml(slot)}</th>`).join('')}`;
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    days.forEach((day) => {
        const tr = document.createElement('tr');
        const dayCell = document.createElement('td');
        dayCell.className = 'day-label';
        dayCell.textContent = day;
        tr.appendChild(dayCell);

        slots.forEach((slot) => {
            const td = document.createElement('td');
            td.className = 'slot-cell';
            td.dataset.day = day;
            td.dataset.slot = slot;

            td.addEventListener('dragover', onDragOverCell);
            td.addEventListener('dragleave', onDragLeaveCell);
            td.addEventListener('drop', onDropOnCell);

            const key = `${day}||${slot}`;
            const items = classesByCell.get(key) || [];

            if (!items.length) {
                const free = document.createElement('div');
                free.className = 'free-label';
                free.textContent = '- Free -';
                td.appendChild(free);
            } else {
                items
                    .sort((a, b) => a.batch.localeCompare(b.batch))
                    .forEach((cls) => td.appendChild(createClassCard(cls)));
            }

            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    elements.scheduleGrid.innerHTML = '';
    elements.scheduleGrid.appendChild(table);
}

function createClassCard(cls) {
    const card = document.createElement('article');
    card.className = 'class-card';

    const draggable = canDragClass(cls);
    const isTeacherOwnClass = isOwnedByCurrentTeacher(cls);
    card.draggable = draggable;
    card.dataset.id = cls.id;

    if (isTeacherOwnClass) {
        card.classList.add('class-card-mine');
    }

    card.innerHTML = `
        ${isTeacherOwnClass ? '<div class="mine-badge">MY CLASS</div>' : ''}
        <div class="class-title">${escapeHtml(cls.course)}</div>
        <div class="class-meta">${escapeHtml(cls.batch)} | ${escapeHtml(cls.room)}</div>
        <div class="class-meta">${escapeHtml(cls.faculty)}</div>
    `;

    if (draggable) {
        card.addEventListener('dragstart', (event) => {
            draggedClassId = cls.id;
            event.dataTransfer.setData('text/plain', cls.id);
            event.dataTransfer.effectAllowed = 'move';
            card.classList.add('dragging');
            document.body.classList.add('drag-active');
            markDroppableCells();
        });

        card.addEventListener('dragend', () => {
            draggedClassId = null;
            card.classList.remove('dragging');
            document.body.classList.remove('drag-active');
            clearDropHighlights();
            clearDroppableCells();
        });
    } else {
        card.classList.add('locked');
    }

    return card;
}

function onDragOverCell(event) {
    if (!draggedClassId) {
        return;
    }

    const currentClass = allClasses.find((cls) => cls.id === draggedClassId);
    if (!currentClass || !canDragClass(currentClass)) {
        return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    event.currentTarget.classList.add('drop-target');
}

function onDragLeaveCell(event) {
    event.currentTarget.classList.remove('drop-target');
}

async function onDropOnCell(event) {
    event.preventDefault();

    if (currentUser.role !== 'admin' && currentUser.role !== 'teacher') {
        setStatus('Drag and drop is not allowed for students', 'error');
        return;
    }

    const targetCell = event.currentTarget;
    const newDay = targetCell.dataset.day;
    const newTimeSlot = targetCell.dataset.slot;
    targetCell.classList.remove('drop-target');

    const classId = event.dataTransfer.getData('text/plain') || draggedClassId;
    if (!classId) {
        return;
    }

    const currentClass = allClasses.find((cls) => cls.id === classId);
    if (!currentClass) {
        return;
    }

    if (currentUser.role === 'teacher' && currentClass.faculty !== currentUser.name) {
        setStatus('You can drag only your own classes', 'error');
        return;
    }
    if (!canDragClass(currentClass)) {
        setStatus('You do not have permission to move this class', 'error');
        return;
    }

    if (currentClass.day === newDay && currentClass.timeSlot === newTimeSlot) {
        return;
    }

    setStatus('Saving class move...', 'loading');

    try {
        const response = await fetch(`${API_BASE}/timetable/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: classId,
                newDay,
                newTimeSlot,
                actorRole: currentUser.role,
                actorName: currentUser.name,
            }),
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || `Failed with status ${response.status}`);
        }

        updateLocalClass(result.updatedClass);
        setStatus('Class updated and saved', 'ok');
        showEmailPreview(result.updatedClass);
        populateRoleDataViews();
    } catch (error) {
        setStatus(error.message || 'Move failed', 'error');
    }
}

function canDragClass(cls) {
    if (currentUser.role === 'admin') {
        return true;
    }

    if (isOwnedByCurrentTeacher(cls)) {
        return true;
    }

    return false;
}

function isOwnedByCurrentTeacher(cls) {
    if (currentUser.role !== 'teacher') {
        return false;
    }

    const teacherName = normalizePersonName(currentUser.name);
    const facultyName = normalizePersonName(cls.faculty);
    return teacherName.length > 0 && teacherName === facultyName;
}

function normalizePersonName(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function markDroppableCells() {
    document.querySelectorAll('.slot-cell').forEach((cell) => cell.classList.add('slot-cell-active'));
}

function clearDroppableCells() {
    document.querySelectorAll('.slot-cell-active').forEach((cell) => cell.classList.remove('slot-cell-active'));
}

function clearDropHighlights() {
    document.querySelectorAll('.drop-target').forEach((node) => node.classList.remove('drop-target'));
}

function showEmailPreview(updatedClass) {
    elements.emailContent.textContent =
        `Subject: Class Schedule Updated\n\n` +
        `Dear Students,\n\n` +
        `${updatedClass.course} for ${updatedClass.batch} has been updated.\n\n` +
        `New Time: ${updatedClass.day} | ${updatedClass.timeSlot}\n` +
        `Room: ${updatedClass.room}\nFaculty: ${updatedClass.faculty}\n\n` +
        `Regards,\nAcademic Office`;

    elements.emailSection.classList.remove('hidden');
}

function updateLocalClass(updatedClass) {
    allClasses = allClasses.map((cls) => {
        if (cls.id === updatedClass.id) {
            return updatedClass;
        }
        return cls;
    });

    renderCurrentView();
    updateMeta(allClasses);
}

function updateMeta(classes) {
    elements.classCount.textContent = `Classes: ${classes.length}`;
}

function getDayOrder(classes) {
    const classDays = Array.from(new Set(classes.map((c) => c.day)));
    const ordered = DEFAULT_DAYS.filter((d) => classDays.includes(d));
    const extra = classDays.filter((d) => !ordered.includes(d));
    return [...ordered, ...extra];
}

function getSlotOrder(classes) {
    const classSlots = Array.from(new Set(classes.map((c) => c.timeSlot)));
    const ordered = DEFAULT_SLOTS.filter((s) => classSlots.includes(s));
    const extra = classSlots.filter((s) => !ordered.includes(s)).sort();
    return [...ordered, ...extra];
}

function startLiveSync() {
    if (liveSyncTimer) {
        clearInterval(liveSyncTimer);
    }

    liveSyncTimer = setInterval(async () => {
        try {
            const response = await fetch(`${API_BASE}/timetable`);
            if (!response.ok) {
                return;
            }

            const latest = await response.json();
            const hasChanged = JSON.stringify(latest) !== JSON.stringify(allClasses);
            if (!hasChanged) {
                return;
            }

            allClasses = latest;
            renderCurrentView();
            updateMeta(allClasses);
            populateRoleDataViews();
            setStatus('Live update received', 'ok');
        } catch (error) {
            console.error('Live sync failed:', error);
        }
    }, LIVE_SYNC_INTERVAL_MS);
}

function setStatus(message, state) {
    elements.statusChip.textContent = message;
    elements.statusChip.classList.remove('chip-ok', 'chip-loading', 'chip-error');

    if (state === 'loading') {
        elements.statusChip.classList.add('chip-loading');
        return;
    }

    if (state === 'error') {
        elements.statusChip.classList.add('chip-error');
        return;
    }

    elements.statusChip.classList.add('chip-ok');
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}
