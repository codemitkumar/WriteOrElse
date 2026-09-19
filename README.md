# Write or Else

An offline desktop app that decides what you write today, tracks it, and gets
progressively more annoying if you ignore it.

## Installing

Run `dist\Write-or-Else-Setup-<version>.exe` and step through the wizard. It
installs to `%LOCALAPPDATA%\Programs\Write or Else\` (a per-user install, no
admin rights needed), adds Start Menu and Desktop shortcuts, and registers a
normal Windows uninstaller (Settings → Apps, or
`%LOCALAPPDATA%\Programs\Write or Else\Uninstall Write or Else.exe`).

This install is completely independent of this source folder — everything
the app needs is bundled into the installed copy, so **this whole project
directory can be deleted after installing** without breaking anything. Keep
it around only if you plan to rebuild or modify the app later.

If you'd rather not install anything, `dist\Write or Else <version>.exe` is a
portable single-file build — just make sure to move it *out* of this project
folder before deleting the folder, since that copy isn't decoupled the way
the installed version is.

Either way it's fully offline, starts minimized to the system tray, and (by
default) launches automatically when you log into Windows, so
streak/punishment tracking works without you having to remember to open it.

All your data lives locally in
`%APPDATA%\write-or-else\write-or-else-data.json` — nothing leaves your
machine, and it survives reinstalls/updates since it's stored outside the
install directory.

## How it works

- **Books** move through five stages: `Planning` → `Writing` → `Completed`
  (drafted, not edited — you're asked for the total chapter count here) →
  `Editing` → `Done`. A book can also be **paused**, which hides it from the
  daily picker without deleting its history.
- **Daily target**: once a day, the app picks a book at random from your
  `Planning`/`Writing`/`Editing` pool (weighted toward books you haven't
  touched in a while) and assigns a word-count, chapter-edit, or
  plan-a-chapter target.
- **Planning days**: a book you flag "needs planning" always gets a
  no-word-count planning day. Books still being written get one at random too
  (15% by default) so you're not permanently under word pressure.
- **Word target progression**: the daily word goal starts at 500, climbs by 50
  every day you hit a write target, and plateaus at 5,000.
- **Word goal and running total**: a book's details dialog (kebab menu &rarr;
  *Details, cover & goal*) holds both the word goal and the words written so
  far, alongside the chapter counter for whichever stage it's in. Set both and
  the card gets a real progress bar &mdash; so a book you started long before
  installing this doesn't have to climb from zero. The running total also moves
  on its own every time you log words.
- **Logging progress** is manual, since you write in a separate tool
  (ForgeTales) — enter the word count or chapters edited when you're done, or
  use the quick-add chips on the dashboard. Both the daily target and the bonus
  round carry an **I wrote extra…** chip that stays there after the task is
  finished, so a session that ran well past the goal still gets counted. Mis-typed an entry? Delete it from
  History and the book totals (and the streak, if it was the deciding entry)
  are walked back.
- **Streak**: counts up only on days the app was actually running (i.e. your
  laptop was on and you were logged in) *and* the day's target was met. A day
  the app never ran (you were away) is skipped, not counted as a miss — it
  won't break your streak.
- **Rest days and rerolls**: one declared rest day per 7 days protects the
  streak and silences the nagging. One reroll per day swaps a target you
  haven't started yet. Set either to `0` in Settings for the original
  no-escape-hatches behaviour.
- **Bonus rounds**: clear the day's real target — whenever that happens — and
  you're handed an extra task, usually on a different book. Clear that one and
  the next arrives straight away, and so on until the day rolls over, so a good
  run never runs out of targets. They're deliberately toothless: they never
  count toward the streak, never raise your word level, and the punisher ignores
  them completely, so leaving one unfinished costs you nothing. Switch them off
  entirely in Settings.
- **Punishment**: if the target isn't met by the configured hour (default
  8pm), you'll get a nag popup every N minutes (default 20) with a "snooze"
  button. After 5 snoozes it stops being polite — it force-closes whatever
  processes you've listed in Settings (defaults to Valorant) and shows a
  full-screen warning instead of a small popup, repeating until you log
  progress or the punishment window ends (default midnight).

All of the numbers above (start hour, snooze threshold, word/chapter ranges,
which processes get killed, etc.) are editable in the Settings tab, along with
the theme (dark / midnight / light) and accent colour.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl` `L` | Log progress |
| `Ctrl` `N` | New book |
| `Ctrl` `R` | Reroll today's target |
| `1`–`5` | Switch views |
| `Esc` / `Ctrl` `Enter` | Close / save a dialog |
| `Ctrl` `Alt` `W` | Open the app and jump straight to logging, from anywhere |

## Development

```bash
npm install
npm start        # run in dev mode
npm run dist      # build dist\Write-or-Else-Setup-<version>.exe (installer) + the portable exe
```

Icons are generated with `node scripts/make-icon.js` (pure Node, no image
libraries) and committed under `assets/`.
