# Spotlight "Ask Oyster" row — design (PR 3 of unified scope UX)

**Status:** Approved · 2026-06-05 · branch `spotlight-ask-row`

## Goal

⌘K becomes the keyboard path to Ask Oyster. Whenever Spotlight has a
non-empty query, an **"✦ Ask Oyster: \<query\>"** row appears as the last
result (and as the action on the no-results state). Selecting it **sends
immediately** — the panel opens with the answer streaming.

Parent spec: `2026-06-05-ask-oyster-panel-design.md` (palette as launcher,
panel as surface). Decision log: send-immediately chosen over the parent
spec's loose "pre-filled" wording (Matthew, 2026-06-05) — matches launcher
conventions and reuses the PR 2 plumbing wholesale.

## Design

- New `SpotlightHit` kind `"ask"`, appended to `flatHits` whenever
  `query.trim()` is non-empty — so ArrowDown/Enter reach it with zero new
  keyboard code.
- Activating it dispatches the existing `oyster:send-prompt` event with the
  query and closes Spotlight. App already opens the panel on that event;
  AskPanel already sends through `handleSend` (scope prefix, session-boot
  queueing). **No App/AskPanel changes.**
- Render: last row of the results list; on the no-results state the row
  renders beneath the "No results" message, so a dead end becomes an action.
- No row on the empty-query recent feed (nothing to ask).

## Out of scope

Pre-fill/edit-before-send mechanism; any panel or App changes; the
scope-hygiene seams.
