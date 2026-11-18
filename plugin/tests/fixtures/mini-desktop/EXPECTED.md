# mini-desktop: planted facts (the answer key)

A tiny desktop notes app built with Electron: no server, no browser, no database. It is used to test reverse-qa on a
desktop app: detection, the generic pack, the desktop driver (`templates/DRIVERS.md`) and the crawl of an app's own
windows. Tests assert these facts; change them only together.

- Source: `package.json` (Electron 45.3.0), `main.js`, `preload.js`, and `renderer/` with 8 pages, `app.js` and
  `style.css`. Notes are kept in `notes.json` in the app's data folder; the session is in the window's local storage.
- Detected: stack `electron`, kind `desktop`, driver `electron`. Start page: `renderer/index.html`, read from the
  `loadFile(...)` call in `main.js`.
- Outbound host: `updates.example.test` (`main.js`, the `UPDATE_URL` constant). `renderer/about.html` asks it on every
  visit. Never reached by a test.
- Roles (3): Visitor, Customer (`ann@example.test`), Admin (`admin@example.test`). Demo passwords are in
  `renderer/app.js`. Log in: the screen `login.html`, inputs `email` and `password`, submitted with Enter. A Customer
  lands on `notes.html`, an Admin on `admin.html`.
- Screens a role reaches by links (6): `index.html`, `about.html`, `login.html` for everyone; `notes.html` when
  signed in; `admin.html` and `export.html` from the Admin's menu only.
- Guards run in the page: `notes.html` sends anyone not signed in to `login.html`, `admin.html` anyone who is not an
  Admin.
- Planted defect: `export.html` has no guard. It is in the Admin's menu only, but anyone who opens it gets every
  user's notes. The crawl records Visitor and Customer as `allowed` on it.
- Links a crawl must leave alone (2): `logout.html` ("Sign out") ends the session, and `clear.html` ("Delete all
  notes") deletes every note as soon as it is opened.
- Planted accessibility issue: the image on `about.html` has no text alternative (axe `image-alt`, 1 node). The other
  5 screens have none.
- Forms (2): the login form (`email`, `password`) and the new-note form on `notes.html` (`text`, at most 200
  characters).
