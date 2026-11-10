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
  with the last 30 per sound per stage kept (mastery looks at the last 6; the rest feeds the Tracker).
  Readiness results are a union by id. Sessions are a union by id too; a session grows while it is
  played, so of two versions of one session the one with more rounds wins (the last 500 are kept). Settings and each
  recording are last-writer-wins by timestamp. "Reset progress" is a timestamp: every device drops
  only the rounds, readiness results and sessions from before it. The first device to enter the code uploads everything, and
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
| `PUT /api/state` | Store a device's state, merged into the doc (checked and limited to known sound ids, 512 KB max). Answers with what it stored. Documents from before sessions existed (no `sessions`, rounds without `ses`/`wrong`) are accepted as they are |
| `GET/PUT/DELETE /api/recording?id=<sound id>[&v=<version>]` | One recording (audio only, 2 MB max; an older upload never replaces a newer one). `v` is the `version` that `GET /api/state` gives |
| `DELETE /api/state` with `x-confirm: erase-everything` | Delete all recordings and state (not used by the app) |

Storage: a **private** Vercel Blob store (`first-sounds-blob`). Blobs can only be read with the
store token, so audio reaches the app only through `/api/recording` after the code check. The
layout is append-only: no request overwrites or conditionally writes a blob, so concurrent requests
cannot conflict and nothing is ever read stale.

- `recordings/<sound>/<updatedAt>-<durationMs>-<t|u>-<rand>.<ext>`: one blob per uploaded version.
  The newest wins, and superseded versions are deleted by the next `GET /api/state`.
- `state/push/<time>-<rand>.json`: one blob per `PUT /api/state`. `state/snap/<time>-<rand>.json`:
  a compaction. The state is the merge of all of them (the same merge rules as the app). Above 20
  blobs, a request writes a snapshot of everything it read, then deletes exactly those blobs.
- The earlier layout (`state/family.json` and `recordings/<sound>/<updatedAt>-<hex>`) is migrated by
  the first request that sees it: copied into the new layout, then the copied originals deleted.

Sessions and wrong taps add no Blob operations: they travel inside the same debounced progress
push (`PUT /api/state`) as the rounds they belong to.

Operations are kept few because the Hobby plan includes 2,000 Blob "advanced" operations (puts and
lists) a month, and the store stops working for the rest of the period beyond that: each PUT is one
put, only `GET /api/state` lists, recordings are read by name (cached reads are free), deletes are
free. The app fetches the state at most once a minute while pushing progress during play.

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

## The Tracker (parent area)

Parent area > Tracker shows how practice is going. Every figure comes from pure functions in
`js/tracker.js` (unit tested); `js/tracker-view.js` only renders them, with small inline SVG charts
(text labels, hover titles, and a "show the numbers" table, so nothing is colour-only).

- **Summary:** days practised in the last 7 and 30 days, sessions and minutes, right-first-time in the
  last 7 days against the 7 before, sounds solid per stage (out of the game targets), readiness check.
- **Over time** (30 days): rounds per day, right-first-time per day, solid sounds per stage.
- **Recent sessions:** date, time of day, length, stage(s), rounds, right first time.
- **Sounds:** one row per sound with group, mode, status and last-6 score per stage, days practised,
  last practised and a trend (the last 8 rounds of the stage being worked on; up/down compares the
  last 4 with the 4 before). Ordered "needs attention first" (learning sounds with the lowest recent
  score first), or by group, recency or days.
- **Mix-ups:** target sound, then the sound tapped instead (in an "anywhere" round, the picture),
  with counts.
- **Recordings:** sounds still to record (game targets first) and recordings not trimmed.

What is recorded for it (from this version on; older data simply has none and still counts):

- `kv.sessions`: `[{ id, d, start, end, stages: [1|2], rounds, correct }]`, one per tap on Play,
  saved from its first round on and updated after every round.
- Each round gains `ses` (its session id) and, if any, `wrong: [{ w: word } | { g: grapheme }, s?]`
  where `s` is the sound the tapped picture or letter stands for in that round.

Per-day figures use a session's own totals for its rounds, plus every round with no known session
(rounds played before sessions existed), so nothing is counted twice. Solid-over-time is worked out
from each sound's kept history; when a history has been cut to 30 rounds, earlier days use the
status of its oldest kept rounds. A brand-new install shows an explanation instead of empty figures.

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
- `tests/browser/tracker.test.mjs`: an "ends with" and a "has this sound" round with their parent
  prompts (Hear it and See it), a session recorded and shown in the Tracker, the empty state, and
  loading data saved by the previous version (an old local store and an old server doc).
- `tests/unit/modes.test.mjs` (position modes and round rules per mode) and
  `tests/unit/tracker.test.mjs` (the Tracker's figures). `tests/fixtures/sounds.modes.json` has
  sounds in all three modes in group 1 (m and s start, ng end, oo anywhere).
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
| `js/logic.js` | Pure position modes, mastery, unlocking, target choice and distractor rules (no DOM) |
| `js/game.js` | Child screens: home, Hear it, See it, readiness, all done |
| `js/parent.js` | Welcome, parent menu, recording studio, progress, settings and backup |
| `js/tracker.js`, `js/tracker-view.js` | The Tracker: pure figures, and the screen that renders them |
| `js/ui.js`, `js/app.js` | DOM helpers and parent gate; boot, shared state, navigation |

## The data file

`data/sounds.json` (`version: 1`) has `sounds`, `words` and `readinessPairs`. A word "starts with"
a sound when that sound is `phonemes[0]` and "ends with" it when it is the last phoneme.
`graphemes[0]` is the letter shown to the child. Two sounds that show the same `graphemes[0]` (such
as `th_unvoiced` and `th_voiced`) are never offered in the same round.

**Reduced vowels.** A word may have `"reduced": [index, ...]`: the indices (from 0) of its
unstressed reduced vowels, such as the schwa written `u` in apple (`a p u l`, `[2]`), banana
(`b u n a n u`, `[1, 5]`) or television (`[3, 7]`). The validator checks that each index is a whole
number within the phonemes and points at a vowel (the vowel ids are listed in `js/data.js`). A
reduced position never makes a word a right answer and never counts towards a mode, so a "u" round
(the parent's "uh" as in sun) never accepts apple or giraffe. Distractors still must not contain the
target anywhere, reduced or not. Full but unstressed vowels (the final ee of puppy, the oe of
window) and the unstressed er of tiger are not marked.

**Position modes.** Each sound gets a mode, worked out from the words (never from the sound id), in
the order children develop the skill: `start` if at least 4 words start with it, otherwise `end` if
at least 4 end with it, otherwise `anywhere` if at least 4 contain it (reduced positions excluded). A sound with fewer than 4 words
containing it is not a game target. The parent prompt names the mode ("…the picture that starts with
this sound", "…ends with this sound", "…has this sound in it"), in Hear it and in See it's
letter-to-picture rounds. The studio, Progress and Tracker show each sound's mode, or why it is not a
target. Mastery, unlocking and scheduling stay per sound per stage. If the file fails validation the app shows the errors to the parent and does
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
  The right picture has the target in the sound's mode position. A distractor never contains the
  target (or a sound shown with the same letters) anywhere, has a different sound in the tested
  position from the other distractors, and while the target is not solid has none of its confusable
  sounds in the tested position (for `anywhere`: nowhere in the word).
- **After a data change**: a group the child has already played in stays open, and a child who has
  played keeps playing, even if the change made new targets of earlier (not yet recorded or solid)
  sounds, as position modes did for the th sounds, ng and the long vowels.
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
