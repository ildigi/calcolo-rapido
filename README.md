# Calcolo rapido

A small installable web app (PWA) for mental-arithmetic speed drills, modelled on the Zetamac Arithmetic Game: 120 seconds, the next problem appears as soon as the typed answer is correct.

Presets:

| Preset | Operations | Ranges |
|---|---|---|
| T12 | × and ÷ | (2–12) × (2–12) |
| T100 | × and ÷ | (2–12) × (2–100) |
| Default | + − × ÷ | (2–100) + (2–100), (2–12) × (2–100) |

Subtraction is addition in reverse and division is multiplication in reverse, as in Zetamac.

Features: on-screen keypad (and physical keyboard), automatic pause when the app goes to the background, the five slowest problems of each game, personal best and last score per preset, a one-line daily summary to copy into a diary.

Accounts and sync: the app opens on a sign-in screen and has no sign-up. Games are kept on the device (`localStorage`) and uploaded to a Supabase table (`cloud.js`, plain `fetch`, no SDK), with an offline queue and idempotent ids. The publishable key in `cloud.js` is public by design: row-level security only lets an allow-listed account read or add its own rows, and sign-ups are disabled in the project settings.

No build step and no dependencies: plain HTML, CSS and JavaScript. `sw.js` caches the files so the app works offline once installed.

Run locally:

```bash
python -m http.server 5310 --directory trainer
```

Install on iPhone: open the HTTPS URL in Safari, Share → Add to Home Screen.
