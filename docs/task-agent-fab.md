# Task assistant FAB

The assistant opens from the planner shell and accepts typing or the browser's speech recognizer. Speech recognition availability and processing location depend on the browser; the editable text path always works. Spoken replies use the browser's speech synthesizer and are off until the user enables them.

The server reads a bounded, owner-scoped list of task titles and active objectives. It sends only those fields and recent conversation turns to the configured LLM backend. The model returns structured proposals for creating tasks, updating task fields, or moving tasks between objectives. The server validates action kinds, IDs, dates, times, priority, and count. No proposal writes data. The client shows each action, then applies confirmed changes through the existing authenticated task and objective APIs, which retain their normal audit and update behavior. A failure after a partial batch reports how many changes succeeded and requires a fresh plan before retry.

The sheet follows the [WAI modal dialog keyboard pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/): focus enters it, Tab stays inside, Escape closes it, and focus returns to the trigger. Text remains available when speech recognition is unsupported; [MDN notes](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition) that some browsers send audio to a recognition service. The action allowlist and approval step follow [OWASP's guidance](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) to validate tool arguments outside the model and require review for consequential changes.

## Limits for this version

- The server can inspect all of the owner's tasks, including completed and archived tasks. It sends only the strongest title matches (up to 80) to the model. If a request does not identify a task, the model sees the 40 most recent tasks and should ask for a narrower request.
- A semantic screen snapshot includes the route, selected tab, visible headings, and selected entity. It does not capture unsaved form fields or arbitrary page text. The assistant is available on all authenticated screens.
- Metrics recaps come from the same owner-scoped task metrics service as the Balance metrics tab. The response labels rolling windows and separates current open counts from windowed completions.
- Up to four actions can be proposed per turn. Deletion, bulk rearrangement, and changes to shared tasks are outside the assistant's tool set.
- Conversation state is held in the open sheet and is cleared when it closes.
- Speech is one utterance at a time. The transcript can be edited before sending.

## Follow-up quality work

- Add server-side candidate search over all owned tasks so old tasks remain addressable without sending the full backlog to the model.
- Persist conversations and action receipts with redaction controls.
- Add optimistic version checks and undo for reversible edits.
- Measure task matching, clarification, and action success on a fixed evaluation set before enabling automatic single-action execution.
