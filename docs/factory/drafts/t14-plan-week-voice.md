> **Type:** Frontend
> **Phase:** FTUE / Weekly Planning Assistant — Wave 4 (DEFERRED)
> **Branch:** `feat/plan-week-voice`
> **Commit style:** `feat(plan-week): voice input for the assistant`
> **Design:** this ticket is the spec (STUB — full commit-recipe to be drafted when Wave 4 starts). See `docs/ftue-plan.md`.
> **Dependencies:** T8 (parse free-text → intent — voice feeds the same text path)

> ### 🚧 OPEN but DEFERRED — issue #350. A stub, not a commit recipe.
> Nothing here has been built, and the full recipe is still to be drafted (see the Design line
> above). Treat this as intent only: it is a snapshot from 2026-07-14 authoring, taken before the
> migration head moved **0126 → 0130** and the ENTITY wave (#357–#375) landed.

## Goal

Let the assistant's free-text prompt accept **talk** as well as type: a mic button captures speech via the browser **Web Speech API** (`SpeechRecognition` / `webkitSpeechRecognition`), transcribes to text locally, and feeds the existing text input → the T8 parse path. No cloud STT (local-first invariant). Degrades cleanly to typing when the API is unavailable or Ollama is down.

## Non-goals

- Do not add a server-side or cloud speech-to-text service (local-first; browser API only).
- Do not add a new NL endpoint — voice produces text for the existing T8 `/api/plan-week/parse` path.
- Do not build voice output/TTS.

## Status

**STUB — tracking only.** Full commit-recipe (exact files, feature-detection, permission handling, fallback, tests) to be drafted when Wave 4 begins. Locked decisions: browser Web Speech API only; mic → existing free-text box → T8 parse; must degrade to typing; gated with the free-text box (hidden when `!aiAvailable()` since parsing needs Ollama).

## Definition of Done (high-level)

- [ ] Full commit-recipe body drafted + approved
- [ ] Mic button on the assistant PromptStep; speech → text → T8 parse
- [ ] Graceful fallback to typing (no `SpeechRecognition`, denied mic, or `!aiAvailable()`)

## Subtasks

1. [ ] Draft the full body when Wave 4 starts (feature-detect, permission UX, fallback matrix)
2. [ ] Implement mic capture → transcript → existing input
3. [ ] Tests: fallback-to-typing when API absent / permission denied
