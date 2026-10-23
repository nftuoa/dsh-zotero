# Changelog

## 1.0.1 — 2026-10-23

- Paper chats are created lazily on the first question (or **新对话**) instead of
  on every paper open. Browsing papers no longer grows the DSH session catalog,
  which was slowing host startup and cluttering the session list.
- Session labels in the paper chat are index-based (`对话 1`, `对话 2`, …), so
  stale or duplicated stored titles can never make every session look like the
  last-created one.
- Slimmed the client `dsh.client.inject` graph to the slots owner; other services
  are resolved lazily at action time.
- Fixed the E2E expectation for the lazy-session flow.

## 1.0.0 — 2026-10-23

- Initial public release: Zotero library folders, PDF reader, per-paper AI chat,
  KaTeX formulas, reading progress, native annotations/notes, model tools.
