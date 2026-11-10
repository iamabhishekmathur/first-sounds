# First Sounds

A tablet web app for a parent and a 3-year-old to learn the sounds of English before reading.
The parent records every sound in their own voice; the games play those recordings.

Plain static site: HTML, CSS and ES modules, with no framework, build step or service worker. All
paths are relative, so it works from any sub-path. Optional sync (below) adds two small Vercel
functions under `api/` that store recordings and progress in a private Vercel Blob store.

## Run locally

```sh
node tests/server.mjs 8080     # then open http://127.0.0.1:8080/
```

Any static server works. Recording needs a secure origin (https:// or localhost).
To use it on an iPad, host the folder on an HTTPS origin, open it in Safari and use
Share > Add to Home Screen.

## Sync with a family code

Each device keeps everything in IndexedDB, so the app loads instantly and works offline. Once the
parent enters the family code (parent area, or the welcome screen of a new device: "Sync with your
family code"), the server becomes the source of truth and IndexedDB is the local cache.

- **When:** on start, on return to the foreground, when the browser comes back online, and after
  every change. A new recording is uploaded as soon as it is saved, and progress pushes are
  debounced by 2.5 s. On failure it retries with a backoff (5 s doubling to 5 minutes). Every
  recording newer on the device than on the server is queued: one failed upload does not stop the
  others, and requests give up after 30 s so a stalled connection cannot block later syncs.
- **Merge rules** (`js/syncdoc.js`, used by both the app and the server): every round has a stable
  id (old rounds get a deterministic one), and progress is the union of rounds by id, oldest first,
  with the usual last 12 per sound kept. Readiness results are a union by id. Settings and each
  recording are last-writer-wins by timestamp. "Reset progress" is a timestamp: every device drops
  only the rounds played before it. The first device to enter the code uploads everything, and
  later devices merge in the same way, so nothing is lost.
- **Status** shows at the top of the parent pages only (synced / syncing / offline / server problem
  / code not accepted). The child screens never show sync state or wait for the network.
- **Backups** still work. The code is never in a backup. Importing a backup on a syncing device
  replaces local data, then merges it with the server, which never removes anything there.
- Deleting a recording through the API does not reach devices that still have it: they upload it
  again on their next sync. The app itself has no delete button.

### Server

`api/state.js` and `api/recording.js` (Node runtime, `@vercel/blob`). The request handling is in
`api/_lib/core.js`. Every request needs the header `x-family-code`; without it, or with a wrong
code, the answer is an empty 401. The code is compared in constant time, ignoring case, spaces and
dashes.

| Route | Purpose |
| --- | --- |
| `GET /api/state` | The family's doc: settings, progress, readiness, recording metadata |
| `PUT /api/state` | Merge a device's state (checked and limited to known sound ids, 512 KB max) |
| `GET/PUT/DELETE /api/recording?id=<sound id>` | One recording (audio only, 2 MB max; an older upload never replaces a newer one) |
| `DELETE /api/state` with `x-confirm: erase-everything` | Delete all recordings and state (not used by the app) |

Storage: a **private** Vercel Blob store (`first-sounds-blob`). Blobs can only be read with the
store token, so audio reaches the app only through `/api/recording` after the code check. The
layout is append-only: no request overwrites or conditionally writes a blob, so concurrent requests
cannot conflict and nothing is ever read stale.

- `recordings/<sound>/<updatedAt>-<durationMs>-<t|u>-<rand>.<ext>`: one blob per uploaded version.
  The newest wins, and older versions of that sound are deleted after a newer upload.
- `state/push/<time>-<rand>.json`: one blob per `PUT /api/state`. `state/snap/<time>-<rand>.json`:
  a compaction. The state is the merge of all of them (the same merge rules as the app). Above 20
  blobs, a request writes a snapshot of everything it read, then deletes exactly those blobs.
- The earlier layout (`state/family.json` and `recordings/<sound>/<updatedAt>-<hex>`) is migrated by
  the first request that sees it: copied into the new layout, then the copied originals deleted.

Every Blob call has a 6 s timeout and at most one retry, and a request answers 503 after 9 s, so a
slow store makes devices retry instead of waiting.

Project environment variables (no values here):

- `BLOB_READ_WRITE_TOKEN`: set by Vercel when the Blob store is connected to the project.
- `FAMILY_CODE`: the family code (sensitive type; production and preview). To change it, replace
  the variable and redeploy. Every device then shows "code not accepted" until the new code is
  entered.
- `DATA_PREFIX` (preview only, such as `test-abc/`): puts every blob of that deployment under its
  own prefix, for testing a preview without touching the family's data. Production has none.

### Deploy

The project is `first-sounds` on Vercel, with framework "Other" and no build command. Vercel
installs `package.json` dependencies and turns `api/*.js` into functions (`vercel.json` sets their
duration and includes `data/sounds.json`). Upload `index.html`, `manifest.webmanifest`, `icons/`,
`css/`, `js/`, `data/`, `api/`, `package.json`, `package-lock.json` and `vercel.json` (not `tests/`
or `screenshots/`) as a production deployment, either with `vercel deploy --prod` or with
`POST https://api.vercel.com/v13/deployments` (files inline, `target: "production"`).

Locally, `node tests/server.mjs` also serves a fake of the API (an in-memory store, using the same
`api/_lib/core.js`). It accepts the code in `$FAMILY_CODE`, or `local-test-code-11` by default.

## Tests

```sh
/opt/node22/bin/node --test "tests/**/*.test.mjs"
```

- `tests/unit/`: the schema validator, the mastery and scheduling rules (`js/logic.js`), the
  pure audio helpers (silence trimming, WAV encoding, mime type detection), the sync merge rules
  (`syncdoc.test.mjs`) and the API handling (`api.test.mjs`: code check, size and id limits,
  concurrent writes, last-writer-wins recordings).
  `blobstore.test.mjs`: the append-only layout (40 writes at once with a lagging listing, two
  compactions at once, legacy migration, the data prefix, fast failure when the store hangs).
- `tests/browser/`: Playwright (Chromium, fake microphone, iPad-landscape touch viewport) against
  `tests/server.mjs`. Covers first run, recording and persistence, the parent gate, microphone
  denied or unavailable, storage unavailable, a full session, stage 2 unlocking, the readiness
  check, settings, reset, and export/import.
- `tests/browser/realdata.test.mjs` checks the real `data/sounds.json`. It is skipped if the file
  is missing.
- `tests/browser/sync.test.mjs`: entering the code, first upload, a fresh profile pulling the same
  recordings and progress, a recording uploaded straight away, a wrong code, offline then
  reconnecting, the server down, failed uploads retried by themselves, two devices playing offline at once, a reset, and backups.
- `tests/browser/screenshots.test.mjs` writes every screen to `screenshots/`.

Test hooks are URL parameters: `?data=<path>` (data file), `?today=YYYY-MM-DD` (date used for
mastery and readiness), `?seed=<n>` (repeatable randomness), `?db=<name>` (IndexedDB name),
`?syncRetry=<ms>` and `?syncDebounce=<ms>` (sync timing).

## Code layout

| File | Purpose |
| --- | --- |
| `js/data.js` | Loads `data/sounds.json` and validates the schema |
| `js/storage.js` | IndexedDB (recordings + key/value state), in-memory fallback, backup export/import |
| `js/sync.js`, `js/syncdoc.js` | Sync with the server; the sync document and its merge rules |
| `api/` | Vercel functions for sync (`_lib/` holds shared code, not routes) |
| `js/audio.js` | Recording (MediaRecorder), silence trimming, playback (Web Audio), tones, word speech |
| `js/logic.js` | Pure mastery, unlocking, target choice and distractor rules (no DOM) |
| `js/game.js` | Child screens: home, Hear it, See it, readiness, all done |
| `js/parent.js` | Welcome, parent menu, recording studio, progress, settings and backup |
| `js/ui.js`, `js/app.js` | DOM helpers and parent gate; boot, shared state, navigation |

## The data file

`data/sounds.json` (`version: 1`) has `sounds`, `words` and `readinessPairs`. A word "starts with"
a sound when that sound is `phonemes[0]`. `graphemes[0]` is the letter shown to the child. Only
sounds with at least 3 starting words are game targets; this is worked out from the data. Two
sounds that show the same `graphemes[0]` (such as `th_unvoiced` and `th_voiced`) are never offered
in the same round. If the file fails validation the app shows the errors to the parent and does
not start. Warnings are listed under the parent menu.

## How the rules are applied

- **Solid** means at least 5 of the last 6 rounds were right first time, across at least 2
  calendar days. A sound with fewer than 6 rounds is still "learning".
- **Unlocking**: group 1 is always open. A later group opens once every target sound in the group
  before it is recorded and solid in Hear it. A sound reaches See it once it is solid in Hear it.
- **Target choice**: about a quarter of rounds review solid sounds. A new sound is introduced only
  when no more than 3 are learning, and no more than 2 per session (per stage) so that the first
  session is not four new sounds in six rounds.
- **Choices**: 2, or 3 once a sound is going well (solid, or 3 of its last 4 right first time).
- **Readiness**: a bonus round half way through a session, at most once a day, after group 1 is
  solid in See it. It does not count toward the session's rounds.

## Known limitations

- Only tested in Chromium. Safari behaviour (audio unlocking, `audio/mp4` recording, decoding for
  trimming, Blob downloads, safe areas, standalone mode) is written for Safari's known constraints
  but has not been run on a real iPad.
- Recordings are stored as WAV bytes (an ArrayBuffer plus mime type) instead of a Blob object.
  This avoids older WebKit bugs with Blobs in IndexedDB. If Web Audio cannot decode a recording,
  the original is kept untrimmed.
- The child's letters use the font stack `Andika, Chalkboard SE, Comic Sans MS, ...`. On iPad,
  Chalkboard SE should give a single-storey "a" and "g". Other systems may show the double-storey
  forms (the Chromium screenshots do).
- Word speech uses the device voice, so it depends on which voices are installed.
- The speaker badge on each picture is 64 px, smaller than the 120 px child targets, because it is
  a secondary control inside the 150 px or larger picture card.
- Without a family code, storage is per browser. Safari may clear site data that has not been used
  for a while unless the app is added to the Home Screen. Use sync or the backup export. On iPad,
  Safari and the Home Screen app have separate storage, so enter the code in the one you use.
- Sync has no rate limit on wrong codes. The code is three words from a list of about 170 plus two
  digits, which is hard to guess online but is not a password.
