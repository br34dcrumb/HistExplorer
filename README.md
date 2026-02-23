# HistExplorer - Browser History Viewer

A client-side SQLite database viewer built for browsing browser history files — or any SQLite database. No server, no uploads. Everything runs in your browser.

## Features

- **Open any SQLite file** — drag & drop or `Ctrl+O` / `Cmd+O`
- **Browser history detection** — auto-detects Chrome/Edge, Firefox, and Safari history schemas and pre-fills a matching SQL query
- **Schema sidebar** — browse all tables, views, and indexes at a glance
- **SQL editor** with syntax highlighting (One Dark palette), `Tab` = 4 spaces, `Alt+↑/↓` to swap lines, `Ctrl+Enter` to run
- **All rows shown** — no pagination, all data fetched at once
- **Sortable columns** — click any header to sort asc/desc
- **Column resizing** — drag the right edge of a header; double-click to auto-fit to the longest value
- **Column pinning** — pin columns to the left so they stay visible during horizontal scroll
- **Cell detail panel** — click any cell to see the full value
- **Copy on hover** — hover a row to reveal a copy button per cell (copies the original untruncated value)
- **CSV export** — export the current view with one click
- **Status bar** — shows row count and detected browser type

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + O` | Open file |
| `Ctrl/Cmd + `` ` | Toggle SQL editor |
| `Ctrl/Cmd + Enter` | Run SQL query |
| `Alt + ↑ / ↓` | Move line up / down in SQL editor |
| `Tab` | Insert 4 spaces (SQL editor) |

## Running Locally

No build step required — it's plain HTML, CSS, and JS.

```bash
# Python
python -m http.server 8080

# Node
npx serve .
```

Then open `http://localhost:8080`.

## Stack

| Library | Purpose |
|---|---|
| [sql.js](https://github.com/sql-js/sql.js) | SQLite via WebAssembly (client-side) |
| [CodeMirror 5](https://codemirror.net/5/) | SQL editor with syntax highlighting |
| [Tailwind CSS](https://tailwindcss.com) | Utility-first styling (CDN) |
| [Lucide Icons](https://lucide.dev) | Icons |

## Privacy

All processing happens in your browser. No data is ever sent to any server.
