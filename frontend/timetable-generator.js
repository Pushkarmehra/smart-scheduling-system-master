const API_BASE = 'http://127.0.0.1:5000/api';
const SESSION_STORAGE_KEY = 'smart_sched_session';
const DAY_OPTIONS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Column name aliases for CSV/Excel import
const COL_ALIASES = {
    subjectName: ['subjectname', 'subject', 'course', 'coursename', 'paper', 'module', 'topic'],
    subjectTeacher: ['subjectteacher', 'teacher', 'faculty', 'instructor', 'professor', 'lecturer', 'staff', 'tutor'],
    batch: ['batch', 'section', 'group', 'class', 'division', 'cohort'],
    day: ['day', 'preferredday', 'weekday', 'scheduled_day', 'scheduledday'],
};

// Preset colors for class cards (cycling by subject)
const CARD_COLORS = [
    '#2d7bc0', '#7b5ea7', '#c0612d', '#2d9e6b', '#b5892a',
    '#c0402d', '#2d8fa0', '#8a5c9e', '#4a7c2d', '#c06b2d',
];

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
    generatedGridWrap: document.getElementById('generated-grid-wrap'),
    applyGeneratedBtn: document.getElementById('apply-generated-btn'),
    clearGeneratedBtn: document.getElementById('clear-generated-btn'),
    // Import elements
    csvFileInput: document.getElementById('csv-file-input'),
    fileUploadLabel: document.getElementById('file-upload-label'),
    fileLabelText: document.getElementById('file-label-text'),
    useImportedBtn: document.getElementById('use-imported-btn'),
    clearImportBtn: document.getElementById('clear-import-btn'),
    importStatus: document.getElementById('import-status'),
    importPreviewSection: document.getElementById('import-preview-section'),
    importPreviewBody: document.getElementById('import-preview-body'),
    importRowCount: document.getElementById('import-row-count'),
    // Tabs
    tabGridBtn: document.getElementById('tab-grid-btn'),
    tabListBtn: document.getElementById('tab-list-btn'),
    previewTabGrid: document.getElementById('preview-tab-grid'),
    previewTabList: document.getElementById('preview-tab-list'),
};

let authToken = null;
let role = null;
let latestGeneratedRows = [];
let importedEntries = [];

const defaultRow = {
    subjectName: '',
    subjectTeacher: '',
    batch: '',
    day: 'Monday',
};

document.addEventListener('DOMContentLoaded', async () => {
    if (!restoreSession()) {
        window.location.href = '/';
        return;
    }

    if (role !== 'admin') {
        setStatus('Only admin can access timetable generation', 'error');
        window.setTimeout(() => { window.location.href = '/'; }, 900);
        return;
    }

    bindEvents();
    for (let i = 0; i < 6; i += 1) addSubjectRow();
    setStatus('Enter subject details or import a file, then generate the timetable', 'ok');
});

function restoreSession() {
    try {
        const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
        if (!raw) return false;
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
    elements.backBtn.addEventListener('click', () => { window.location.href = '/'; });
    elements.addRowBtn.addEventListener('click', () => addSubjectRow());
    elements.generateBtn.addEventListener('click', generateTimetableFromRows);
    elements.applyGeneratedBtn.addEventListener('click', applyGeneratedTimetableAsOriginal);
    elements.clearGeneratedBtn.addEventListener('click', clearGeneratedPreview);

    // Row removal
    elements.tableBody.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.dataset.action === 'remove-row') {
            const row = target.closest('tr');
            if (row) row.remove();
            renumberRows();
            if (!elements.tableBody.children.length) addSubjectRow();
        }
    });

    // CSV / Excel import
    elements.csvFileInput.addEventListener('change', handleFileImport);
    elements.fileUploadLabel.addEventListener('click', () => elements.csvFileInput.click());
    elements.useImportedBtn.addEventListener('click', useImportedEntries);
    elements.clearImportBtn.addEventListener('click', clearImport);

    // Preview tabs
    elements.tabGridBtn.addEventListener('click', () => switchTab('grid'));
    elements.tabListBtn.addEventListener('click', () => switchTab('list'));
}

// ── Row management ────────────────────────────────────────────────────────────

function createDayOptions(selectedDay) {
    return DAY_OPTIONS
        .map((day) => `<option value="${escapeHtml(day)}" ${day === selectedDay ? 'selected' : ''}>${escapeHtml(day)}</option>`)
        .join('');
}

function addSubjectRow(initial = defaultRow) {
    const idx = elements.tableBody.children.length + 1;
    const row = document.createElement('tr');
    row.innerHTML = `
        <td class="row-num">${idx}</td>
        <td><input type="text" class="gen-subject" placeholder="e.g. DSA" value="${escapeHtml(initial.subjectName)}"></td>
        <td><input type="text" class="gen-teacher" placeholder="e.g. Dr. Sharma" value="${escapeHtml(initial.subjectTeacher)}"></td>
        <td><input type="text" class="gen-batch" placeholder="e.g. CSE-A" value="${escapeHtml(initial.batch)}"></td>
        <td>
            <select class="gen-day">${createDayOptions(initial.day)}</select>
        </td>
        <td><button type="button" class="ghost-btn remove-btn" data-action="remove-row">✕</button></td>
    `;
    elements.tableBody.appendChild(row);
}

function renumberRows() {
    Array.from(elements.tableBody.querySelectorAll('tr')).forEach((row, i) => {
        const numCell = row.querySelector('.row-num');
        if (numCell) numCell.textContent = i + 1;
    });
}

function getEntriesFromTable() {
    return Array.from(elements.tableBody.querySelectorAll('tr')).map((row) => ({
        subjectName: row.querySelector('.gen-subject')?.value.trim() || '',
        subjectTeacher: row.querySelector('.gen-teacher')?.value.trim() || '',
        batch: row.querySelector('.gen-batch')?.value.trim() || '',
        day: row.querySelector('.gen-day')?.value || '',
    }));
}

function validateEntries(entries) {
    if (!entries.length) return 'Add at least one subject row';
    for (const [i, entry] of entries.entries()) {
        const n = i + 1;
        if (!entry.subjectName) return `Row ${n}: Subject name is required`;
        if (!entry.subjectTeacher) return `Row ${n}: Subject teacher is required`;
        if (!entry.day) return `Row ${n}: Day is required`;
    }
    const foodBreakSlots = Number(elements.foodBreakSlots.value || 0);
    if (foodBreakSlots < 1 || foodBreakSlots > 2) return 'Food break slots per day must be 1 or 2';
    return null;
}

// ── CSV / Excel import ────────────────────────────────────────────────────────

function normalizeKey(str) {
    return String(str || '').toLowerCase().replace(/[\s_\-]/g, '');
}

function detectColumn(headers, field) {
    const aliases = COL_ALIASES[field];
    for (const header of headers) {
        const key = normalizeKey(header);
        if (aliases.includes(key)) return header;
    }
    return null;
}

async function handleFileImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    elements.fileLabelText.textContent = file.name;
    setImportStatus('Reading file…', 'loading');

    try {
        const entries = await parseFile(file);
        if (!entries || !entries.length) {
            setImportStatus('No valid rows found. Check that your file has the required columns.', 'error');
            return;
        }
        importedEntries = entries;
        renderImportPreview(entries);
        elements.useImportedBtn.disabled = false;
        setImportStatus(`✓ ${entries.length} row(s) loaded. Click "Use as Input Rows" to continue.`, 'ok');
    } catch (err) {
        setImportStatus(`Error: ${err.message}`, 'error');
        console.error(err);
    }

    // Reset input so the same file can be re-imported
    event.target.value = '';
}

async function parseFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.csv')) {
        return parseCsv(await file.text());
    }
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
        return parseExcel(await file.arrayBuffer());
    }
    throw new Error('Unsupported file format. Please use .csv, .xlsx or .xls');
}

function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return [];

    // Detect delimiter: comma or semicolon
    const delim = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
    const headers = lines[0].split(delim).map((h) => h.trim().replace(/^"|"$/g, ''));
    const rows = lines.slice(1).map((line) =>
        line.split(delim).map((cell) => cell.trim().replace(/^"|"$/g, ''))
    );
    return mapToEntries(headers, rows);
}

function parseExcel(buffer) {
    if (typeof XLSX === 'undefined') throw new Error('SheetJS (XLSX) library not loaded');
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!rawRows.length) return [];
    const headers = rawRows[0].map(String);
    const rows = rawRows.slice(1).map((r) => r.map(String));
    return mapToEntries(headers, rows);
}

function mapToEntries(headers, rows) {
    const colMap = {};
    for (const field of Object.keys(COL_ALIASES)) {
        const found = detectColumn(headers, field);
        if (found) colMap[field] = headers.indexOf(found);
    }

    const missing = Object.keys(COL_ALIASES).filter((f) => colMap[f] === undefined && f !== 'batch');
    if (missing.length) {
        throw new Error(`Missing required columns: ${missing.join(', ')}. Found: ${headers.join(', ')}`);
    }

    const entries = [];
    for (const row of rows) {
        const subjectName = (colMap.subjectName !== undefined ? row[colMap.subjectName] : '').trim();
        const subjectTeacher = (colMap.subjectTeacher !== undefined ? row[colMap.subjectTeacher] : '').trim();
        const batch = (colMap.batch !== undefined ? row[colMap.batch] : '').trim();
        const rawDay = (colMap.day !== undefined ? row[colMap.day] : '').trim();

        if (!subjectName && !subjectTeacher) continue; // skip fully empty rows

        // Normalize day
        const day = normalizeDay(rawDay) || 'Monday';

        entries.push({ subjectName, subjectTeacher, batch, day });
    }
    return entries;
}

function normalizeDay(value) {
    const map = {
        mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday',
        thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
    };
    const token = String(value || '').trim().toLowerCase().slice(0, 3);
    return map[token] || DAY_OPTIONS.find((d) => d.toLowerCase() === value.toLowerCase()) || '';
}

function renderImportPreview(entries) {
    elements.importPreviewBody.innerHTML = '';
    elements.importRowCount.textContent = entries.length;

    entries.forEach((entry, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="row-num">${i + 1}</td>
            <td>${escapeHtml(entry.subjectName)}</td>
            <td>${escapeHtml(entry.subjectTeacher)}</td>
            <td>${escapeHtml(entry.batch || '—')}</td>
            <td><span class="day-badge">${escapeHtml(entry.day)}</span></td>
        `;
        elements.importPreviewBody.appendChild(tr);
    });

    elements.importPreviewSection.classList.remove('hidden');
}

function useImportedEntries() {
    if (!importedEntries.length) return;

    // Replace the manual table content
    elements.tableBody.innerHTML = '';
    importedEntries.forEach((entry) => addSubjectRow(entry));
    renumberRows();

    setImportStatus(`✓ ${importedEntries.length} rows loaded into input table.`, 'ok');
    elements.tableBody.closest('.table-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearImport() {
    importedEntries = [];
    elements.importPreviewBody.innerHTML = '';
    elements.importPreviewSection.classList.add('hidden');
    elements.useImportedBtn.disabled = true;
    elements.fileLabelText.textContent = 'Choose .csv, .xlsx or .xls file';
    elements.importStatus.classList.add('hidden');
}

function setImportStatus(message, type) {
    elements.importStatus.classList.remove('hidden', 'import-status-ok', 'import-status-error', 'import-status-loading');
    elements.importStatus.classList.add(`import-status-${type}`);
    elements.importStatus.textContent = message;
}

// ── Timetable generation ──────────────────────────────────────────────────────

async function authFetch(url, options = {}) {
    return fetch(url, {
        ...options,
        headers: { ...(options.headers || {}), Authorization: `Bearer ${authToken}` },
    });
}

async function generateTimetableFromRows() {
    const entries = getEntriesFromTable().filter((e) =>
        e.subjectName || e.subjectTeacher || e.batch || e.day
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
        setStatus('Sending to Llama — generating time slots & schedule…', 'loading');
        elements.generateBtn.disabled = true;

        const response = await authFetch(`${API_BASE}/timetable/llm/convert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Failed to generate timetable');

        latestGeneratedRows = Array.isArray(result.generatedTimetable) ? result.generatedTimetable : [];
        renderGeneratedPreviewTable(latestGeneratedRows);
        renderGeneratedGrid(latestGeneratedRows);

        elements.llmPromptOutput.classList.remove('hidden');
        elements.llmPromptOutput.textContent = `Prompt sent to Llama:\n\n${result.ollamaPrompt}`;

        if (result.warning) {
            setStatus(`Timetable generated (fallback). Note: ${result.warning}`, 'ok');
        } else {
            setStatus(`Timetable generated by Llama (${latestGeneratedRows.length} entries). Review and apply.`, 'ok');
        }
    } catch (error) {
        setStatus(error.message || 'Generation failed', 'error');
    } finally {
        elements.generateBtn.disabled = false;
    }
}

// ── Preview: List view ────────────────────────────────────────────────────────

function renderGeneratedPreviewTable(rows) {
    elements.generatedPreviewBody.innerHTML = '';

    if (!rows.length) {
        elements.generatedPreviewSection.classList.add('hidden');
        elements.applyGeneratedBtn.disabled = true;
        return;
    }

    rows.forEach((row, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="row-num">${i + 1}</td>
            <td><span class="day-badge">${escapeHtml(row.day)}</span></td>
            <td><span class="slot-badge">${escapeHtml(row.timeSlot)}</span></td>
            <td><strong>${escapeHtml(row.course)}</strong></td>
            <td>${escapeHtml(row.faculty)}</td>
            <td>${escapeHtml(row.batch)}</td>
            <td><span class="room-badge">${escapeHtml(row.room)}</span></td>
        `;
        elements.generatedPreviewBody.appendChild(tr);
    });

    elements.generatedPreviewSection.classList.remove('hidden');
    elements.applyGeneratedBtn.disabled = false;
}

// ── Preview: Grid (weekly view) ───────────────────────────────────────────────

const SUBJECT_COLOR_MAP = {};

function getSubjectColor(subject) {
    if (!SUBJECT_COLOR_MAP[subject]) {
        const idx = Object.keys(SUBJECT_COLOR_MAP).length % CARD_COLORS.length;
        SUBJECT_COLOR_MAP[subject] = CARD_COLORS[idx];
    }
    return SUBJECT_COLOR_MAP[subject];
}

function renderGeneratedGrid(rows) {
    const wrap = elements.generatedGridWrap;
    wrap.innerHTML = '';

    if (!rows.length) return;

    // Gather unique days and time slots (sorted)
    const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const days = [...new Set(rows.map((r) => r.day))].sort((a, b) => dayOrder.indexOf(a) - dayOrder.indexOf(b));
    const slots = [...new Set(rows.map((r) => r.timeSlot))].sort(compareSlots);

    // Index rows by day+slot
    const cellMap = {};
    for (const row of rows) {
        const key = `${row.day}||${row.timeSlot}`;
        if (!cellMap[key]) cellMap[key] = [];
        cellMap[key].push(row);
    }

    // Build table
    const table = document.createElement('table');
    table.className = 'schedule-table';

    // Header row
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.innerHTML = `<th class="day-col">Time / Day</th>` +
        days.map((d) => `<th>${escapeHtml(d)}</th>`).join('');
    thead.appendChild(headRow);
    table.appendChild(thead);

    // Body rows
    const tbody = document.createElement('tbody');
    for (const slot of slots) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td class="day-label slot-label">${escapeHtml(slot)}</td>`;
        for (const day of days) {
            const key = `${day}||${slot}`;
            const cell = document.createElement('td');
            cell.className = 'slot-cell';
            const classes = cellMap[key] || [];
            if (classes.length) {
                cell.classList.add('slot-cell-active');
                classes.forEach((cls) => {
                    const color = getSubjectColor(cls.course);
                    const card = document.createElement('div');
                    card.className = 'class-card';
                    card.style.setProperty('--subject-color', color);
                    card.innerHTML = `
                        <div class="class-title">${escapeHtml(cls.course)}</div>
                        <div class="class-meta">${escapeHtml(cls.faculty)}</div>
                        <div class="class-meta">${escapeHtml(cls.batch)} &bull; ${escapeHtml(cls.room)}</div>
                    `;
                    cell.appendChild(card);
                });
            } else {
                cell.innerHTML = '<span class="free-label">Free</span>';
            }
            tr.appendChild(cell);
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
}

function compareSlots(a, b) {
    const extract = (s) => {
        const m = String(s || '').match(/^(\d{1,2}):(\d{2})/);
        return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : 9999;
    };
    return extract(a) - extract(b);
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(tab) {
    if (tab === 'grid') {
        elements.previewTabGrid.classList.remove('hidden');
        elements.previewTabList.classList.add('hidden');
        elements.tabGridBtn.classList.add('tab-active');
        elements.tabListBtn.classList.remove('tab-active');
    } else {
        elements.previewTabList.classList.remove('hidden');
        elements.previewTabGrid.classList.add('hidden');
        elements.tabListBtn.classList.add('tab-active');
        elements.tabGridBtn.classList.remove('tab-active');
    }
}

// ── Apply / Clear ─────────────────────────────────────────────────────────────

function clearGeneratedPreview() {
    latestGeneratedRows = [];
    elements.generatedPreviewBody.innerHTML = '';
    elements.generatedGridWrap.innerHTML = '';
    elements.generatedPreviewSection.classList.add('hidden');
    elements.applyGeneratedBtn.disabled = true;
    setStatus('Preview cleared. You can generate again.', 'ok');
}

async function applyGeneratedTimetableAsOriginal() {
    if (!latestGeneratedRows.length) {
        setStatus('Generate a timetable first', 'error');
        return;
    }

    const confirmReplace = window.confirm(
        `Set this generated timetable (${latestGeneratedRows.length} entries) as the official timetable?\n\nThis will replace the current timetable data.`
    );
    if (!confirmReplace) return;

    try {
        elements.applyGeneratedBtn.disabled = true;
        setStatus('Applying generated timetable…', 'loading');

        const response = await authFetch(`${API_BASE}/timetable/apply-generated`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ generatedTimetable: latestGeneratedRows }),
        });

        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Failed to apply generated timetable');

        setStatus('Timetable applied! Redirecting to dashboard…', 'ok');
        window.setTimeout(() => { window.location.href = '/'; }, 1200);
    } catch (error) {
        elements.applyGeneratedBtn.disabled = false;
        setStatus(error.message || 'Failed to apply generated timetable', 'error');
    }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

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
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
