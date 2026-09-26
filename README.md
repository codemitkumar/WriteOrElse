# Write or Else

**An offline desktop app that decides what you write today, tracks it, and gets
progressively more annoying if you ignore it.**

You don't choose what to work on. Once a day it picks a book out of your
rotation and hands you a target — words, a chapter edit, or a chapter to plan.
Meet it and the streak lives. Ignore it past 8pm and it starts closing your
games.

Windows · fully offline · no account, no telemetry, no network calls at all.

---

### Contents

- [Installing](#installing)
- [How it works](#how-it-works)
  - [Books and stages](#books-and-stages)
  - [Ideas](#ideas)
  - [The daily target](#the-daily-target)
  - [Planning days](#planning-days)
  - [Logging progress](#logging-progress)
  - [Streaks](#streaks)
  - [Hard mode](#hard-mode)
  - [Slack: rest days and rerolls](#slack-rest-days-and-rerolls)
  - [Bonus rounds](#bonus-rounds)
  - [What bonus rounds pay](#what-bonus-rounds-pay)
  - [Stats](#stats)
  - [Celebrations](#celebrations)
  - [Punishment](#punishment)
- [Settings](#settings)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Your data](#your-data)
- [Development](#development)

---

## Installing

Run `dist\Write-or-Else-Setup-<version>.exe` and step through the wizard.

| | |
| --- | --- |
| **Installs to** | `%LOCALAPPDATA%\Programs\Write or Else\` |
| **Admin rights** | None — it's a per-user install |
| **Shortcuts** | Start Menu and Desktop |
| **Uninstall** | Settings → Apps, or `Uninstall Write or Else.exe` in the install folder |

The installed copy is **completely independent of this source folder** —
everything the app needs is bundled into it, so this whole project directory
can be deleted afterwards without breaking anything. Keep it only if you plan
to rebuild or modify the app later.

### Prefer not to install?

`dist\Write or Else <version>.exe` is a portable single-file build. Move it
*out* of this project folder before deleting the folder, though — that copy
isn't decoupled the way the installed version is.

Either way it starts minimized to the system tray and, by default, launches
when you log into Windows, so streak and punishment tracking work without you
having to remember to open it.

---

## How it works

### Books and stages

Books move through five stages:

| Stage | Means |
| --- | --- |
| `Planning` | No chapter to write yet — figure out what happens next |
| `Writing` | Drafting. This is where word targets come from |
| `Completed` | Drafted, not edited. You're asked for the total chapter count here |
| `Editing` | Editing passes, chapter by chapter |
| `Done` | Finished. Out of the rotation |

A book can also be **paused**, which hides it from the daily picker without
deleting any of its history.

### Ideas

The **Ideas** view is a parking lot for books you haven't committed to yet: a
title plus optional notes. Ideas are never picked for a daily target, no matter
how many you have. When one is ready, **Promote to book**. It leaves Ideas and
shows up in Books under `Planning`, with its notes as the blurb, and from then
on it's in the rotation like any other book.

### The daily target

Once a day the app picks a book at random from your
`Planning` / `Writing` / `Editing` pool — weighted toward books you haven't
touched in a while — and assigns one of three things: a word count, a number of
chapters to edit, or a chapter to plan.

**The word target ramps.** It starts at 500, climbs by 50 every day you hit a
write target, and plateaus at 5,000. There's no range to babysit; it finds its
own level.

**Books carry their own goal too.** A book's details dialog
(kebab menu → *Details, cover & goal*) holds a word goal and the words written
so far, alongside the chapter counter for whichever stage it's in. Set both and
the card gets a real progress bar — so a book you started long before
installing this doesn't have to climb from zero. The running total moves on its
own every time you log words.

### Planning days

A book you flag **"needs planning"** always gets a no-word-count planning day.
Books still being written get one at random too (15% by default), so you're
never permanently under word pressure.

Logging a planning day asks whether a whole chapter actually came out of the
session:

- **Yes** → the book goes back to `Writing`
- **No** → it stays in `Planning`, so tomorrow asks again

Either answer clears the day and protects the streak. The question is about the
book's stage, not about whether you showed up.

And when a book has written every chapter it had planned, it moves itself back
to `Planning` rather than waiting for that dice roll — you never get handed a
word target for a chapter that doesn't exist yet. (Today's target stays as it
was; the planning day is the next one.)

> **Flagging today's own book for planning costs a reroll.** Moving a book to
> `Planning` invalidates a word target built on it, and the replacement would
> otherwise be free — which makes it a way out of any target you don't fancy.
> You're asked before anything is spent. With no rerolls left the book still
> moves (you shouldn't be stuck writing into a book you know needs planning) but
> the day keeps asking for its words.

### Logging progress

Logging is manual, since you write in a separate tool (ForgeTales). Enter the
word count or chapters edited when you're done, or use the quick-add chips on
the dashboard.

- Both the daily target and the bonus round carry an **I wrote extra…** chip
  that stays there after the task is finished, so a session that ran well past
  the goal still gets counted.
- **The log dialog always opens on whatever is actually still open.** While the
  day's target is unmet, that's the target. Once it's done, the form arrives
  pointed at the bonus round that replaced it — book and type already set — and
  says so above the fields. So <kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>W</kbd> after a
  finished mission takes you straight to the bonus instead of re-offering the
  task you just cleared. This applies to every route in: the dashboard button,
  <kbd>Ctrl</kbd><kbd>L</kbd>, the tray item and the global shortcut. The
  shortcut re-reads the day first, so firing it hours later — or into a cold
  start — can't land you on a stale task.
- Mis-typed an entry? Delete it from History and the book totals, and the streak
  if it was the deciding entry, are walked back.

### Streaks

The streak counts up only on days that the app was actually running (your laptop
was on and you were logged in) **and** the day's target was met.

A day the app never ran — you were away — is **skipped, not counted as a miss.**
It won't break your streak.

### Hard mode

Flip the **Easy / Hard** switch on the dashboard and each day becomes a list of
tasks instead of one: three by default (2 to 5 in Settings), each on a
different book, so a day can be shorter if fewer books are in rotation. The
streak only counts once **every** task on the list is done. Bonus rounds only
start after that, and the nagging keeps going until then.

- The hero card shows one task at a time. Click any open task in **Today's
  list** to work on that one instead. Each task can be rerolled while it's
  untouched, from the same rerolls as always.
- **Easy to hard** works any time. If today isn't finished yet, today's list
  starts right away. If it is, hard mode starts tomorrow.
- **Hard to easy** is locked until today's whole list is done. Then the switch
  unlocks, and tomorrow is back to one task.
- **Bonus rounds are lists too.** Once a hard day's list is done, each bonus
  round is a list of the same size, one task per book, and the next round only
  opens once every task on the current one is cleared. Rewards still count each
  cleared bonus task on its own, so a hard round of three pays what three easy
  rounds would.

### Slack: rest days and rerolls

| | Default | Does |
| --- | --- | --- |
| **Rest day** | 1 per 7 days | Protects the streak and silences the nagging |
| **Reroll** | 1 per day | Swaps a target — or a bonus round — you haven't started yet |

Set either to `0` in Settings for the original no-escape-hatches behaviour.

### Bonus rounds

Clear the day's real target — whenever that happens — and you're handed an extra
task, usually on a different book. Clear that one and the next arrives straight
away, and so on until the day rolls over, so a good run never runs out of
targets.

They're deliberately toothless. They never count toward the streak, never raise
your word level, and the punisher ignores them completely, so leaving one
unfinished costs you nothing. Switch them off entirely in Settings.

Each round you clear in a day makes the next one bigger: word counts grow 25% a
round up to double your word level, and editing rounds add a chapter every
second round. Planning rounds stay at one outline. Rerolling a round keeps its
size, and the whole chain starts small again tomorrow. Turn this off in Settings
if you'd rather every round be the same size.

### What bonus rounds pay

They used to pay nothing, which made them easy to ignore. Two rewards now come
out of them, and both are spent on the same thing they were earned on — control
over what the app asks of you.

| Reward | Costs | What you get |
| --- | --- | --- |
| **Banked reroll** | 3 cleared rounds | Stacks on top of the daily free one, and is only spent once that's gone — so a credit is never burned on a day you didn't need it. Spending any reroll runs a slot reel that lands on the new mission. |
| **Project pick** | 15 cleared rounds in a calendar month | Deal your books out as cards, choose one, and tomorrow's mission is that book. The app still decides whether it wants words, edits or a plan. Refunded if the book leaves the rotation before its day arrives. |

Both credits are counted straight off the bonus history, so deleting the log
that cleared a round takes the credit back with it.

Neither is the only route to anything: skip every bonus round and you lose only
what you never had.

### Stats

The Stats tab keeps a full score on bonus rounds — they're the only work in here
that nothing is making you do, which makes them the part most worth counting:

- Rounds **cleared against rounds offered**, and the clear rate
- Your **best single day**
- A **six-month bar chart** of cleared rounds
- A **ledger** reconciling every reroll and project pick they've paid out
  (earned, spent, left)

Like the credits themselves, every figure is derived from the bonus history on
each read — so a deleted log walks the whole picture back together.

### Celebrations

Clearing something gets acknowledged rather than just logged.

| Event | What happens |
| --- | --- |
| **Daily target met** | Confetti from both bottom corners, a *Complete* stamp on the mission card, a light running around its edge, the progress bar flares, the streak flame lights |
| **Bonus round cleared** | A smaller burst out of the bonus card itself |
| **Reroll banked** | The counter flips like a coin |
| **Book finished** | The biggest one in the app |

Several wins from a single log **queue up one after another** instead of
fighting over the middle of the screen, and any banner can be clicked away
early. Throughout, numbers count up to their new value, bars shine along their
length when they grow, and the day's ring sweeps from where it actually was
rather than from zero.

All of it is one switch in **Settings → Celebrations**, with a
**Preview a celebration** button so you can see what you're agreeing to.

Two things override the switch, both deliberately:

- **Windows' own "show animations" setting is honoured regardless.** With it
  off, nothing is generated at all — you still get the banner and the toast,
  they just hold still.
- **Effects are skipped while nobody can see them** — window hidden in the tray,
  or covered by a fullscreen app.

### Punishment

If the target isn't met by the configured hour (default 8pm), you get a nag
popup with a *snooze* button. It checks every N minutes (default 20), though a
nag only actually fires about 70% of the time — so you can't learn its rhythm
and pre-empt it.

After 5 snoozes it stops being polite, and stops being random. It
**force-closes whatever apps you've ticked in Settings** and shows a
full-screen warning instead of a small popup, now on *every* check, repeating
until you log progress or the punishment window ends (default midnight).

Picking those apps doesn't require knowing process names: Settings lists what's
actually installed on the machine — desktop apps, Store apps, and anything
currently running — with its icon and its real executable name, so you tick
"Brave Browser" rather than having to know it's `brave.exe`. Anything the scan
misses can still be typed in by hand.

---

## Settings

Every number above is editable, and these are just the defaults:

| Setting | Default |
| --- | --- |
| Start nagging at | 8pm |
| Stop nagging at | Midnight |
| Nag interval | 20 minutes |
| Snoozes before escalation | 5 |
| Starting words / day | 500 |
| Increase per successful day | 50 |
| Word cap | 5,000 |
| Chapters to edit | 1–2 |
| Chance of a planning day | 15% |
| Rest days per 7 days | 1 |
| Rerolls per day | 1 |
| Tasks per hard day | 3 |
| Bonus rounds | On |
| Celebrations | On |
| Launch at login | On |

Plus the theme (dark / midnight / light) and the accent colour. Confetti is
drawn in the accent you picked, so the whole thing re-themes with the rest of
the app.

---

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| <kbd>Ctrl</kbd><kbd>L</kbd> | Log progress |
| <kbd>Ctrl</kbd><kbd>N</kbd> | New book |
| <kbd>Ctrl</kbd><kbd>R</kbd> | Reroll today's target |
| <kbd>1</kbd>–<kbd>6</kbd> | Switch views |
| <kbd>Esc</kbd> | Close a dialog |
| <kbd>Ctrl</kbd><kbd>Enter</kbd> | Save a dialog |
| <kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>W</kbd> | **From anywhere:** open the app straight into logging whatever is still open — the target, or the bonus round once the target is done |

---

## Your data

Everything lives in one local file:

```
%APPDATA%\write-or-else\write-or-else-data.json
```

Nothing ever leaves your machine. It sits outside the install directory, so it
survives reinstalls and updates. Settings → *Your data* has **Export backup…**
and **Show data file**.

---

## Development

```bash
npm install
npm start        # run in dev mode
npm run dist     # build the installer + the portable exe into dist\
```

### Layout

| Path | Role |
| --- | --- |
| `main.js` | Main process — window, tray, global shortcut, IPC |
| `preload.js` | Context-bridge API exposed to the renderer |
| `store.js` | The JSON store, and every rule: targets, streaks, bonus chains, rewards |
| `punisher.js` | Nag scheduling and escalation |
| `apps.js` | Scans the machine for installed apps to offer in Settings |
| `renderer/index.html` | The whole UI's markup |
| `renderer/styles.css` | Base styles, themes and accents |
| `renderer/app.js` | All renderer logic |
| `renderer/celebrate.js` | Confetti, banners, stamps, count-ups |
| `renderer/celebrate.css` | Celebration and motion styles |
| `renderer/nag.html` | The punishment popup |
| `scripts/make-icon.js` | Icon generator |
| `build/installer.nsh` | NSIS installer customisation |

Icons are generated with `node scripts/make-icon.js` — pure Node, no image
libraries — and committed under `assets/`.
