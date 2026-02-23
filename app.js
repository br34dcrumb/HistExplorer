/**
 * HistExplorer — Full SQLite Viewer
 * All data-processing is client-side only. Nothing is sent to any server.
 */

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
    db: null,       // sql.js Database instance (kept alive)
    schema: {},         // { tableName: [{name, type, pk, notnull}] }
    views: [],         // view names
    indexes: [],         // index names
    activeTable: null,       // currently selected table / view
    colNames: [],         // column names of current result
    sortCol: -1,         // column index to sort by (-1 = none)
    sortDir: 'ASC',
    totalRows: 0,
    searchQuery: '',
    pinnedCols: new Set(),  // set of column indices pinned left (0-based, after # col)
    customSQL: false,
    lastSQL: '',
    fileName: '',
    detectedBrowser: null,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const openFileBtn = $('open-file-btn');
const fileInput = $('file-input');
const breadcrumb = $('breadcrumb');
const errorMsg = $('error-msg');
const schemaSearch = $('schema-search');
const schemaTree = $('schema-tree');
const schemaEmpty = $('schema-empty');
const searchInput = $('search-input');
const pageSizeSelect = null; // removed
const resetBtn = $('reset-btn');
const exportCsvBtn = $('export-csv-btn');
const recordStats = $('record-stats');
const runSqlBtn = $('run-sql-btn');
const toggleSqlBtn = $('toggle-sql-btn');
const viewLanding = $('view-landing');
const viewData = $('view-data');
const tableLoading = $('table-loading');
const dataGridWrapper = $('data-grid-wrapper');
const dataThead = $('data-thead');
const dataTbody = $('data-tbody');
const cellDetailPanel = $('cell-detail-panel');
const cellDetailLabel = $('cell-detail-label');
const cellDetailContent = $('cell-detail-content');
const closeDetailBtn = $('close-detail-btn');
const sqlEditorPanel = $('sql-editor-panel');
const sqlEditor = $('sql-editor');
const rowDisplayInfo = $('row-display-info');
const dbTypeBadge = $('db-type-badge');

// ─── SQL Presets ──────────────────────────────────────────────────────────────
const SQL_PRESETS = {
    chrome: `-- Chromium (Chrome / Edge / Brave) browser history
SELECT
  urls.title,
  urls.url,
  datetime((visits.visit_time / 1000000) - 11644473600, 'unixepoch', 'localtime') AS visit_time_local,
  datetime((visits.visit_time / 1000000) - 11644473600, 'unixepoch') AS visit_time_utc,
  urls.visit_count
FROM urls
JOIN visits ON urls.id = visits.url
ORDER BY visits.visit_time DESC
LIMIT 500;`,

    firefox: `-- Mozilla Firefox browser history
SELECT
  moz_places.title,
  moz_places.url,
  datetime(moz_historyvisits.visit_date / 1000000, 'unixepoch', 'localtime') AS visit_time_local,
  datetime(moz_historyvisits.visit_date / 1000000, 'unixepoch') AS visit_time_utc,
  moz_places.visit_count
FROM moz_places
JOIN moz_historyvisits ON moz_places.id = moz_historyvisits.place_id
ORDER BY moz_historyvisits.visit_date DESC
LIMIT 500;`,

    safari: `-- Apple Safari browser history
SELECT
  history_visits.title,
  history_items.url,
  datetime(history_visits.visit_time + 978307200, 'unixepoch', 'localtime') AS visit_time_local,
  datetime(history_visits.visit_time + 978307200, 'unixepoch') AS visit_time_utc
FROM history_items
JOIN history_visits ON history_items.id = history_visits.history_item
ORDER BY history_visits.visit_time DESC
LIMIT 500;`,

    top_visited: `-- Auto-detected: Top visited URLs (Chromium)
-- Change table/column names for Firefox (moz_places.url, visit_count) or Safari (history_items)
SELECT
  urls.url,
  urls.title,
  urls.visit_count
FROM urls
ORDER BY urls.visit_count DESC
LIMIT 100;`,

    by_domain: `-- Auto-detected: Visits grouped by domain (Chromium)
-- Extracts domain from url using substr tricks
SELECT
  REPLACE(
    REPLACE(
      CASE WHEN instr(REPLACE(url, 'https://', ''), '/') > 0
        THEN substr(REPLACE(url, 'https://', ''), 1, instr(REPLACE(url, 'https://', ''), '/')-1)
        ELSE REPLACE(url, 'https://', '')
      END, 'www.', ''),
    'http://', ''
  ) AS domain,
  COUNT(*) AS visits
FROM urls
GROUP BY domain
ORDER BY visits DESC
LIMIT 100;`,

    recent_week: `-- Auto-detected: Visits in the last 7 days (Chromium)
SELECT
  urls.title,
  urls.url,
  datetime((visits.visit_time / 1000000) - 11644473600, 'unixepoch', 'localtime') AS visited_at
FROM urls
JOIN visits ON urls.id = visits.url
WHERE ((visits.visit_time / 1000000) - 11644473600) > strftime('%s', 'now', '-7 days')
ORDER BY visits.visit_time DESC;`,
};

// ─── Event Wiring ─────────────────────────────────────────────────────────────
openFileBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => {
    if (e.target.files.length > 0) openDatabase(e.target.files[0]);
});

// SQL Preset buttons
document.querySelectorAll('.sql-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const key = btn.dataset.preset;
        if (SQL_PRESETS[key]) {
            cm.setValue(SQL_PRESETS[key]);
            // Auto-open the SQL panel if it's hidden
            showSqlEditor();
            cm.focus();
        }
    });
});

searchInput.addEventListener('input', debounce(e => {
    state.searchQuery = e.target.value;
    fetchAndRender();
}, 250));

// Page size selector removed — all rows shown at once

resetBtn.addEventListener('click', () => {
    searchInput.value = '';
    state.searchQuery = '';
    state.sortCol = -1;
    state.sortDir = 'ASC';
    state.customSQL = false;
    fetchAndRender();
});

exportCsvBtn.addEventListener('click', exportCSV);

runSqlBtn.addEventListener('click', runCustomSQL);

// Platform detection — used for shortcut hints
const isMac = navigator.platform.toLowerCase().includes('mac') ||
    navigator.userAgent.toLowerCase().includes('mac');
const MOD = isMac ? '⌘' : 'Ctrl';

// Update all shortcut hint elements with the correct modifier label
document.querySelectorAll('[data-shortcut-mod]').forEach(el => {
    const label = el.getAttribute('data-shortcut-mod').replace(/MOD/g, MOD);
    if (el.hasAttribute('title')) {
        el.title = label; // tooltip elements (e.g. Open File button)
    } else {
        el.textContent = label; // inline hint text spans
    }
});

// sqlEditor keydown is handled by CodeMirror extraKeys (Ctrl+Enter and Tab)

toggleSqlBtn.addEventListener('click', () => {
    toggleSqlEditor();
});

// Global shortcuts (Ctrl on Windows, Cmd on Mac)
document.addEventListener('keydown', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    switch (e.key) {
        case 'o': case 'O':
            // Ctrl/Cmd+O — open file (only when not focused in CodeMirror or other input)
            if (!document.activeElement.closest('.CodeMirror') &&
                document.activeElement.tagName !== 'TEXTAREA' &&
                document.activeElement.tagName !== 'INPUT') {
                e.preventDefault();
                fileInput.click();
            }
            break;
        case '`':
            e.preventDefault();
            toggleSqlEditor();
            break;
    }
});

function showSqlEditor() {
    const panel = sqlEditorPanel;
    panel.style.display = 'flex';
    // CodeMirror must be refreshed after its container becomes visible
    if (cm) { cm.refresh(); cm.focus(); }
}

function toggleSqlEditor() {
    const panel = sqlEditorPanel;
    const isHidden = panel.style.display === 'none' || panel.style.display === '';
    if (isHidden) {
        showSqlEditor();
    } else {
        panel.style.display = 'none';
    }
}

// ─── CodeMirror line-swap helpers ─────────────────────────────────────────────
function swapLineUp(cm) {
    const cur = cm.getCursor();
    if (cur.line === 0) return;
    const above = cm.getLine(cur.line - 1);
    const curr = cm.getLine(cur.line);
    cm.replaceRange(
        curr + '\n' + above,
        { line: cur.line - 1, ch: 0 },
        { line: cur.line, ch: curr.length }
    );
    cm.setCursor({ line: cur.line - 1, ch: cur.ch });
}

function swapLineDown(cm) {
    const cur = cm.getCursor();
    const last = cm.lineCount() - 1;
    if (cur.line === last) return;
    const below = cm.getLine(cur.line + 1);
    const curr = cm.getLine(cur.line);
    cm.replaceRange(
        below + '\n' + curr,
        { line: cur.line, ch: 0 },
        { line: cur.line + 1, ch: below.length }
    );
    cm.setCursor({ line: cur.line + 1, ch: cur.ch });
}

// Initialise CodeMirror on the sql-editor textarea
let cm; // CodeMirror instance — accessible throughout app.js
(function initCodeMirror() {
    cm = CodeMirror.fromTextArea(sqlEditor, {
        mode: 'text/x-sql',
        theme: 'hist-ide',
        lineNumbers: true,
        indentWithTabs: false,
        indentUnit: 4,
        tabSize: 4,
        lineWrapping: false,
        matchBrackets: true,
        autofocus: false,
        extraKeys: {
            'Tab': cm => cm.execCommand('insertSoftTab'),
            'Ctrl-Enter': runCustomSQL,
            'Cmd-Enter': runCustomSQL,
            'Alt-Up': swapLineUp,
            'Alt-Down': swapLineDown,
        },
    });

    // Keep internal textarea in sync
    cm.on('change', () => sqlEditor.value = cm.getValue());
})();

// SQL editor panel resize handle
const sqlResizeHandle = $('sql-resize-handle');
if (sqlResizeHandle) {
    sqlResizeHandle.addEventListener('mousedown', e => {
        e.preventDefault();
        const panel = sqlEditorPanel;
        const startY = e.clientY;
        const startH = panel.offsetHeight;

        const onMove = e2 => {
            const delta = startY - e2.clientY; // drag up = bigger
            const newH = Math.min(Math.max(startH + delta, 60), 500);
            panel.style.height = newH + 'px';
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

closeDetailBtn.addEventListener('click', () => {
    cellDetailPanel.classList.add('hidden');
});

// Pagination buttons removed — all rows shown at once

schemaSearch.addEventListener('input', debounce(e => {
    filterSchemaTree(e.target.value.toLowerCase());
}, 200));

// ─── Core Functions ───────────────────────────────────────────────────────────

async function openDatabase(file) {
    try {
        showError('');
        tableLoading.classList.remove('hidden');

        const arrayBuffer = await readFileAsArrayBuffer(file);
        const SQL = await initSqlJs({
            locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${f}`
        });

        // Close existing DB
        if (state.db) { state.db.close(); }

        state.db = new SQL.Database(new Uint8Array(arrayBuffer));
        state.fileName = file.name;
        state.searchQuery = '';
        state.page = 0;
        state.sortCol = -1;
        state.customSQL = false;
        state.pinnedCols = new Set();

        // Set filename badge first; detectBrowserType() will overwrite it if a known schema is found
        dbTypeBadge.innerHTML = `
            <i data-lucide="database" class="w-3 h-3 text-ideText/30"></i>
            <span class="text-ideText/40">${file.name} — SQLite 3</span>
        `;
        lucide.createIcons();

        buildSchema();
        detectBrowserType(); // may replace dbTypeBadge with coloured browser name
        renderSchemaTree();
        enableToolbar(true);

        // Auto-select first table
        const firstTable = Object.keys(state.schema)[0];
        if (firstTable) selectTable(firstTable);
        else {
            tableLoading.classList.add('hidden');
            showView('data');
        }

    } catch (err) {
        console.error(err);
        showError('Failed to open file. Is it a valid SQLite database?');
        tableLoading.classList.add('hidden');
    }
}

function buildSchema() {
    state.schema = {};
    state.views = [];
    state.indexes = [];

    try {
        // Tables
        const tablesRes = state.db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;");
        const tables = tablesRes.length ? tablesRes[0].values.map(r => r[0]) : [];

        tables.forEach(t => {
            try {
                const cols = state.db.exec(`PRAGMA table_info("${t}");`);
                state.schema[t] = cols.length
                    ? cols[0].values.map(c => ({ cid: c[0], name: c[1], type: (c[2] || '').toUpperCase(), notnull: c[3], dflt: c[4], pk: c[5] }))
                    : [];
            } catch (e) { state.schema[t] = []; }
        });

        // Views
        const viewRes = state.db.exec("SELECT name FROM sqlite_master WHERE type='view' ORDER BY name;");
        state.views = viewRes.length ? viewRes[0].values.map(r => r[0]) : [];

        // Indexes
        const idxRes = state.db.exec("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name;");
        state.indexes = idxRes.length ? idxRes[0].values.map(r => r[0]) : [];

    } catch (e) { console.error('Schema build error', e); }
}

function getRowCount(tableName) {
    try {
        const res = state.db.exec(`SELECT COUNT(*) FROM "${tableName}";`);
        if (res.length && res[0].values.length) return res[0].values[0][0];
    } catch (e) { /* noop */ }
    return 0;
}

function renderSchemaTree(filter = '') {
    schemaTree.innerHTML = '';

    const tables = Object.keys(state.schema);
    const hasContent = tables.length + state.views.length + state.indexes.length > 0;

    if (!hasContent) {
        schemaTree.appendChild(schemaEmpty);
        schemaEmpty.classList.remove('hidden');
        return;
    }
    schemaEmpty.classList.add('hidden');

    // ── Tables Section ──
    if (tables.length) {
        const section = makeSchemaSection('Tables', tables.length);
        tables.forEach(t => {
            if (filter && !t.toLowerCase().includes(filter)) return;
            const isActive = t === state.activeTable;
            const node = makeTableNode(t, isActive);
            section.list.appendChild(node);
        });
        schemaTree.appendChild(section.el);
    }

    // ── Views Section ──
    if (state.views.length) {
        const section = makeSchemaSection('Views', state.views.length);
        state.views.forEach(v => {
            if (filter && !v.toLowerCase().includes(filter)) return;
            const node = makeSimpleNode(v, 'eye', state.activeTable === v, () => selectTable(v));
            section.list.appendChild(node);
        });
        schemaTree.appendChild(section.el);
    }

    // ── Indexes Section ──
    if (state.indexes.length) {
        const section = makeSchemaSection('Indexes', state.indexes.length, true /* collapsed by default */);
        state.indexes.forEach(idx => {
            if (filter && !idx.toLowerCase().includes(filter)) return;
            const node = makeSimpleNode(idx, 'key', false, null);
            node.style.cursor = 'default';
            section.list.appendChild(node);
        });
        schemaTree.appendChild(section.el);
    }

    lucide.createIcons();
}

function makeSchemaSection(title, count, collapsed = false) {
    const el = document.createElement('div');
    el.className = 'border-b border-ideBorder/50';

    const header = document.createElement('div');
    header.className = 'flex items-center gap-1 px-3 py-1 cursor-pointer hover:bg-ideHighlight select-none';
    const arrow = document.createElement('i');
    arrow.setAttribute('data-lucide', collapsed ? 'chevron-right' : 'chevron-down');
    arrow.className = 'w-3 h-3 text-ideText/50';
    const label = document.createElement('span');
    label.className = 'text-ideText/60 text-[11px] uppercase tracking-wider font-semibold';
    label.textContent = `${title} (${count})`;
    header.appendChild(arrow);
    header.appendChild(label);

    const list = document.createElement('div');
    list.className = collapsed ? 'hidden' : '';

    header.addEventListener('click', () => {
        list.classList.toggle('hidden');
        arrow.setAttribute('data-lucide', list.classList.contains('hidden') ? 'chevron-right' : 'chevron-down');
        lucide.createIcons();
    });

    el.appendChild(header);
    el.appendChild(list);
    return { el, list };
}

function makeTableNode(tableName, isActive) {
    const cols = state.schema[tableName] || [];
    const wrapper = document.createElement('div');

    const row = document.createElement('div');
    row.className = `flex items-center gap-1.5 px-4 py-[3px] cursor-pointer group ${isActive ? 'bg-ideSelect text-ideText' : 'text-ideText/80 hover:bg-ideHighlight'}`;

    const arrow = document.createElement('i');
    arrow.setAttribute('data-lucide', 'chevron-right');
    arrow.className = 'w-3 h-3 text-ideText/40 shrink-0 transition-transform';

    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', 'table-2');
    icon.className = `w-3 h-3 shrink-0 ${isActive ? 'text-ideBlue' : 'text-ideText/50'}`;

    const name = document.createElement('span');
    name.className = 'truncate text-[13px]';
    name.textContent = tableName;

    const rowCount = document.createElement('span');
    rowCount.className = 'ml-auto text-[11px] text-ideText/30 shrink-0';

    row.appendChild(arrow);
    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(rowCount);

    // Lazy load row count on hover / click
    let counted = false;
    row.addEventListener('mouseenter', () => {
        if (!counted) {
            counted = true;
            try { rowCount.textContent = getRowCount(tableName).toLocaleString(); } catch (e) { }
        }
    });

    const colList = document.createElement('div');
    colList.className = 'hidden';

    let expanded = false;
    arrow.addEventListener('click', e => {
        e.stopPropagation();
        expanded = !expanded;
        colList.classList.toggle('hidden', !expanded);
        arrow.style.transform = expanded ? 'rotate(90deg)' : '';
    });

    cols.forEach(col => {
        const colRow = document.createElement('div');
        colRow.className = 'flex items-center gap-1.5 px-8 py-[2px] text-[12px] text-ideText/50 hover:text-ideText/80 cursor-default';
        colRow.innerHTML = `
            <span class="type-badge ${typeClass(col.type)}">${shortType(col.type)}</span>
            <span class="truncate font-mono">${col.name}</span>
            ${col.pk ? '<i data-lucide="key" class="w-2.5 h-2.5 text-ideYellow ml-auto shrink-0"></i>' : ''}
        `;
        colList.appendChild(colRow);
    });

    row.addEventListener('click', () => selectTable(tableName));

    wrapper.appendChild(row);
    wrapper.appendChild(colList);
    return wrapper;
}

function makeSimpleNode(label, iconName, isActive, onClick) {
    const row = document.createElement('div');
    row.className = `flex items-center gap-1.5 px-4 py-[3px] cursor-pointer ${isActive ? 'bg-ideSelect text-ideText' : 'text-ideText/80 hover:bg-ideHighlight'}`;
    row.innerHTML = `
        <i data-lucide="${iconName}" class="w-3 h-3 shrink-0 text-ideText/40"></i>
        <span class="truncate text-[13px]">${label}</span>
    `;
    if (onClick) row.addEventListener('click', onClick);
    return row;
}

function selectTable(tableName) {
    state.activeTable = tableName;
    state.customSQL = false;
    state.searchQuery = '';
    state.sortCol = -1;
    state.sortDir = 'ASC';
    state.pinnedCols = new Set();
    searchInput.value = '';

    renderSchemaTree(schemaSearch.value.toLowerCase());
    updateBreadcrumb();
    fetchAndRender();
    showView('data');
}

function fetchAndRender() {
    if (!state.db) return;
    tableLoading.classList.remove('hidden');

    try {
        let sql;

        if (state.customSQL) {
            sql = state.lastSQL;
        } else {
            if (!state.activeTable) return;
            const cols = (state.schema[state.activeTable] || []).map(c => `"${c.name}"`).join(', ') || '*';
            let where = '';
            if (state.searchQuery) {
                const schemaCols = state.schema[state.activeTable] || [];
                const textCols = schemaCols.filter(c =>
                    !c.type.includes('INT') && !c.type.includes('REAL') && !c.type.includes('NUM')
                ).map(c => `"${c.name}"`);
                if (textCols.length) {
                    const q = state.searchQuery.replace(/'/g, "''");
                    where = 'WHERE ' + textCols.map(c => `${c} LIKE '%${q}%'`).join(' OR ');
                }
            }
            let orderBy = '';
            if (state.sortCol >= 0 && state.colNames.length > state.sortCol) {
                orderBy = `ORDER BY "${state.colNames[state.sortCol]}" ${state.sortDir}`;
            }
            // No LIMIT — all rows shown
            sql = `SELECT ${cols} FROM "${state.activeTable}" ${where} ${orderBy};`;
        }

        const result = state.db.exec(sql);

        if (result.length > 0) {
            state.colNames = result[0].columns;
            state.totalRows = result[0].values.length;
            renderGrid(result[0].columns, result[0].values);
        } else {
            state.colNames = [];
            state.totalRows = 0;
            renderGrid([], []);
        }

    } catch (err) {
        console.error(err);
        showError(`Query error: ${err.message}`);
    } finally {
        tableLoading.classList.add('hidden');
    }
}

function renderGrid(columns, rows) {
    // ── Headers ──
    dataThead.innerHTML = '';
    const tr = document.createElement('tr');

    // Row-number header
    const numTh = document.createElement('th');
    numTh.style.width = '50px';
    numTh.className = 'sticky left-0 bg-ideHeader z-50 border-r border-ideBorder text-center text-ideText/40 select-none';
    numTh.textContent = '#';
    tr.appendChild(numTh);

    const schHint = state.activeTable && state.schema[state.activeTable]
        ? Object.fromEntries((state.schema[state.activeTable] || []).map(c => [c.name, c]))
        : {};

    columns.forEach((col, i) => {
        const th = document.createElement('th');
        th.style.width = '160px';
        th.style.minWidth = '60px';
        th.className = 'px-2 py-1 font-normal relative group border-r border-ideBorder text-ideText whitespace-nowrap overflow-hidden cursor-pointer select-none';
        th.dataset.colIndex = i;

        const colMeta = schHint[col];
        const colType = colMeta ? colMeta.type : '';
        const isPk = colMeta && colMeta.pk;
        const isPin = state.pinnedCols.has(i);
        const isSorted = state.sortCol === i;

        th.innerHTML = `
            <div class="flex items-center justify-between w-full min-w-0">
                <div class="flex items-center gap-1 min-w-0 overflow-hidden">
                    <span class="type-badge ${typeClass(colType)}">${shortType(colType)}</span>
                    ${isPk ? '<i data-lucide="key" class="w-2.5 h-2.5 text-ideYellow shrink-0"></i>' : ''}
                    <span class="truncate font-normal">${col}</span>
                </div>
                <div class="flex items-center gap-1 shrink-0 ml-1">
                    ${isSorted ? `<i data-lucide="${state.sortDir === 'ASC' ? 'arrow-up' : 'arrow-down'}" class="w-3 h-3 text-ideBlue"></i>` : ''}
                    <i data-lucide="pin"
                       class="pin-btn w-3 h-3 cursor-pointer transition-colors ${isPin ? 'text-ideRed' : 'text-ideBorder hover:text-ideText'} ${isPin ? '' : 'rotate-45'}"
                       data-col="${i}" title="${isPin ? 'Unpin' : 'Pin'} column"></i>
                </div>
            </div>
            <div class="resizer absolute right-0 top-0 h-full w-1.5 cursor-col-resize z-30 hover:bg-ideBlue opacity-0 group-hover:opacity-100"></div>
        `;

        // Sort on header click
        th.addEventListener('click', e => {
            if (e.target.closest('.pin-btn') || e.target.closest('.resizer')) return;
            if (state.customSQL) return;
            if (state.sortCol === i) {
                state.sortDir = state.sortDir === 'ASC' ? 'DESC' : 'ASC';
            } else {
                state.sortCol = i;
                state.sortDir = 'ASC';
            }
            state.page = 0;
            fetchAndRender();
        });

        tr.appendChild(th);
    });

    dataThead.appendChild(tr);

    // ── Rows ──
    dataTbody.innerHTML = '';

    const fragment = document.createDocumentFragment();
    rows.forEach((row, rowIdx) => {
        const tr = document.createElement('tr');
        tr.addEventListener('click', () => {
            document.querySelectorAll('#data-tbody tr.selected').forEach(el => el.classList.remove('selected'));
            tr.classList.add('selected');
        });

        // Row number cell
        const numTd = document.createElement('td');
        numTd.textContent = rowIdx + 1;
        numTd.className = 'sticky left-0 bg-ideSidebar z-30 text-right text-ideText/40 select-none border-r border-ideBorder';
        tr.appendChild(numTd);

        row.forEach((val, colIdx) => {
            const td = document.createElement('td');
            td.dataset.colIndex = colIdx;
            renderCell(td, val, columns[colIdx]);
            tr.appendChild(td);
        });

        fragment.appendChild(tr);
    });

    dataTbody.appendChild(fragment);
    lucide.createIcons();

    // Wire up pin buttons — just toggle state and update sticky positions, no re-render
    dataThead.querySelectorAll('.pin-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const ci = parseInt(e.currentTarget.dataset.col);
            if (state.pinnedCols.has(ci)) {
                state.pinnedCols.delete(ci);
                // Visual: reset icon to unpinned style
                btn.classList.remove('text-ideRed');
                btn.classList.add('text-ideBorder', 'rotate-45');
                btn.title = 'Pin column';
            } else {
                state.pinnedCols.add(ci);
                // Visual: set icon to pinned style
                btn.classList.add('text-ideRed');
                btn.classList.remove('text-ideBorder', 'rotate-45');
                btn.title = 'Unpin column';
            }
            updatePinnedColumns();
        });
    });

    // Wire up resizers — drag to resize, double-click to auto-fit
    const autoFitCanvas = document.createElement('canvas');
    const autoFitCtx = autoFitCanvas.getContext('2d');
    autoFitCtx.font = '12px Consolas, "Courier New", monospace';

    dataThead.querySelectorAll('.resizer').forEach(resizer => {
        // Drag resize
        resizer.addEventListener('mousedown', e => {
            e.preventDefault();
            e.stopPropagation();
            const th = resizer.closest('th');
            const startX = e.pageX;
            const startW = th.offsetWidth;
            resizer.classList.add('resizing');
            const onMove = e2 => {
                const w = Math.max(60, startW + (e2.pageX - startX));
                th.style.width = w + 'px';
                th.style.minWidth = w + 'px';
                th.style.maxWidth = w + 'px';
                updatePinnedColumns();
            };
            const onUp = () => {
                resizer.classList.remove('resizing');
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        // Double-click: auto-fit column to longest value
        resizer.addEventListener('dblclick', e => {
            e.preventDefault();
            e.stopPropagation();
            const th = resizer.closest('th');
            const thIdx = Array.from(dataThead.querySelectorAll('th')).indexOf(th);

            // Measure the header label
            const headerLabel = th.querySelector('span.truncate')?.textContent?.trim() || '';
            let maxW = autoFitCtx.measureText(headerLabel).width + 72; // badges + padding

            // Measure all data cells in this column
            dataTbody.querySelectorAll('tr').forEach(tr => {
                const td = tr.children[thIdx];
                if (!td) return;
                const raw = td.dataset.rawVal !== undefined ? td.dataset.rawVal : td.textContent;
                const w = autoFitCtx.measureText(String(raw)).width + 24; // cell padding
                if (w > maxW) maxW = w;
            });

            const newW = Math.min(Math.max(Math.ceil(maxW), 60), 700); // clamp 60-700px
            th.style.width = newW + 'px';
            th.style.minWidth = newW + 'px';
            th.style.maxWidth = newW + 'px';
            updatePinnedColumns();
        });
    });

    updatePinnedColumns();
    updateRowDisplayInfo(rows.length, state.totalRows);
}

function renderCell(td, val, colName) {
    const colMeta = state.activeTable && state.schema[state.activeTable]
        ? (state.schema[state.activeTable] || []).find(c => c.name === colName)
        : null;

    td.className = 'border-r border-ideBorder text-ideText/90 overflow-hidden';

    if (val === null || val === undefined) {
        td.className += ' cell-null';
        td.textContent = 'NULL';
        td.dataset.rawVal = '';
        return;
    }

    if (val instanceof Uint8Array) {
        td.className += ' cell-blob';
        td.textContent = `[BLOB ${val.length} B]`;
        td.dataset.rawVal = '';
        return;
    }

    const strVal = String(val);
    td.dataset.rawVal = strVal;

    // Timestamp auto-detect: if INT column value looks like an epoch, render as date
    const typeHint = colMeta ? colMeta.type : '';
    if (/INT/i.test(typeHint) && typeof val === 'number') {
        const epoch = detectEpoch(val, colName);
        if (epoch !== null) {
            const dateObj = new Date(epoch * 1000);
            if (dateObj.getFullYear() >= 1990 && dateObj.getFullYear() <= 2100) {
                const dateStr = dateObj.toLocaleString();
                const wrapper = document.createElement('div');
                wrapper.className = 'truncate-cell-wrapper';
                const textSpan = document.createElement('span');
                textSpan.className = 'cell-text-truncate';
                textSpan.textContent = dateStr;
                wrapper.appendChild(textSpan);
                td.title = `Local: ${dateStr}\nUTC: ${dateObj.toUTCString()}\nRaw: ${val}`;
                td.className += ' relative group/cell';
                td.appendChild(wrapper);
                td.addEventListener('click', e => {
                    e.stopPropagation();
                    showCellDetail(colName, `Local: ${dateStr}\nUTC:   ${dateObj.toUTCString()}\nUnix:  ${epoch}\nRaw:   ${val}`);
                });
                return;
            }
        }
    }

    // Generic string rendering with truncation + copy button
    const wrapper = document.createElement('div');
    wrapper.className = 'truncate-cell-wrapper';

    const textSpan = document.createElement('span');
    textSpan.className = 'cell-text-truncate';
    textSpan.textContent = strVal;
    wrapper.appendChild(textSpan);

    // Copy button — appears on cell hover, copies original raw value
    const copyBtn = document.createElement('button');
    copyBtn.className = 'cell-copy-btn';
    copyBtn.innerHTML = '<i data-lucide="copy" class="w-3 h-3"></i>';
    copyBtn.title = 'Copy value';
    copyBtn.onclick = e => {
        e.stopPropagation();
        navigator.clipboard.writeText(strVal); // always the original full value
        copyBtn.innerHTML = '<i data-lucide="check" class="w-3 h-3 text-ideGreen"></i>';
        lucide.createIcons();
        setTimeout(() => {
            copyBtn.innerHTML = '<i data-lucide="copy" class="w-3 h-3"></i>';
            lucide.createIcons();
        }, 1500);
    };
    wrapper.appendChild(copyBtn);

    td.className += ' relative group/cell';
    td.title = strVal;
    td.appendChild(wrapper);

    td.addEventListener('click', e => {
        e.stopPropagation();
        showCellDetail(colName, strVal);
    });
}

function showCellDetail(colName, val) {
    cellDetailLabel.textContent = colName;
    cellDetailContent.textContent = val;
    cellDetailPanel.classList.remove('hidden');
}

function updatePinnedColumns() {
    const ths = Array.from(dataThead.querySelectorAll('th'));
    const rows = Array.from(dataTbody.querySelectorAll('tr'));

    let leftOffset = 0;

    ths.forEach((th, idx) => {
        const isRowNum = idx === 0;
        const dataColIdx = idx - 1;
        const isPinned = isRowNum || state.pinnedCols.has(dataColIdx);

        if (isPinned) {
            th.classList.add('pinned-col');
            th.style.position = 'sticky';
            th.style.left = leftOffset + 'px';
            th.style.zIndex = isRowNum ? '52' : '50';

            rows.forEach(tr => {
                const td = tr.children[idx];
                if (td) {
                    td.classList.add('pinned-col');
                    td.style.position = 'sticky';
                    td.style.left = leftOffset + 'px';
                    td.style.zIndex = '20';
                }
            });

            leftOffset += th.offsetWidth;
        } else {
            th.classList.remove('pinned-col');
            th.style.position = '';
            th.style.left = '';
            th.style.zIndex = '';

            rows.forEach(tr => {
                const td = tr.children[idx];
                if (td) {
                    td.classList.remove('pinned-col');
                    td.style.position = '';
                    td.style.left = '';
                    td.style.zIndex = '';
                }
            });
        }
    });
}

function runCustomSQL() {
    const sql = sqlEditor.value.trim();
    if (!sql || !state.db) return;

    state.customSQL = true;
    state.lastSQL = sql;
    state.page = 0;

    tableLoading.classList.remove('hidden');
    errorMsg.textContent = '';
    errorMsg.classList.add('hidden');

    try {
        const result = state.db.exec(sql);
        if (result.length > 0) {
            state.colNames = result[0].columns;
            state.totalRows = result[0].values.length;
            renderGrid(result[0].columns, result[0].values);
        } else {
            state.colNames = [];
            state.totalRows = 0;
            renderGrid([], []);
            rowDisplayInfo.textContent = 'Query returned no rows.';
        }
    } catch (err) {
        showError(`SQL Error: ${err.message}`);
    } finally {
        tableLoading.classList.add('hidden');
    }
}

function exportCSV() {
    if (!state.db) return;

    const headers = state.colNames;
    const rows = Array.from(dataTbody.querySelectorAll('tr')).map(tr =>
        Array.from(tr.querySelectorAll('td')).slice(1).map(td => td.dataset.rawVal !== undefined ? td.dataset.rawVal : td.textContent)
    );

    const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
        headers.map(escape).join(','),
        ...rows.map(r => r.map(escape).join(','))
    ];

    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.activeTable || 'query'}_export.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function updateBreadcrumb() {
    breadcrumb.innerHTML = `
        <i data-lucide="database" class="w-3.5 h-3.5 text-ideText/50 shrink-0"></i>
        <span class="text-ideText/70 truncate max-w-[160px]" title="${state.fileName}">${state.fileName}</span>
        <i data-lucide="chevron-right" class="w-3 h-3 text-ideText/30 shrink-0"></i>
        <i data-lucide="table-2" class="w-3.5 h-3.5 text-idePurple shrink-0"></i>
        <span class="text-ideText font-medium truncate">${state.activeTable || ''}</span>
    `;
    lucide.createIcons();
}

function updatePagination(displayedRows) {
    if (state.pageSize === 0 || state.customSQL) {
        pageDisplay.textContent = '1';
        paginationInfo.textContent = `Page 1 / 1 (Showing ${displayedRows.toLocaleString()})`;
        return;
    }
    const totalPages = Math.max(1, Math.ceil(state.totalRows / state.pageSize));
    const currentPage = state.page + 1;
    pageDisplay.textContent = currentPage;
    paginationInfo.textContent = `Page ${currentPage} / ${totalPages} (${displayedRows} of ${state.totalRows.toLocaleString()} rows)`;
}

function updateRowDisplayInfo(displayed, total) {
    if (state.customSQL) {
        rowDisplayInfo.textContent = `Custom Query — ${displayed} row${displayed !== 1 ? 's' : ''} returned`;
    } else {
        const ps = state.pageSize;
        if (ps > 0 && total > ps) {
            const page = state.page + 1;
            const totalPages = Math.ceil(total / ps);
            rowDisplayInfo.textContent = `Page ${page} / ${totalPages}  ·  Showing ${displayed} of ${total.toLocaleString()} rows`;
        } else {
            rowDisplayInfo.textContent = `${total.toLocaleString()} row${total !== 1 ? 's' : ''}`;
        }
    }
}

function detectBrowserType() {
    const tables = Object.keys(state.schema);
    let browserName = null;
    let iconName = 'database';
    let color = 'text-ideText/40';

    if (tables.includes('urls') && tables.includes('visits')) {
        browserName = 'Chromium (Chrome / Edge / Brave)';
        iconName = 'chrome';
        color = 'text-ideBlue';
    } else if (tables.includes('moz_places') && tables.includes('moz_historyvisits')) {
        browserName = 'Mozilla Firefox';
        iconName = 'flame';
        color = 'text-ideRed';
    } else if (tables.includes('history_items') && tables.includes('history_visits')) {
        browserName = 'Apple Safari';
        iconName = 'compass';
        color = 'text-ideBlue';
    }

    state.detectedBrowser = browserName;

    if (browserName) {
        dbTypeBadge.innerHTML = `
            <i data-lucide="${iconName}" class="w-3 h-3 ${color}"></i>
            <span class="${color}">${browserName}</span>
            <span class="text-ideText/30 ml-1">· SQLite 3</span>
        `;
        lucide.createIcons();

        // Also auto-fill the relevant SQL preset
        if (tables.includes('urls') && SQL_PRESETS.chrome && !sqlEditor.value.trim()) {
            sqlEditor.value = SQL_PRESETS.chrome;
        } else if (tables.includes('moz_places') && SQL_PRESETS.firefox && !sqlEditor.value.trim()) {
            sqlEditor.value = SQL_PRESETS.firefox;
        } else if (tables.includes('history_items') && SQL_PRESETS.safari && !sqlEditor.value.trim()) {
            sqlEditor.value = SQL_PRESETS.safari;
        }
    }
}

function enableToolbar(on) {
    [searchInput, resetBtn, exportCsvBtn, runSqlBtn].forEach(el => {
        if (el) el.disabled = !on;
    });
}

function showView(view) {
    viewLanding.classList.add('view-hidden');
    viewLanding.classList.remove('view-active');
    viewData.classList.add('view-hidden');
    viewData.classList.remove('view-active');

    if (view === 'data') {
        viewData.classList.remove('view-hidden');
        viewData.classList.add('view-active');
    } else {
        viewLanding.classList.remove('view-hidden');
        viewLanding.classList.add('view-active');
    }
}

function showError(msg) {
    if (msg) {
        errorMsg.textContent = msg;
        errorMsg.classList.remove('hidden');
    } else {
        errorMsg.textContent = '';
        errorMsg.classList.add('hidden');
    }
}

function filterSchemaTree(filter) {
    renderSchemaTree(filter);
}

function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsArrayBuffer(file);
    });
}

function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// Detect epoch encoding from column value
function detectEpoch(val, colName) {
    if (typeof val !== 'number') return null;
    const name = (colName || '').toLowerCase();

    // Chromium WebKit epoch (microseconds from 1601-01-01)
    if (val > 1e16) return Math.round(val / 1000000) - 11644473600;
    // Mozilla microseconds from Unix epoch
    if (val > 1e12 && val < 1e16) return Math.round(val / 1000000);
    // Normal Unix timestamp seconds
    if (val > 1e8 && val < 2e9) return val;
    // Safari CoreData epoch (seconds from 2001-01-01)
    if (/visit_time|timestamp/i.test(name) && val > 0 && val < 1e10) return Math.round(val) + 978307200;

    return null;
}

// Type utilities
function shortType(t) {
    if (!t) return '?';
    if (/INT/.test(t)) return 'I';
    if (/REAL|FLOAT|DOUBLE|NUM|DEC/.test(t)) return 'R';
    if (/BLOB/.test(t)) return 'B';
    if (/TEXT|CHAR|CLOB/.test(t)) return 'T';
    return t.charAt(0) || '?';
}

function typeClass(t) {
    if (!t) return 'type-badge-unknown';
    if (/INT/.test(t)) return 'type-badge-int';
    if (/REAL|FLOAT|DOUBLE|NUM|DEC/.test(t)) return 'type-badge-real';
    if (/BLOB/.test(t)) return 'type-badge-blob';
    if (/TEXT|CHAR|CLOB/.test(t)) return 'type-badge-text';
    return 'type-badge-unknown';
}
