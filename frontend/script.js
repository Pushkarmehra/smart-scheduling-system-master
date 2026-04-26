const API_BASE = 'http://127.0.0.1:5000/api';
const LIVE_SYNC_INTERVAL_MS = 5000;
const EMAIL_SERVICE_ID = 'service_g2195kc';
const EMAIL_TEMPLATE_ID = 'template_v437uoc';
const EMAIL_PUBLIC_KEY = '2N7Ajf083iUCh25DC';
const EMAILJS_TEMPLATE_STORAGE_KEY = 'emailjs_template_id';
const EMAILJS_PUBLIC_KEY_STORAGE_KEY = 'emailjs_public_key';
const SESSION_STORAGE_KEY = 'smart_sched_session';

let allClasses = [];
let meta = { days: [], slots: [], batches: [], rooms: [], teachers: [] };
let liveSyncTimer = null;
let draggedClassId = null;
let currentUser = { role: null, name: null, batch: null };
let authToken = null;
let pendingDragMoves = new Map();
let searchDebounceTimer = null;
let renderRafId = null;
let modalClassId = null;
let modalSelectedOption = null;
let modalUpdatedClass = null;
let modalRescheduleOptions = [];
let activeDashboardView = 'timetable';

const SUBJECT_COLORS = [
    '#2d7bc0',
    '#0f766e',
    '#0369a1',
    '#7c3aed',
    '#be185d',
    '#b45309',
    '#166534',
    '#475569',
    '#1d4ed8',
    '#15803d',
    '#7c2d12',
    '#6d28d9',
];

const DEFAULT_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DEFAULT_SLOTS = ['09:00-10:00', '10:00-11:00', '11:00-12:00', '13:00-14:00', '14:00-15:00'];

const elements = {
    appView: document.getElementById('app-view'),
    navTimetable: document.getElementById('nav-timetable'),
    navTeacher: document.getElementById('nav-teacher'),
    navRequests: document.getElementById('nav-requests'),

    userChip: document.getElementById('user-chip'),
    classCount: document.getElementById('class-count'),
    statusChip: document.getElementById('status-chip'),
    scheduleGrid: document.getElementById('schedule-grid'),
    searchBar: document.getElementById('search-bar'),
    createTimetableBtn: document.getElementById('create-timetable-btn'),
    saveDragBtn: document.getElementById('save-drag-btn'),
    pendingMovesChip: document.getElementById('pending-moves-chip'),

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
    requestsPanel: document.getElementById('requests-panel'),
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

    classDetailModal: document.getElementById('class-detail-modal'),
    classDetailClose: document.getElementById('class-detail-close'),
    detailSubject: document.getElementById('detail-subject'),
    detailTeacher: document.getElementById('detail-teacher'),
    detailVenue: document.getElementById('detail-venue'),
    detailBatch: document.getElementById('detail-batch'),
    detailDay: document.getElementById('detail-day'),
    detailTime: document.getElementById('detail-time'),
    reschedulePanel: document.getElementById('reschedule-panel'),
    rescheduleHint: document.getElementById('reschedule-hint'),
    rescheduleDayFilter: document.getElementById('reschedule-day-filter'),
    rescheduleOptions: document.getElementById('reschedule-options'),
    rescheduleRecipientEmail: document.getElementById('reschedule-recipient-email'),
    rescheduleReasonInput: document.getElementById('reschedule-reason-input'),
    confirmRescheduleBtn: document.getElementById('confirm-reschedule-btn'),
    sendRescheduleMailBtn: document.getElementById('send-reschedule-mail-btn'),
};

document.addEventListener('DOMContentLoaded', async () => {
    restoreSession();
    bindEvents();
    await bootstrap();
});

function restoreSession() {
    try {
        const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
        if (!raw) {
            return;
        }

        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.token || !parsed.user) {
            return;
        }

        authToken = parsed.token;
        currentUser = parsed.user;
        elements.userChip.textContent = `User: ${currentUser.name} (${currentUser.role})`;
        elements.logoutBtn.classList.remove('hidden');
    } catch (error) {
        console.warn('Failed to restore session:', error);
    }
}

function persistSession() {
    if (!authToken || !currentUser?.role) {
        window.localStorage.removeItem(SESSION_STORAGE_KEY);
        return;
    }

    window.localStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({ token: authToken, user: currentUser })
    );
}

async function authFetch(url, options = {}) {
    const headers = {
        ...(options.headers || {}),
    };

    if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
    }

    const response = await fetch(url, {
        ...options,
        headers,
    });

    if (response.status === 401) {
        authToken = null;
        currentUser = { role: null, name: null, batch: null };
        persistSession();
        renderRolePanels();
        refreshPendingMovesUI();
    }

    return response;
}

function refreshPendingMovesUI() {
    const pendingCount = pendingDragMoves.size;
    elements.pendingMovesChip.textContent = `Pending moves: ${pendingCount}`;

    const canSave = (currentUser.role === 'admin' || currentUser.role === 'teacher') && pendingCount > 0;
    elements.saveDragBtn.disabled = !canSave;
}

function bindEvents() {
    elements.searchBar.addEventListener('input', () => {
        if (searchDebounceTimer) {
            clearTimeout(searchDebounceTimer);
        }
        searchDebounceTimer = setTimeout(() => {
            renderCurrentView();
        }, 120);
    });
    elements.saveDragBtn.addEventListener('click', savePendingDragChanges);
    elements.createTimetableBtn.addEventListener('click', openTimetableGeneratorPage);

    elements.navTimetable.addEventListener('click', () => setActiveDashboardView('timetable'));
    elements.navTeacher.addEventListener('click', () => setActiveDashboardView('teacher'));
    elements.navRequests.addEventListener('click', () => setActiveDashboardView('requests'));

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

    elements.classDetailClose.addEventListener('click', closeClassDetails);
    elements.confirmRescheduleBtn.addEventListener('click', confirmClassRescheduleFromModal);
    elements.sendRescheduleMailBtn.addEventListener('click', sendRescheduleMailFromModal);
    elements.rescheduleDayFilter.addEventListener('change', onRescheduleDayFilterChange);
    elements.classDetailModal.addEventListener('click', (event) => {
        if (event.target === elements.classDetailModal) {
            closeClassDetails();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !elements.classDetailModal.classList.contains('hidden')) {
            closeClassDetails();
        }
    });

    // Use delegated drag/drop listeners once on the grid instead of re-binding per cell on each render.
    elements.scheduleGrid.addEventListener('dragover', onGridDragOver);
    elements.scheduleGrid.addEventListener('dragleave', onGridDragLeave);
    elements.scheduleGrid.addEventListener('drop', onGridDrop);
}

async function bootstrap() {
    await Promise.all([loadMeta(), loadTimetable()]);
    fillStaticSelects();
    renderRolePanels();
    refreshPendingMovesUI();
    startLiveSync();
}

async function loadMeta() {
    try {
        const response = await authFetch(`${API_BASE}/meta`);
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
        const response = await authFetch(`${API_BASE}/timetable`);
        if (!response.ok) {
            throw new Error(`Failed with status ${response.status}`);
        }

        allClasses = await response.json();
        pendingDragMoves.clear();
        renderCurrentView();
        updateMeta(allClasses);
        populateRoleDataViews();
        refreshPendingMovesUI();
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

function getAvailableDashboardViews(role) {
    if (role === 'teacher') {
        return ['timetable', 'teacher', 'requests'];
    }

    if (role === 'student') {
        return ['timetable', 'requests'];
    }

    if (role === 'admin') {
        return ['timetable'];
    }

    return [];
}

function setActiveDashboardView(view) {
    const role = currentUser.role;
    const available = getAvailableDashboardViews(role);
    const nextView = available.includes(view) ? view : available[0] || 'timetable';
    activeDashboardView = nextView;

    const showTimetable = nextView === 'timetable';
    const showTeacher = nextView === 'teacher' && role === 'teacher';
    const showRequestsTeacher = nextView === 'requests' && role === 'teacher';
    const showRequestsStudent = nextView === 'requests' && role === 'student';

    elements.adminPanel.classList.toggle('hidden', !showTimetable);
    elements.teacherPanel.classList.toggle('hidden', !showTeacher);
    elements.requestsPanel.classList.toggle('hidden', !showRequestsTeacher);
    elements.studentPanel.classList.toggle('hidden', !showRequestsStudent);

    elements.navTimetable.classList.toggle('active', nextView === 'timetable');
    elements.navTeacher.classList.toggle('active', nextView === 'teacher');
    elements.navRequests.classList.toggle('active', nextView === 'requests');

    if (showTeacher || showRequestsTeacher) {
        refreshTeacherPanel();
    }

    if (showRequestsStudent) {
        elements.studentBatchView.value = currentUser.batch || elements.studentBatchView.value;
        populateStudentClasses();
    }
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
        authToken = result.token || null;
        persistSession();
        elements.userChip.textContent = `User: ${currentUser.name} (${currentUser.role})`;
        elements.logoutBtn.classList.remove('hidden');
        renderRolePanels();
        populateRoleDataViews();
        renderCurrentView();
        refreshPendingMovesUI();
        setStatus('Login successful', 'ok');
    } catch (error) {
        setStatus(error.message, 'error');
    }
}

function logout() {
    currentUser = { role: null, name: null, batch: null };
    authToken = null;
    pendingDragMoves.clear();
    persistSession();
    elements.userChip.textContent = 'User: Guest';
    elements.logoutBtn.classList.add('hidden');
    elements.studentRequestStatus.textContent = '';
    renderRolePanels();
    refreshPendingMovesUI();
    renderCurrentView();
    setStatus('Logged out', 'ok');
}

function renderRolePanels() {
    const role = currentUser.role;
    const isLoggedIn = Boolean(role);
    elements.loginPanel.classList.toggle('hidden', isLoggedIn);
    elements.appView.classList.toggle('hidden', !isLoggedIn);

    if (!isLoggedIn) {
        elements.adminPanel.classList.add('hidden');
        elements.teacherPanel.classList.add('hidden');
        elements.requestsPanel.classList.add('hidden');
        elements.studentPanel.classList.add('hidden');
        document.body.classList.remove('teacher-mode');
        refreshPendingMovesUI();
        return;
    }

    elements.createTimetableBtn.classList.toggle('hidden', role !== 'admin');
    elements.saveDragBtn.classList.toggle('hidden', role !== 'admin' && role !== 'teacher');
    elements.pendingMovesChip.classList.toggle('hidden', role !== 'admin' && role !== 'teacher');
    elements.adminEditorBox.classList.toggle('hidden', role !== 'admin');

    const available = getAvailableDashboardViews(role);
    elements.navTeacher.classList.toggle('hidden', !available.includes('teacher'));
    elements.navRequests.classList.toggle('hidden', !available.includes('requests'));
    elements.navRequests.textContent = role === 'student' ? 'Student Shift Request' : 'Student Shift Requests';

    if (!available.includes(activeDashboardView)) {
        activeDashboardView = available[0] || 'timetable';
    }
    setActiveDashboardView(activeDashboardView);

    if (role === 'admin') {
        elements.dragHint.textContent = 'Drag and drop enabled for all classes.';
    } else if (role === 'teacher') {
        elements.dragHint.textContent = 'Drag and drop enabled for your classes only.';
    } else {
        elements.dragHint.textContent = 'Login as admin or teacher to drag and drop classes across slots.';
    }

    document.body.classList.toggle('teacher-mode', role === 'teacher');
    refreshPendingMovesUI();
}

function openTimetableGeneratorPage() {
    window.location.href = '/timetable-generator.html';
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

    if (currentUser.role) {
        setActiveDashboardView(activeDashboardView);
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
        const response = await authFetch(`${API_BASE}/requests/teacher`);
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
        newDay: elements.teacherDaySelect.value,
        newTimeSlot: elements.teacherSlotSelect.value,
        newBatch: elements.teacherBatchSelect.value,
    };

    await updateClassByApi(payload, 'Teacher update saved');
}

async function updateClassByApi(payload, successMessage) {
    try {
        setStatus('Saving update...', 'loading');
        const response = await authFetch(`${API_BASE}/timetable/update`, {
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
        const response = await authFetch(`${API_BASE}/requests`, {
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
        const response = await authFetch(`${API_BASE}/requests/${encodeURIComponent(requestId)}/decision`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                decision: action === 'approve' ? 'approved' : 'rejected',
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
        const response = await authFetch(`${API_BASE}/timetable/generate`, {
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
    if (renderRafId !== null) {
        return;
    }

    renderRafId = window.requestAnimationFrame(() => {
        renderRafId = null;
        renderCurrentViewNow();
    });
}

function renderCurrentViewNow() {
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
    headerRow.innerHTML = `<th class="day-col">DAY / TIME</th>${slots.map((slot) => `<th class="slot-header" data-slot="${escapeHtml(slot)}">${escapeHtml(slot)}</th>`).join('')}`;
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

function getSlotCellFromEvent(event) {
    const cell = event.target.closest('.slot-cell');
    if (!cell || !elements.scheduleGrid.contains(cell)) {
        return null;
    }
    return cell;
}

function onGridDragOver(event) {
    const cell = getSlotCellFromEvent(event);
    if (!cell) {
        return;
    }

    if (!draggedClassId) {
        return;
    }

    const currentClass = allClasses.find((cls) => cls.id === draggedClassId);
    if (!currentClass || !canDragClass(currentClass)) {
        return;
    }

    if (!cell.classList.contains('slot-cell-active')) {
        return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    cell.classList.add('drop-target');
}

function onGridDragLeave(event) {
    const cell = getSlotCellFromEvent(event);
    if (!cell) {
        return;
    }

    const related = event.relatedTarget;
    if (related && cell.contains(related)) {
        return;
    }

    cell.classList.remove('drop-target');
}

function onGridDrop(event) {
    const cell = getSlotCellFromEvent(event);
    if (!cell) {
        return;
    }
    onDropOnCell(event, cell);
}

function createClassCard(cls) {
    const card = document.createElement('article');
    card.className = 'class-card';

    const draggable = canDragClass(cls);
    const isTeacherOwnClass = isOwnedByCurrentTeacher(cls);
    card.draggable = draggable;
    card.dataset.id = cls.id;
    card.style.setProperty('--subject-color', getSubjectColor(cls.course));

    if (isTeacherOwnClass) {
        card.classList.add('class-card-mine');
    }

    const compactCourse = shortenLabel(cls.course, 16);
    const compactBatch = compactBatchLabel(cls.batch);
    const compactRoom = shortenLabel(cls.room, 10);

    card.innerHTML = `
        ${isTeacherOwnClass ? '<div class="mine-badge">MY CLASS</div>' : ''}
        <div class="class-title">${escapeHtml(compactCourse)}</div>
        <div class="class-meta">${escapeHtml(compactBatch)} | ${escapeHtml(compactRoom)}</div>
    `;

    card.title = `${cls.course} | ${cls.batch} | ${cls.room} | ${cls.faculty}`;

    if (draggable) {
        card.addEventListener('dragstart', (event) => {
            draggedClassId = cls.id;
            event.dataTransfer.setData('text/plain', cls.id);
            event.dataTransfer.effectAllowed = 'move';
            card.classList.add('dragging');
            document.body.classList.add('drag-active');
            markDroppableCells(cls);
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

    card.addEventListener('click', () => {
        openClassDetails(cls);
    });

    return card;
}

function openClassDetails(cls) {
    modalClassId = cls.id;
    modalSelectedOption = null;
    modalUpdatedClass = null;

    elements.detailSubject.textContent = String(cls.course || '-');
    elements.detailTeacher.textContent = String(cls.faculty || '-');
    elements.detailVenue.textContent = String(cls.room || '-');
    elements.detailBatch.textContent = String(cls.batch || '-');
    elements.detailDay.textContent = String(cls.day || '-');
    elements.detailTime.textContent = String(cls.timeSlot || '-');

    const canReschedule = currentUser.role === 'admin' || isOwnedByCurrentTeacher(cls);
    elements.reschedulePanel.classList.toggle('hidden', !canReschedule);

    if (canReschedule) {
        renderRescheduleOptionsLoading('Loading valid slots...');
        loadRescheduleOptionsForClass(cls);
    }

    elements.classDetailModal.classList.remove('hidden');
    elements.classDetailModal.setAttribute('aria-hidden', 'false');
}

function closeClassDetails() {
    elements.classDetailModal.classList.add('hidden');
    elements.classDetailModal.setAttribute('aria-hidden', 'true');
    modalClassId = null;
    modalSelectedOption = null;
    modalUpdatedClass = null;
    modalRescheduleOptions = [];
    if (elements.rescheduleReasonInput) {
        elements.rescheduleReasonInput.value = '';
    }
}

function getModalClass() {
    if (!modalClassId) {
        return null;
    }
    return allClasses.find((c) => c.id === modalClassId) || null;
}

function renderRescheduleOptionsLoading(message) {
    elements.rescheduleHint.textContent = message;
    elements.rescheduleOptions.innerHTML = '<div class="suggestion-loading">Please wait...</div>';
    elements.rescheduleDayFilter.innerHTML = '<option value="">Loading days...</option>';
    elements.rescheduleDayFilter.disabled = true;
    elements.confirmRescheduleBtn.disabled = true;
    elements.sendRescheduleMailBtn.disabled = true;
}

function getVenueTypeFromRoom(roomName) {
    const room = String(roomName || '').toUpperCase();
    if (room.includes('CL')) {
        return 'lab';
    }
    if (room.includes('LT')) {
        return 'lecture';
    }
    return 'other';
}

function isRoomTypeCompatible(sourceRoom, candidateRoom) {
    const sourceType = getVenueTypeFromRoom(sourceRoom);
    if (sourceType === 'other') {
        return true;
    }
    return getVenueTypeFromRoom(candidateRoom) === sourceType;
}

function renderRescheduleDayFilter(options) {
    const daySet = new Set(options.map((opt) => opt.day).filter(Boolean));
    const orderedDays = DEFAULT_DAYS.filter((day) => daySet.has(day));
    const extraDays = Array.from(daySet).filter((day) => !orderedDays.includes(day));
    const days = [...orderedDays, ...extraDays];

    elements.rescheduleDayFilter.innerHTML = '';
    days.forEach((day) => {
        const option = document.createElement('option');
        option.value = day;
        option.textContent = day;
        elements.rescheduleDayFilter.appendChild(option);
    });

    elements.rescheduleDayFilter.disabled = days.length === 0;
}

function renderRescheduleSlotsForSelectedDay() {
    const selectedDay = elements.rescheduleDayFilter.value;
    const options = modalRescheduleOptions.filter((opt) => opt.day === selectedDay);

    if (!options.length) {
        elements.rescheduleHint.textContent = 'No valid slots found for the selected day.';
        elements.rescheduleOptions.innerHTML = '<div class="suggestion-loading">No options available.</div>';
        elements.confirmRescheduleBtn.disabled = true;
        elements.sendRescheduleMailBtn.disabled = true;
        return;
    }

    elements.rescheduleHint.textContent = `Choose a slot for ${selectedDay}, then confirm reschedule.`;
    elements.rescheduleOptions.innerHTML = options
        .map((opt, index) => `
            <button
                type="button"
                class="suggestion-card"
                data-index="${index}"
                data-day="${escapeHtml(opt.day)}"
                data-slot="${escapeHtml(opt.timeSlot)}"
                data-room="${escapeHtml(opt.room)}"
            >
                <span class="s-day">${escapeHtml(opt.day)}</span>
                <span class="s-slot">${escapeHtml(opt.timeSlot)}</span>
                <span class="s-room">${escapeHtml(opt.room)}</span>
            </button>
        `)
        .join('');

    elements.rescheduleOptions.querySelectorAll('.suggestion-card').forEach((btn) => {
        btn.addEventListener('click', () => {
            elements.rescheduleOptions
                .querySelectorAll('.suggestion-card')
                .forEach((node) => node.classList.remove('is-selected'));
            btn.classList.add('is-selected');

            modalSelectedOption = {
                day: btn.dataset.day,
                timeSlot: btn.dataset.slot,
                room: btn.dataset.room,
            };

            elements.confirmRescheduleBtn.disabled = false;
            elements.sendRescheduleMailBtn.disabled = true;
            elements.rescheduleHint.textContent = `Selected: ${modalSelectedOption.day} | ${modalSelectedOption.timeSlot} | ${modalSelectedOption.room}`;
        });
    });

    elements.confirmRescheduleBtn.disabled = true;
    elements.sendRescheduleMailBtn.disabled = true;
}

function renderRescheduleOptionsList(options, sourceClass) {
    modalSelectedOption = null;

    const compatibleOptions = (options || []).filter((opt) =>
        isRoomTypeCompatible(sourceClass?.room, opt.room)
    );

    modalRescheduleOptions = compatibleOptions;
    renderRescheduleDayFilter(compatibleOptions);

    if (!compatibleOptions.length) {
        elements.rescheduleHint.textContent = 'No valid slots found after room-type filter (CL->CL, LT->LT).';
        elements.rescheduleOptions.innerHTML = '<div class="suggestion-loading">No compatible options.</div>';
        elements.confirmRescheduleBtn.disabled = true;
        elements.sendRescheduleMailBtn.disabled = true;
        return;
    }

    if (!elements.rescheduleDayFilter.value) {
        elements.rescheduleDayFilter.value = compatibleOptions[0].day;
    }

    renderRescheduleSlotsForSelectedDay();
}

function onRescheduleDayFilterChange() {
    modalSelectedOption = null;
    elements.confirmRescheduleBtn.disabled = true;
    elements.sendRescheduleMailBtn.disabled = true;
    renderRescheduleSlotsForSelectedDay();
}

async function loadRescheduleOptionsForClass(cls) {
    try {
        const response = await authFetch(`${API_BASE}/reschedule/suggest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: cls.id,
                day: cls.day,
                timeSlot: cls.timeSlot,
                room: cls.room,
                faculty: cls.faculty,
                batch: cls.batch,
                course: cls.course,
            }),
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || 'Failed to fetch reschedule options');
        }

        renderRescheduleOptionsList(result.options || [], cls);
    } catch (error) {
        elements.rescheduleHint.textContent = error.message || 'Unable to load options';
        elements.rescheduleOptions.innerHTML = '<div class="suggestion-loading">Could not load options.</div>';
        elements.rescheduleDayFilter.innerHTML = '<option value="">Unavailable</option>';
        elements.rescheduleDayFilter.disabled = true;
        elements.confirmRescheduleBtn.disabled = true;
        elements.sendRescheduleMailBtn.disabled = true;
    }
}

async function confirmClassRescheduleFromModal() {
    const cls = getModalClass();
    if (!cls || !modalSelectedOption) {
        setStatus('Select a slot first', 'error');
        return;
    }

    try {
        setStatus('Confirming reschedule...', 'loading');
        elements.confirmRescheduleBtn.disabled = true;

        const response = await authFetch(`${API_BASE}/reschedule/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: cls.id,
                course: cls.course,
                faculty: cls.faculty,
                newDay: modalSelectedOption.day,
                newTimeSlot: modalSelectedOption.timeSlot,
                newRoom: modalSelectedOption.room,
            }),
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || 'Reschedule failed');
        }

        modalUpdatedClass = result.updatedClass;
        updateLocalClass(result.updatedClass);
        showEmailPreview(result.updatedClass);

        elements.detailDay.textContent = String(result.updatedClass.day || '-');
        elements.detailTime.textContent = String(result.updatedClass.timeSlot || '-');
        elements.detailVenue.textContent = String(result.updatedClass.room || '-');

        elements.rescheduleHint.textContent = 'Reschedule saved. You can now send the notification mail.';
        elements.sendRescheduleMailBtn.disabled = false;
        setStatus('Class rescheduled successfully', 'ok');
    } catch (error) {
        elements.confirmRescheduleBtn.disabled = false;
        setStatus(error.message || 'Reschedule failed', 'error');
    }
}

async function sendRescheduleMailFromModal() {
    const cls = modalUpdatedClass || getModalClass();
    if (!cls) {
        setStatus('No class selected for sending mail', 'error');
        return;
    }

    const recipientEmail = elements.rescheduleRecipientEmail.value.trim();
    const rescheduleReason = (elements.rescheduleReasonInput?.value || '').trim();
    if (!recipientEmail) {
        setStatus('Recipient email is required', 'error');
        return;
    }

    try {
        setStatus('Sending mail notification...', 'loading');
        elements.sendRescheduleMailBtn.disabled = true;

        const response = await authFetch(`${API_BASE}/notifications/reschedule`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                classId: cls.id,
                recipientEmail,
            }),
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || 'Notification API failed');
        }

        const mailDraftWithReason = addReasonToMailDraft(result.mailDraft, rescheduleReason);
        const sent = await sendUsingConfiguredEmailService(mailDraftWithReason, cls);
        if (!sent) {
            throw new Error('Mail service send failed. Verify EmailJS configuration.');
        }

        setStatus('Mail sent successfully', 'ok');
        window.alert(`Mail sent to ${result.mailDraft?.to || recipientEmail}.`);
    } catch (error) {
        elements.sendRescheduleMailBtn.disabled = false;
        setStatus(error.message || 'Failed to send mail', 'error');
    }
}

function addReasonToMailDraft(mailDraft, reasonText) {
    if (!mailDraft) {
        return mailDraft;
    }

    if (!reasonText) {
        return mailDraft;
    }

    return {
        ...mailDraft,
        body: `${mailDraft.body || ''}\n\nReason for reschedule:\n${reasonText}`,
    };
}

function getSubjectColor(course) {
    const key = String(course || '').trim().toUpperCase();
    if (!key) {
        return '#2d7bc0';
    }

    let hash = 0;
    for (let i = 0; i < key.length; i += 1) {
        hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }

    return SUBJECT_COLORS[hash % SUBJECT_COLORS.length];
}

function shortenLabel(value, maxLength) {
    const text = String(value || '').trim();
    if (!text) {
        return '-';
    }
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function compactBatchLabel(batchValue) {
    const text = String(batchValue || '').trim();
    if (!text) {
        return '-';
    }

    const parts = text
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);

    if (parts.length <= 1) {
        return shortenLabel(parts[0] || text, 18);
    }

    return `${shortenLabel(parts[0], 10)} +${parts.length - 1}`;
}

async function onDropOnCell(event, targetCell) {
    event.preventDefault();

    if (currentUser.role !== 'admin' && currentUser.role !== 'teacher') {
        setStatus('Drag and drop is not allowed for students', 'error');
        return;
    }

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

    const blockedReason = getDropBlockReason(currentClass, newDay, newTimeSlot);
    if (blockedReason) {
        setStatus(blockedReason, 'error');
        return;
    }

    if (currentClass.day === newDay && currentClass.timeSlot === newTimeSlot) {
        return;
    }

    const staged = {
        ...currentClass,
        day: newDay,
        timeSlot: newTimeSlot,
    };

    allClasses = allClasses.map((cls) => (cls.id === classId ? staged : cls));
    pendingDragMoves.set(classId, {
        id: classId,
        newDay,
        newTimeSlot,
    });

    refreshPendingMovesUI();
    renderCurrentView();
    populateRoleDataViews();
    setStatus('Move staged locally. Click Save Drag Changes to persist.', 'loading');
}

async function savePendingDragChanges() {
    if (!(currentUser.role === 'admin' || currentUser.role === 'teacher')) {
        setStatus('Only admin or teacher can save drag changes', 'error');
        return;
    }

    const moves = Array.from(pendingDragMoves.values());
    if (!moves.length) {
        setStatus('No pending drag changes', 'ok');
        return;
    }

    try {
        setStatus(`Saving ${moves.length} drag changes...`, 'loading');
        elements.saveDragBtn.disabled = true;

        const response = await authFetch(`${API_BASE}/timetable/move/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ moves }),
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || 'Failed to save drag changes');
        }

        allClasses = result.timetable || allClasses;
        pendingDragMoves.clear();
        refreshPendingMovesUI();
        renderCurrentView();
        populateRoleDataViews();
        setStatus(`Saved ${result.savedCount || 0} drag changes`, 'ok');
    } catch (error) {
        setStatus(error.message || 'Failed to save drag changes', 'error');
        refreshPendingMovesUI();
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

function getEmailServiceConfig() {
    const templateId = EMAIL_TEMPLATE_ID;
    const publicKey = EMAIL_PUBLIC_KEY;
    return { templateId, publicKey };
}

function askAndStoreEmailServiceConfig() {
    return { templateId: EMAIL_TEMPLATE_ID, publicKey: EMAIL_PUBLIC_KEY };
}

async function sendUsingConfiguredEmailService(mailDraft, cls) {
    if (!mailDraft || !mailDraft.to || !mailDraft.subject || !mailDraft.body) {
        return false;
    }

    if (!window.emailjs || !window.emailjs.send) {
        return false;
    }

    let { templateId, publicKey } = getEmailServiceConfig();
    if (!templateId || !publicKey) {
        const configured = askAndStoreEmailServiceConfig();
        if (!configured) {
            return false;
        }
        templateId = configured.templateId;
        publicKey = configured.publicKey;
    }

    const templateParams = {
        email: mailDraft.to,
        to_email: mailDraft.to,
        subject: mailDraft.subject,
        message: mailDraft.body,
        batch: cls.batch,
        course: cls.course,
        teacher: cls.faculty,
        day: cls.day,
        time_of_class: cls.timeSlot,
        venue: cls.room,
    };

    try {
        await window.emailjs.send(EMAIL_SERVICE_ID, templateId, templateParams, { publicKey });
        return true;
    } catch (error) {
        console.error('Email service send failed:', error);
        return false;
    }
}

function getDropBlockReason(cls, newDay, newTimeSlot) {
    if (!cls) {
        return 'Class data not found';
    }

    if (cls.day === newDay && cls.timeSlot === newTimeSlot) {
        return 'Class is already scheduled in this slot';
    }

    const classId = cls.id;
    const faculty = cls.faculty;
    const batch = cls.batch;

    for (const other of allClasses) {
        if (other.id === classId) {
            continue;
        }
        if (other.day !== newDay || other.timeSlot !== newTimeSlot) {
            continue;
        }
        if (other.faculty === faculty) {
            return 'Faculty conflict at target slot';
        }
        if (other.batch === batch) {
            return 'Batch conflict at target slot';
        }
    }

    const teacherSlots = new Set();
    for (const other of allClasses) {
        if (other.id === classId) {
            continue;
        }
        if (other.faculty === faculty && other.day === newDay) {
            teacherSlots.add(other.timeSlot);
        }
    }
    teacherSlots.add(newTimeSlot);

    if (teacherSlots.size > 4) {
        return 'Teacher daily workload exceeded (max 4 classes/day)';
    }

    return null;
}

function canDropClassInCell(cls, day, slot) {
    return !getDropBlockReason(cls, day, slot);
}

function markDroppableCells(sourceClass) {
    const slotCells = document.querySelectorAll('.slot-cell');
    const activeSlots = new Set();

    slotCells.forEach((cell) => {
        cell.classList.remove('slot-cell-active', 'slot-cell-blocked', 'slot-column-active');

        const day = cell.dataset.day;
        const slot = cell.dataset.slot;
        const allowed = canDropClassInCell(sourceClass, day, slot);

        if (allowed) {
            cell.classList.add('slot-cell-active');
            activeSlots.add(slot);
        } else {
            cell.classList.add('slot-cell-blocked');
        }
    });

    document.querySelectorAll('.slot-header').forEach((header) => {
        header.classList.remove('slot-header-active');
        if (activeSlots.has(header.dataset.slot)) {
            header.classList.add('slot-header-active');
        }
    });

    slotCells.forEach((cell) => {
        if (activeSlots.has(cell.dataset.slot)) {
            cell.classList.add('slot-column-active');
        }
    });
}

function clearDroppableCells() {
    document
        .querySelectorAll('.slot-cell-active, .slot-cell-blocked, .slot-column-active')
        .forEach((cell) => cell.classList.remove('slot-cell-active', 'slot-cell-blocked', 'slot-column-active'));

    document
        .querySelectorAll('.slot-header-active')
        .forEach((header) => header.classList.remove('slot-header-active'));
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

    if (pendingDragMoves.has(updatedClass.id)) {
        pendingDragMoves.delete(updatedClass.id);
        refreshPendingMovesUI();
    }

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
    const extra = classSlots
        .filter((s) => !ordered.includes(s))
        .sort((a, b) => parseSlotStartMinutes(a) - parseSlotStartMinutes(b));
    return [...ordered, ...extra];
}

function parseSlotStartMinutes(slot) {
    const token = String(slot || '').trim();
    if (!token.includes('-')) {
        return Number.MAX_SAFE_INTEGER;
    }

    const [start] = token.split('-');
    const match = start.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
        return Number.MAX_SAFE_INTEGER;
    }

    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (Number.isNaN(hour) || Number.isNaN(minute)) {
        return Number.MAX_SAFE_INTEGER;
    }

    return hour * 60 + minute;
}

function startLiveSync() {
    if (liveSyncTimer) {
        clearInterval(liveSyncTimer);
    }

    liveSyncTimer = setInterval(async () => {
        try {
            if (pendingDragMoves.size > 0) {
                return;
            }

            const response = await authFetch(`${API_BASE}/timetable`);
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
