## Lessons from real runs - Memory (reverse-qa)

Failures found while healing, and the rule since. Each starts with the name of the fix in bold, then the date and the name of the person who confirmed it; the rule follows a bold **Rule:**. Follow them over anything above.

- **Heal test failures only.** Anton: Heal only failures that triage-failures labelled `test`. A PHP fatal, a server error or a wrong database row is the app's: leave the test failing and report it, never change the assertion to match.
- **Wait for app state.** 2026-11-10, Anton: a check passed headless and failed in a slow, headed run. Cause: it read the page while the page was still changing (an auto-submitting form). **Rule:** wait for the app's own state (`openPage()`, `document.readyState`, a URL or an element), never a fixed sleep or a longer timeout.
- **Hover, then click.** 2026-11-10, Anton: clicks failed because a covering element took the pointer. **Rule:** hover the card that hides the control, then click; never `force: true`.
- **Never heal into a skip.** Anton: Never turn a failing test into `test.skip()`. A test that cannot run fails with its reason.
- **Keep the finding ID prefix.** 2026-11-10, Anton: known-defect tests now confirm a finding only when they fail at the assertion whose message starts with the finding ID. **Rule:** when healing one, keep that `F-NNN:` prefix and the assertion it sits on; if the test now fails somewhere else, fix the precondition, never move the ID to make it count.
