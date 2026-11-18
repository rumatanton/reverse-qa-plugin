## Lessons from real runs - Memory (reverse-qa)

What exploring real apps taught, and the rule since. Each starts with the name of the fix in bold, then the date and the name of the person who confirmed it; the rule follows a bold **Rule:**. Follow them over anything above.

- **Explore as each role.** Anton: Explore as each role with the accounts in target.yaml `test_accounts`. The customer account is signed up fresh for each run; never use a seeded customer row (real people's data).
- **Plan hand-off as a flow.** 2026-11-10, Anton: the payment redirect is a hand-off, not a page: it auto-submits a form to the payment gateway, which every test blocks. **Rule:** plan it as an integration flow (payment form, hand-off, callback) with database checks, not as a page visit.
- **Write the hover step.** 2026-11-10, Anton: on a shop app the category and product buttons appear only when the card under the pointer flips or slides. **Rule:** write "hover the card, then click …" into the step, so the generator does the same.
- **Note every redirect.** Anton: Note every page that ends in a redirect: on this app several keep running after it (no `exit`), which is a defect to test, not page behaviour to plan around.
