# Interaction and verification checklist

## Browser operation

- Use the existing signed-in app page when available. For a browser automation tool, follow its current skill and API instructions; do not improvise unsupported calls.
- Prefer role/name/label-based controls and visible text over brittle selectors. Re-read the page after route changes, opening a drawer/modal, applying filters, or saving.
- Keep the user in control of sign-in, one-time codes, device permission prompts, and CAPTCHA. Ask them to finish that step, then continue from the resulting page.
- Do not rely on screenshots alone for task content if the page exposes accessible text. Do not save screenshots with real account/task data unless explicitly requested and stored in a user-approved location.

## Before a mutation

- Identify the exact entity by title plus enough context (date/status/owner) to distinguish duplicates.
- Normalize relative dates to the app's timezone and verify the rendered target date before saving.
- Inspect all fields the app will change. For assistant suggestions, bulk edits, reflow, imports, and job runs, review the preview/result list before committing.
- If a user asks for a broad action, identify exact range and count. Ask only for the missing scope that changes the outcome.

## After a mutation

- Wait for the save/loading indicator or navigation to settle.
- Verify the resulting value in the card, list, calendar, summary, or settings control. For a schedule change, verify date and time; for a recurring task, verify the scope; for an integration, verify connection status.
- For delete/cancel, verify the row leaves the active view and check the archive/cancelled view if the result matters.
- If a confirmation or error appears, read it fully. Do not click through unexpected warnings or retry a possibly completed operation blindly.
- Report completed changes separately from unavailable/failed actions. Include exact records/date window only as needed to make the result clear.

## Common recovery paths

- If a control is absent, inspect role permissions, active tab/filter, responsive overflow menu, and empty/loading state before concluding it is unsupported.
- If a save fails, keep the user's original data intact, report the error, and avoid repeating external side effects until state is inspected.
- If an integration opens an external sign-in page, let the user authenticate. Resume from the callback and verify the in-app connection state.
- If a reset screen says the link was written to logs, do not claim the password is recoverable from the app. Use the server operator's supported reset path; never retrieve or expose a password.
