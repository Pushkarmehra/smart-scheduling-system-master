const API_BASE = 'http://127.0.0.1:5000/api';
const SESSION_STORAGE_KEY = 'smart_sched_session';
const DAY_OPTIONS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const elements = {
    tableBody: document.getElementById('subject-table-body'),
    addRowBtn: document.getElementById('add-row-btn'),
    generateBtn: document.getElementById('generate-table-btn'),
    backBtn: document.getElementById('back-dashboard-btn'),
    foodBreakSlots: document.getElementById('food-break-slots'),
    additionalConstraints: document.getElementById('additional-constraints'),
    status: document.getElementById('generator-status'),
    llmPromptOutput: document.getElementById('llm-prompt-output'),
    generatedPreviewSection: document.getElementById('generated-preview-section'),
    generatedPreviewBody: document.getElementById('generated-preview-body'),
    applyGeneratedBtn: document.getElementById('apply-generated-btn'),
    clearGeneratedBtn: document.getElementById('clear-generated-btn'),
};

let authToken = null;
let role = null;
let latestGeneratedRows = [];

const defaultRow = {
    subjectName: '',
    subjectTeacher: '',
    batch: '',
    day: 'Monday',
    time: '09:00-10:00',
};

document.addEventListener('DOMContentLoaded', async () => {
    if (!restoreSession()) {
        window.location.href = '/';
        return;
    }

    if (role !== 'admin') {
        setStatus('Only admin can access timetable generation', 'error');
        window.setTimeout(() => {
            window.location.href = '/';
        }, 900);
        return;
    }

    bindEvents();
    for (let index = 0; index < 6; index += 1) {
        addSubjectRow();
    }
    setStatus('Enter subject details and generate the timetable', 'ok');
});

function restoreSession() {
    try {
        const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
        if (!raw) {
            return false;
        }

        const parsed = JSON.parse(raw);
        authToken = parsed?.token || null;
        role = parsed?.user?.role || null;
        return Boolean(authToken && role);
    } catch (error) {
        console.warn('Failed to restore session', error);
        return false;
    }
}

function bindEvents() {
    elements.backBtn.addEventListener('click', () => {
        window.location.href = '/';
    });

    elements.addRowBtn.addEventListener('click', addSubjectRow);
    elements.generateBtn.addEventListener('click', generateTimetableFromRows);
    elements.applyGeneratedBtn.addEventListener('click', applyGeneratedTimetableAsOriginal);
    elements.clearGeneratedBtn.addEventListener('click', clearGeneratedPreview);

    elements.tableBody.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }
        if (target.dataset.action === 'remove-row') {
            const row = target.closest('tr');
            if (row) {
                row.remove();
            }
            if (!elements.tableBody.children.length) {
                addSubjectRow();
            }
        }
    });
}

function createDayOptions(selectedDay) {
    return DAY_OPTIONS
        .map((day) => `<option value="${escapeHtml(day)}" ${day === selectedDay ? 'selected' : ''}>${escapeHtml(day)}</option>`)
        .join('');
}

function addSubjectRow(initial = defaultRow) {
    const row = document.createElement('tr');
    row.innerHTML = `
        <td><input type="text" class="gen-subject" placeholder="DSA" value="${escapeHtml(initial.subjectName)}"></td>
        <td><input type="text" class="gen-teacher" placeholder="Dr. Sharma" value="${escapeHtml(initial.subjectTeacher)}"></td>
        <td><input type="text" class="gen-batch" placeholder="BTech-CSE-A" value="${escapeHtml(initial.batch)}"></td>
        <td>
            <select class="gen-day">
                ${createDayOptions(initial.day)}
            </select>
        </td>
        <td><input type="text" class="gen-time" placeholder="10:00-11:00" value="${escapeHtml(initial.time)}"></td>
        <td><button type="button" class="ghost-btn" data-action="remove-row">Remove</button></td>
    `;
    elements.tableBody.appendChild(row);
}

function getEntriesFromTable() {
    const rows = Array.from(elements.tableBody.querySelectorAll('tr'));
    return rows.map((row) => ({
        subjectName: row.querySelector('.gen-subject')?.value.trim() || '',
        subjectTeacher: row.querySelector('.gen-teacher')?.value.trim() || '',
        batch: row.querySelector('.gen-batch')?.value.trim() || '',
        day: row.querySelector('.gen-day')?.value || '',
        time: row.querySelector('.gen-time')?.value.trim() || '',
    }));
}

function validateEntries(entries) {
    if (!entries.length) {
        return 'Add at least one subject row';
    }

    for (const [index, entry] of entries.entries()) {
        const rowNumber = index + 1;
        if (!entry.subjectName) {
            return `Row ${rowNumber}: Subject name is required`;
        }
        if (!entry.subjectTeacher) {
            return `Row ${rowNumber}: Subject teacher is required`;
        }
        if (!entry.day) {
            return `Row ${rowNumber}: Day is required`;
        }
        if (!entry.time || !entry.time.includes('-')) {
            return `Row ${rowNumber}: Time must be in format HH:MM-HH:MM`;
        }
    }

    const foodBreakSlots = Number(elements.foodBreakSlots.value || 0);
    if (foodBreakSlots < 1 || foodBreakSlots > 2) {
        return 'Food break slots per day must be 1 or 2';
    }

    return null;
}

async function authFetch(url, options = {}) {
    const headers = {
        ...(options.headers || {}),
        Authorization: `Bearer ${authToken}`,
    };

    return fetch(url, {
        ...options,
        headers,
    });
}

async function generateTimetableFromRows() {
    const entries = getEntriesFromTable().filter((entry) =>
        entry.subjectName || entry.subjectTeacher || entry.batch || entry.day || entry.time
    );

    const validationError = validateEntries(entries);
    if (validationError) {
        setStatus(validationError, 'error');
        return;
    }

    const payload = {
        entries,
        constraints: {
            foodBreakSlotsPerDay: Number(elements.foodBreakSlots.value || 1),
            additionalConstraints: String(elements.additionalConstraints.value || '').trim(),
        },
    };

    try {
        setStatus('Generating timetable from your local model...', 'loading');
        elements.generateBtn.disabled = true;

        const response = await authFetch(`${API_BASE}/timetable/llm/convert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || 'Failed to generate timetable');
        }

        latestGeneratedRows = Array.isArray(result.generatedTimetable) ? result.generatedTimetable : [];
        renderGeneratedPreviewTable(latestGeneratedRows);

        elements.llmPromptOutput.classList.remove('hidden');
        elements.llmPromptOutput.textContent =
            `Prompt sent to LLM:\n\n${result.ollamaPrompt}`;

        if (result.warning) {
            setStatus(`Generated with fallback: ${result.warning}`, 'loading');
        } else {
            setStatus('Timetable generated successfully. Review and apply it.', 'ok');
        }
    } catch (error) {
        setStatus(error.message || 'Generation failed', 'error');
    } finally {
        elements.generateBtn.disabled = false;
    }
}

function renderGeneratedPreviewTable(rows) {
    elements.generatedPreviewBody.innerHTML = '';

    if (!rows.length) {
        elements.generatedPreviewSection.classList.add('hidden');
        elements.applyGeneratedBtn.disabled = true;
        return;
    }

    rows.forEach((row, index) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${index + 1}</td>
            <td>${escapeHtml(row.day)}</td>
            <td>${escapeHtml(row.timeSlot)}</td>
            <td>${escapeHtml(row.course)}</td>
            <td>${escapeHtml(row.faculty)}</td>
            <td>${escapeHtml(row.batch)}</td>
            <td>${escapeHtml(row.room)}</td>
        `;
        elements.generatedPreviewBody.appendChild(tr);
    });

    elements.generatedPreviewSection.classList.remove('hidden');
    elements.applyGeneratedBtn.disabled = false;
}

function clearGeneratedPreview() {
    latestGeneratedRows = [];
    elements.generatedPreviewBody.innerHTML = '';
    elements.generatedPreviewSection.classList.add('hidden');
    elements.applyGeneratedBtn.disabled = true;
    setStatus('Preview cleared. You can generate again.', 'ok');
}

async function applyGeneratedTimetableAsOriginal() {
    if (!latestGeneratedRows.length) {
        setStatus('Generate a timetable first', 'error');
        return;
    }

    const confirmReplace = window.confirm('Set this generated timetable as the official timetable? This will replace current timetable data.');
    if (!confirmReplace) {
        return;
    }

    try {
        elements.applyGeneratedBtn.disabled = true;
        setStatus('Applying generated timetable as original...', 'loading');

        const response = await authFetch(`${API_BASE}/timetable/apply-generated`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ generatedTimetable: latestGeneratedRows }),
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || 'Failed to apply generated timetable');
        }

        setStatus('New timetable is now the original timetable. Redirecting to dashboard...', 'ok');
        window.setTimeout(() => {
            window.location.href = '/';
        }, 900);
    } catch (error) {
        elements.applyGeneratedBtn.disabled = false;
        setStatus(error.message || 'Failed to apply generated timetable', 'error');
    }
}

function setStatus(message, type) {
    elements.status.classList.remove('hidden', 'chip-loading', 'chip-ok', 'chip-error');
    elements.status.classList.add(type === 'error' ? 'chip-error' : type === 'ok' ? 'chip-ok' : 'chip-loading');
    elements.status.textContent = message;
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
