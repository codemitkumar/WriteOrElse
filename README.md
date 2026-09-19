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

If you'd rather not install anything, `dist\Write or Else 1.0.0.exe` is a
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

- **Books** move through four stages: `Writing` → `Completed` (drafted, not
  edited — you're asked for the total chapter count here) → `Editing` →
  `Done`.
- **Daily target**: once a day, the app picks a book at random from your
  `Writing`/`Editing` pool (weighted toward books you haven't touched in a
  while) and assigns either a word-count target or a chapter-edit target.
  There's no way to reroll it — that's the point.
- **Logging progress** is manual, since you write in a separate tool
  (ForgeTales) — just enter the word count or chapters edited when you're
  done.
- **Streak**: counts up only on days the app was actually running (i.e. your
  laptop was on and you were logged in) *and* the day's target was met. A day
  the app never ran (you were away) is skipped, not counted as a miss — it
  won't break your streak.
- **Punishment**: if the target isn't met by the configured hour (default
  8pm), you'll get a nag popup every N minutes (default 20) with a "snooze"
  button. After 5 snoozes it stops being polite — it force-closes whatever
  processes you've listed in Settings (defaults to Valorant) and shows a
  full-screen warning instead of a small popup, repeating until you log
  progress or the punishment window ends (default midnight).

All of the numbers above (start hour, snooze threshold, word/chapter ranges,
which processes get killed, etc.) are editable in the Settings tab.

## Development

```bash
npm install
npm start        # run in dev mode
npm run dist      # build dist\Write-or-Else-Setup-<version>.exe (installer) + the portable exe
```

Icons are generated with `node scripts/make-icon.js` (pure Node, no image
libraries) and committed under `assets/`.
