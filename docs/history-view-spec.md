# History view — design spec

Status: spec only (no code). Target: ticketloop dashboard (`src/web/*`) + daemon HTTP API (`src/daemon/server.ts`).

## 0. Why a third tab

| | Activity | History |
|---|---|---|
| Purpose | "what is the loop doing right now" | "find that run from last Tuesday" |
| Data | newest ~50 runs, `GET /api/activity?limit=50` | filtered/paged slice of *all* runs, `GET /api/history` |
| Refresh | polls 4s (1.5s while live), replaces list | fetch on demand only (filter change / page change / manual refresh) |
| Chrome | quota meters, live monitor, Scan now | filter bar, result count, pagination |
| Row | compact run row + expandable stage detail | **identical** row + identical detail (shared renderer) |

Decision: **third tab**, `Activity | History | Setup`. Not an extension of Activity — Activity's value is that it never makes you think (no controls, always current), and bolting filters onto it would fight the 4s poll that rebuilds the DOM. History is a separate, static, query-driven view. The row and detail renderers (`renderRun`, `renderDetail`, `renderStageDetail`, `renderStageTracker`) are reused verbatim so the two views look like one product.

The topbar `Scan now` button is hidden on History (as it already is on Setup). Polling pauses on History exactly as it does on Setup (`activeView !== 'activity'` guard in `poll()`).

---

## (a) Backend API contract

### `GET /api/history`

Query params (all optional):

| param | type | notes |
|---|---|---|
| `project` | string | exact match on `RunRecord.project`. Repeatable → OR. Omit = all projects. |
| `ticket` | string | ticket identifier, **case-insensitive prefix** match on `RunRecord.ticket` (typing `MIL` matches `MIL-1`, `MIL-207`). Exact match when the value contains a `-` and a full number, but prefix is the safe general rule. |
| `outcome` | string, repeatable | `outcome=merged&outcome=failed` → OR within the set. Values from `RunOutcome`. Omit = all. Unknown value → 400. |
| `q` | string | free-text, case-insensitive substring over `ticketTitle` **and** `ticket` (so one box works for "the caching bug" and "MIL-42"). Max 200 chars. |
| `from` | string | inclusive lower bound on `startedAt`. Accepts `YYYY-MM-DD` (interpreted as **local-midnight of the daemon host**, matching how the row timestamps are rendered) or epoch-ms. |
| `to` | string | inclusive upper bound on `startedAt`. `YYYY-MM-DD` expands to that day's `23:59:59.999` local so `from=to=today` returns today's runs. |
| `sort` | enum | `started_desc` (default), `started_asc`, `cost_desc`, `tokens_desc`, `duration_desc`. |
| `limit` | int | page size, default `25`, min `1`, max `200`. |
| `offset` | int | default `0`, min `0`. |

All filters combine with **AND** across params, **OR** within a repeated param.

### Response `200`

```jsonc
{
  "total": 1843,          // matches BEFORE limit/offset — drives "1,843 runs" + page count
  "limit": 25,
  "offset": 50,
  "sort": "started_desc",
  "runs": [ /* RunRecord[] — same shape /api/activity returns */ ]
}
```

`runs[]` are full `RunRecord`s **including `stages[]`**, same as `/api/activity`. Rationale: the store already materializes whole records, a page is ≤200 of them, and shipping stages inline means expanding a row is instant with zero extra request. (`GET /api/activity/:id` stays as the detail endpoint and remains the fallback path used by `toggleExpand` when a record was fetched without stages — no change needed there.)

### Errors

- `400 {"error":"..."}` — unknown `outcome`, unparseable `from`/`to`, `limit` out of range, `sort` not in enum. Message names the offending param, e.g. `invalid outcome: "done"`.
- `500 {"error":"..."}` — store failure. Existing `serverError` helper already emits this shape; the UI's `mutate()`-style error surfacing applies.

### `GET /api/history/facets`

Small companion endpoint so the project dropdown isn't hardcoded to configured projects (runs exist for projects since removed from config):

```jsonc
{
  "projects": ["miles-loyalty", "ticketloop"],   // distinct RunRecord.project, sorted
  "outcomes": ["answered","pr-opened","merged","skipped","blocked","failed","running"],
  "earliest": 1731024000000,                     // min startedAt — bounds the date pickers
  "latest":   1754630000000
}
```

Fetched once when History is first opened; refreshed on manual refresh. Cheap enough to compute on demand from an index.

### Storage / index requirements

The current store (`src/store.ts`) reads the whole `runs.jsonl`, dedupes by id into a Map, sorts, and slices — O(all runs) per request, plus full-file parse. That is fine for 50 recent runs and untenable for `total` over thousands with arbitrary filters. A separate investigation is moving storage to an indexed store; this spec assumes that lands and states what it must provide.

Required of the backing store — a `runs` table/collection with **one row per run id** (the JSONL "latest record wins" semantics become an upsert on `id`):

| column | type | why |
|---|---|---|
| `id` | TEXT PK | upsert key; detail lookup |
| `project` | TEXT | equality filter + facet DISTINCT |
| `ticket` | TEXT | prefix filter (`LIKE 'MIL-%'` — left-anchored so an index is usable) |
| `ticket_title` | TEXT | `q` substring |
| `outcome` | TEXT | IN (…) filter + facet |
| `started_at` | INTEGER (epoch ms) | range filter + default sort |
| `ended_at` | INTEGER NULL | duration sort |
| `total_tokens` | INTEGER | sort |
| `cost_usd` | REAL | sort |
| `json` | TEXT | the full serialized `RunRecord` (stages, urls, error) — returned as-is, never queried |

Indexes:

1. `idx_runs_started_at (started_at DESC)` — the default sort and the date-range filter; also serves the unfiltered first page as a pure index scan.
2. `idx_runs_project_started (project, started_at DESC)` — project filter + sort in one index, the most common combination.
3. `idx_runs_outcome_started (outcome, started_at DESC)` — outcome filter + sort.
4. `idx_runs_ticket (ticket)` — left-anchored prefix match.

`total` comes from a `COUNT(*)` over the same WHERE clause (a second query, or a windowed count in one). Free-text `q` is a `LIKE '%…%'` on `ticket_title` and cannot use an index — acceptable, since `q` is nearly always combined with a project/date filter that narrows first; if `q`-only searches over 100k+ runs become slow, add an FTS index over `ticket_title` later without changing this API contract.

Compatibility: `/api/activity?limit=50` becomes `GET /api/history?limit=50` internally (default sort, no filters) — one code path, and the existing endpoint keeps its current response shape (a bare array) so `app.js`'s Activity path is untouched.

---

## (b) UI layout

### Desktop (≥900px)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ● ticketloop  [max20x · subscription]     Activity │ History │ Setup           │
└───────────────────────────────────────────────────────────────────────────────┘

  ┌─ filter bar (.history-filters, .bg-elev card, sticky under topbar) ────────┐
  │  ┌──────────────────────────────┐ ┌───────────────┐ ┌──────────────────┐  │
  │  │ 🔍 Search ticket or title…   │ │ Project   ▾   │ │ Outcome (2)  ▾   │  │
  │  └──────────────────────────────┘ └───────────────┘ └──────────────────┘  │
  │  ┌────────────┐  ┌────────────┐  ┌────────────────┐  ┌───────────────┐    │
  │  │ From  ▤    │→ │ To    ▤    │  │ Sort: Newest ▾ │  │ 25 / page  ▾  │    │
  │  └────────────┘  └────────────┘  └────────────────┘  └───────────────┘    │
  │  ─────────────────────────────────────────────────────────────────────    │
  │  [ project: ticketloop ×] [ outcome: merged ×] [ failed ×] [ Clear all ]  │
  └───────────────────────────────────────────────────────────────────────────┘

  1,843 runs · showing 51–75                                        [ ↻ Refresh ]

  ┌───────────────────────────────────────────────────────────────────────────┐
  │ MIL-207  Fix caching header on /apply                          [ merged ] │
  │ miles-loyalty · propose                                    142.3K tok     │
  │ ▪triage ▪plan ▪prepare ▪fix ▪verify ▪review ▪ship ▪comment   $0.8412      │
  │                                                                 3d ago    │
  ├───────────────────────────────────────────────────────────────────────────┤
  │ MIL-206  Wrong currency symbol in summary                    [ pr-opened ]│  ← clicked
  │ …                                                                          │
  │ ┌─ run-detail (identical markup to Activity) ─────────────────────────┐   │
  │ │ Pull request ↗   Ticket ↗                                            │   │
  │ │ triage   [ok]   sonnet · 12.1K tok · $0.031 · 14s                    │   │
  │ │   eligible — change request                                          │   │
  │ │ fix      [ok]   opus · 88.0K tok · $0.512 · 3m 20s                   │   │
  │ │   edited 2 files …                                                   │   │
  │ └──────────────────────────────────────────────────────────────────────┘   │
  ├───────────────────────────────────────────────────────────────────────────┤
  │ … 23 more rows …                                                          │
  └───────────────────────────────────────────────────────────────────────────┘

           [ ‹ Prev ]   Page 3 of 74   [ Next › ]        (‹ disabled on page 1)
```

The result list is `<ul class="feed">` — the **same** element class Activity uses, so rows inherit every existing style (`.run`, `.run-head`, `.run-main`, `.run-side`, `.badge-*`, `.stages`, `.stage-pill`, `.run-detail`) with no new CSS for rows or detail.

### Controls, concretely

- **Search box** — `<input class="input">` with a leading 🔍 and a `×` clear affordance once non-empty. Placeholder: `Search ticket or title…`. Maps to `q`.
- **Project** — native `<select class="input">`, options: `All projects` + facet list. Native select keeps it dependency-free and mobile-native.
- **Outcome** — a small custom popover (a `<details>`/button + panel using existing `.modal`-ish surface tokens) with a checkbox per outcome, each labelled with the same coloured `.badge badge-<outcome>` pill used in rows, so the legend and the filter are the same visual language. Button label: `Outcome` → `Outcome (2)` when narrowed. `Select all` / `Clear` inside.
- **From / To** — two `<input type="date" class="input">`, `min`/`max` set from facets `earliest`/`latest`. Plus quick chips above them: `Today · 7d · 30d · All` which just set both dates.
- **Sort** — `<select>`: `Newest first` (default), `Oldest first`, `Most expensive`, `Most tokens`, `Longest run`.
- **Page size** — `<select>`: `25` (default), `50`, `100`.
- **Active-filter chips** — one removable chip per active constraint, plus `Clear all`. This is the honest answer to "why am I seeing no results" and makes state visible when it's been restored from the URL.
- **Result count line** — `1,843 runs · showing 51–75`. Singular `1 run`. When any filter is active: `1,843 runs match · showing 51–75`.
- **Refresh** — a ghost button; History does not poll, so this is the way to pick up runs completed since the page was opened.
- **Pagination** — `‹ Prev` / `Page N of M` / `Next ›`, disabled at the ends. Duplicated at top-right of the list only as the compact `showing X–Y` text (no second button pair — avoids the "which one did I click" confusion).

### Responsive (<900px)

- Filter bar collapses to a stacked grid: search full-width on its own row; Project/Outcome side-by-side; From/To side-by-side; Sort/Page-size side-by-side.
- Below 640px, a `Filters (2)` toggle button collapses the whole bar to save vertical space; the active-filter chips stay visible when collapsed so filters are never silently applied off-screen.
- Rows already reflow (existing `.run-head` styles); the side column drops under the main column.
- Pagination buttons go full-width-ish with larger tap targets (≥44px).

### States

**Loading (first load / filter change).** Keep the filter bar interactive. Replace the list with 3 skeleton rows (`.run` shaped, `--bg-elev-2` blocks, subtle pulse). The count line shows `Searching…`. Never blank the screen — the previous results stay until the new ones arrive is *not* used here because it makes a slow query look like a no-op; skeletons are clearer.

**Loading (page change).** Different: keep the current rows, dim the list to 50% opacity, disable Prev/Next. Paging feels like movement, not a reload.

**Empty — no runs at all** (total 0 with no filters):
> `No runs recorded yet.` — with a link/hint: *runs appear here after the loop processes a ticket. Try* **Scan now** *on Activity.*

**Empty — no matches** (total 0 with filters):
> `No runs match these filters.` + `[ Clear all filters ]` button. If the only culprit is a date range with data outside it, add: *the oldest run is from 8 Nov 2025.*

**Error.** Reuse `.warnings` box styling (as Setup does with `#setupError`): `Could not load history: <message>` + a `Retry` button. The filter bar stays usable; previously-loaded rows are cleared so nothing stale is presented as current.

**Stale/offline.** The topbar `reconnecting…` indicator (`#connState`) is Activity-driven; on History a failed fetch just produces the error state above.

---

## (c) UX details

### Debounced search

`q` and `ticket` are debounced **300ms** after the last keystroke. Enter submits immediately (cancels the pending timer). Select/date/outcome changes fire **immediately** — they're discrete, and waiting feels broken. Every request carries a monotonically increasing sequence number; a response whose sequence is not the latest is discarded, so a fast typist never sees results from an abandoned query land after the current ones. In-flight requests are aborted via `AbortController` when superseded.

### URL as the state container

Filter state lives in the query string of the page URL, e.g.

```
/#history?project=miles-loyalty&outcome=merged&outcome=failed&q=cache&from=2026-01-01&sort=started_desc&limit=25&offset=50
```

- Serialized names match the API params exactly — one mapping, no translation layer.
- Written with `history.replaceState` on debounced/filter changes (so typing doesn't spam the back stack) and `history.pushState` on **page** changes (so Back means "previous page of results", which is what people expect).
- Read on load and on `popstate` → rehydrates every control. Consequence: a filtered search is **linkable and bookmarkable** ("here's every failed run on miles-loyalty last week").
- Defaults are omitted from the URL to keep it short; absent param = default.
- Tab identity is part of it: the `#history` fragment selects the tab, so a shared link opens the right view. Activity stays at `/` or `#activity`, Setup at `#setup` (a small generalization of the existing `setView`).

### Expansion + pagination

- Expansion state is a `Set` of run ids, exactly as Activity does today (`state.expanded`).
- Because a page's `runs[]` already include `stages[]`, expanding is **synchronous** — no spinner, no fetch. If a record somehow lacks stages, fall back to `GET /api/activity/:id` and show the existing `Loading detail…`.
- **Changing page or filters collapses everything.** Expanded state is per-result-set; carrying ids across pages produces the confusing "I expanded a row and now a different row is open" effect when ids recur. It is also not persisted to the URL — too noisy, low value.
- Rendering is *not* on a poll here, so the signature/`renderFeedFromState` scroll-preservation dance Activity needs is unnecessary: History re-renders only in response to user action. On page change, scroll to the top of the list (not the top of the document — the filter bar stays put).
- One expansion nicety Activity lacks and History should have: `Expand all` / `Collapse all` in the count line, since scanning 25 archived runs' stage summaries at once is a real use.

### Relationship to Activity

- **Activity = live recent.** Unchanged: quota meters, live monitor, ~50 newest runs, fast poll, no controls. It is a status board.
- **History = searchable archive.** Everything ever recorded, query-driven, no poll, no meters.
- They intentionally overlap at the top (today's runs appear in both). That's fine and expected — Activity is *how it's going*, History is *what happened*.
- Shared code, one visual language: `renderRun`, `renderStageTracker`, `renderDetail`, `renderStageDetail`, all badge/pill/format helpers (`fmtTokens`, `fmtMoney`, `fmtRelative`, `fmtDuration`, `fmtClock`) are used by both. A change to how a run looks changes both views at once — non-negotiable, otherwise they drift.
- One cross-link: a run row's timestamp already carries a `title` tooltip with absolute times; History additionally gives each row a copyable deep link (`#history?run=<id>` opens History filtered to that single run, expanded). Cheap, and it's how you paste "look at this run" into a chat.
- A `running` run shown in History is rendered identically to Activity's (live duration ticking is a poll effect, so in History it simply shows the elapsed time at fetch; `Refresh` updates it). Users who want live should be on Activity — a subtle hint on any `running` row: *live view →* linking to Activity.

### Accessibility & keyboard

- Filter bar is a `<form>` with `role="search"`; `/` focuses the search box; `Esc` inside it clears.
- Rows: the clickable `.run-head` gets `role="button"`, `tabindex="0"`, `aria-expanded`, and Enter/Space toggles — worth adding to the shared renderer, which improves Activity too.
- Result count line is `aria-live="polite"` so screen readers hear "1,843 runs match" after a filter change.
- Pagination buttons carry `aria-label="Previous page"` / `"Next page"`; `Page 3 of 74` is plain text, announced via the same live region.

---

## Implementation notes (for whoever builds it)

- New markup: one `<div id="viewHistory" class="view" hidden>` in `index.html` + a `History` nav button; `setView` generalizes from a 2-way boolean to an n-way loop over view ids.
- New CSS: only the filter bar, chips, pagination, skeleton rows. Rows/detail reuse existing classes. Stick to the existing tokens (`--bg-elev`, `--border`, `--accent`, `--text-dim`) — no new colours.
- New JS module surface: `history.js` (or a section of `app.js` if it stays small) owning `{ filters, page, total, runs, expanded, seq }`, `readFiltersFromUrl()`, `writeFiltersToUrl()`, `fetchHistory()`, `renderHistory()`. Row rendering imported from the shared code, not duplicated.
- Backend: `/api/history` + `/api/history/facets` follow the existing `if (path === …) return json(res, …)` pattern; param parsing/validation in a small `parseHistoryQuery(url.searchParams)` that returns either a query object or a `{error}` for a 400.
