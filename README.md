# First Sounds

A tablet web app for a parent and a 3-year-old to learn the sounds of English before reading.
The parent records every sound in their own voice; the games play those recordings.

Plain static site: HTML, CSS and ES modules. No framework, build step, dependencies, network
requests or service worker. All paths are relative, so it works from any sub-path.

## Run locally

```sh
node tests/server.mjs 8080     # then open http://127.0.0.1:8080/
```

Any static server works. Recording needs a secure origin (https:// or localhost).
To use it on an iPad, host the folder on an HTTPS origin, open it in Safari and use
Share > Add to Home Screen.

## Tests

```sh
/opt/node22/bin/node --test "tests/**/*.test.mjs"
```

- `tests/unit/`: the schema validator, the mastery and scheduling rules (`js/logic.js`) and the
  pure audio helpers (silence trimming, WAV encoding, mime type detection).
- `tests/browser/`: Playwright (Chromium, fake microphone, iPad-landscape touch viewport) against
  `tests/server.mjs`. Covers first run, recording and persistence, the parent gate, microphone
  denied or unavailable, storage unavailable, a full session, stage 2 unlocking, the readiness
  check, settings, reset, and export/import.
- `tests/browser/realdata.test.mjs` checks the real `data/sounds.json`. It is skipped if the file
  is missing.
- `tests/browser/screenshots.test.mjs` writes every screen to `screenshots/`.

Test hooks are URL parameters: `?data=<path>` (data file), `?today=YYYY-MM-DD` (date used for
mastery and readiness), `?seed=<n>` (repeatable randomness), `?db=<name>` (IndexedDB name).

## Code layout

| File | Purpose |
| --- | --- |
| `js/data.js` | Loads `data/sounds.json` and validates the schema |
| `js/storage.js` | IndexedDB (recordings + key/value state), in-memory fallback, backup export/import |
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
- Storage is per browser. Safari may clear site data that has not been used for a while unless the
  app is added to the Home Screen. Use the backup export.
