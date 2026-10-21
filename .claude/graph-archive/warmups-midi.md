# Warm-up MIDI generator + student handout

Last verified: 2026-10-22.

## Open right now

Nothing. The two bugs below were fixed on 2026-10-22.

## Accidental spacing — fixed 2026-10-22

The accidental was drawn at `nx - 20` while the step was only 26px, so it
overlapped the *previous* notehead (measured gap **−0.10px**) while sitting
6.73px from its own. It read as belonging to the note before it.

`notation.py` now reserves the space **before** the note that carries the
accidental. Named constants at module level, all measured, not guessed:
`ACC_DX = 15.5` (offset left of its own notehead), `ACC_GAP = 9.5` (clearance
from the previous note), plus `right_ink()`, which returns how far a note's
drawing actually extends right — head 6.7, flag 11.6, dot 12.0, ledger 10.5 —
so the step only widens when that note really needs it.

Glyph metrics, measured via `getBBox` in headless Chrome (reuse these; do not
re-guess): **♯ at `font-size:15px` Apple Symbols is 7.17px wide and its left
edge is exactly the `<text x>`**; the clef at `font-size:9×SP` ends at x=37.2,
which is why the first note at x=76 has room for an accidental.

Two proximity metrics must both pass, and they disagree — check both:
- **ink gap** (what the eye groups by): 2.23px to its own note, ≥9.50px to the
  previous one, worst ratio 4.3×
- **notehead-centre distance**: own note nearer by ≥0.70px. An earlier
  `ACC_GAP = 7.0` passed the ink-gap test but failed this one on 33 of 61
  accidentals — the reason `ACC_GAP` is 9.5 and not 7.

`ACC_DX = 15.5` leaves a 1.65px painted gap to its own notehead ≈ 0.18 staff
spaces, which is standard engraving. Do not shrink it to buy width.

## Warm-ups tab dark theme — fixed 2026-10-22

The luminance sweep found **nothing light** — the real fault was the opposite.
`.wu-audio` is a hardcoded `#2A2622` box designed to sit on a white card. In
dark theme the card is `--panel #26221F`, so player-vs-card contrast was
**1.05** with no border: the player dissolved into the card. Scan for *that*
too, not only for bright backgrounds.

Fixed by moving the player's palette into `:root` / `body.dark` as
`--wu-surface / --wu-edge / --wu-hover / --wu-dim / --wu-ring / --wu-accent /
--wu-danger-line / --wu-danger-text`, and pointing all `.wu-*` rules at them.
Dark lifts the surface to `#332E29` and adds `--wu-ring: inset 0 0 0 1px
#52493F` — an **inset box-shadow, not a border**, so the box keeps its size.
Light theme resolves to the original hexes exactly; verified unchanged.

Two offenders only render during a delete or an error, so a scan of the
rendered page misses them entirely: `.wu-del-confirm` / `.wu-error-banner` had
text `#7E3220` (contrast **1.6** on the dark plaque) and border `#E8C4B6`
(luminance 0.60 — genuinely light). Probe every `.wu-*` class by injecting a
throwaway element and measuring, rather than trusting what happens to be on
screen; that is how these surfaced.

Known and deliberate, do not "fix": `.wu-filter-chip.on` is a light pill in
dark theme (explicit `body.dark` rule, mirrors the dark pill in light theme).
Still open, pre-existing in **both** themes: `.wu-level-badge` for level C is
white on `--lvlC #C9A227`, contrast 2.42 — that is Николай's level colour, so
it was left alone.

## Where things live

| What | Path |
|---|---|
| Generator sources | `~/Desktop/Распевки MIDI/_generator/` |
| Output (49 `.mid`, PDF, HTML, txt) | `~/Desktop/Распевки MIDI/` |
| Source of method content | `~/Desktop/Вокология «все тетради».pdf` (195 pp.) |
| PDF/text extraction tool | `~/.local/vocal-stt/bin/python` + `fitz` (pymupdf) |

The generator **was** in the session scratchpad and would have been lost; it was
moved to `_generator/` on 2026-10-21. Never leave it in a scratchpad again.
It is still **not under git** — `~/Desktop/Распевки MIDI/` is not a repo, so
changes there go live the moment `build_doc.py` runs and there is no history to
fall back on. Nothing about this folder is covered by the site's deploy.

```
build_all.py   → writes all .mid + the .txt handout
build_doc.py   → writes the PDF (bars) and the HTML (staff notation)
engine.py      → MIDI bytes, sequence builder, duration cap
notation.py    → treble-clef SVG rendering
chords.py      → chord symbol derived from the motif
exercises.py        → 30 base exercises (10 topics × 3)
exercises_jazz.py   → 10 jazz-flavoured (one per topic, files `..d`)
exercises_artists.py→ 9 artist-profile (Adele / Lady Gaga / Sam Smith)
```

Run from `_generator/`: `python3 build_all.py` then `python3 build_doc.py`.
`build_all.py` **deletes and recreates** the output folder — it regenerates the
`.txt` too.

## Rules Николай set (do not silently change)

- Range: lowest note **A3** (ля малой), top **E5** (ми второй), then back down.
  The *lowest note of the motif* is pinned to A3 — for descending figures the
  first sounded note is therefore higher, which is correct and was accepted.
- Time signature **4/4** everywhere.
- Every sequence link sounds **twice** in a row.
- Duration ≤ **3:30**; the artist exercises ≤ **4:00** (`max_sec` per exercise).
- Where a semitone step would overflow the cap, the **step** is widened
  (tone, 1.5 tone…) — the start note and the top of the range stay put.
- Straight rhythm. Swing was explicitly rejected: he wanted jazz **pitch**
  material, not swung time.

## Content sourcing policy — this one matters

Николай once rejected generated lesson content as "устаревшая школа, по которой
я не работаю лет 7". Since then: **technique text must be quoted from his
notebooks with page numbers.** Pages actually used so far:

- p.59–60 four onsets (твёрдая / постепенно-придыхательная / резко-придыхательная / мягкая «йу»,«йа»)
- p.61 false folds: neutral / compressed (distortion) / retracted
- p.67 anchoring — explicitly *not* опора; pressure drops rather than rises
- p.71 cry/sob recipes (full 13-structure list, same as the site's Кабинет)
- p.73 Oral Twang recipe (high soft palate, no nasality, ~2500 Hz)
- p.74 belt: cricoid tilt, thicker body-cover, vowels Э/А → О/И
- p.75 belt risks (fatigue, pressure, tongue retraction)
- p.79 "necessary twang", epilaryngeal funnel narrowing
- p.91 SOVT: list of semi-occlusions, "overcome the resistance, don't close harder"
- p.97–98 registers, head/chest dominant, balance via twang + slides + "Cat"
- p.112 passaggio, belt, semi-belt, mix, falsetto, subtone, distortion
- p.152 style vs technique; onset / timbre / phrasing / ornaments as style knobs

Melodic material that is **not** from the notebooks (jazz scales, artist
profiles) is labelled as such in the files and on the handout cover.

**Refused, with reason — do not quietly reverse:** reproducing the melodies of
real songs as MIDI and naming exercises after tracks. Two reasons given: no
reliable note-level knowledge of those songs (would teach students wrong
notes under a real title), and reproduction of copyrighted compositions.

## Verification recipes that work

Parse every MIDI back and assert the invariants — this caught several real
bugs (a motif starting on E4 instead of A3; stray note-on/off imbalance):

```python
# per file: lowest note == 57, highest == 76, time sig 4/4,
# note-on count == note-off count, first L notes repeat immediately (link ×2)
```

Pitch spelling test: A3→2 ledgers below, C4→1, E4→bottom line, E5→top space.
Blues scale from A must spell ля–до–ре–ре♯–ми–соль–ля.

Render the HTML with Chrome headless:
`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --window-size=900,1250 --virtual-time-budget=4000 --screenshot=out.png "file://…"`
Then crop with `fitz` to inspect. Run **one** Chrome at a time; two in a loop
hung past the 2-minute tool timeout. `timeout` is not installed (no Homebrew).

## Dead ends

- **IntersectionObserver + headless Chrome**: reveal callbacks often do not
  fire under `--virtual-time-budget`, so screenshots came out blank and looked
  like a layout bug. Confirm layout by rendering a copy **without** the
  animation CSS before chasing anything.
- The handout animation originally hid content with `opacity:0` and revealed it
  by script. That meant any script failure showed students a blank page. It is
  now inverted: content is visible by default, the script adds `.anim` itself,
  plus a 2.5 s failsafe. Keep it that way.
- `background: currentColor` together with `color:#fff` in the same rule makes
  the background white too — `currentColor` resolves to that element's own
  colour. Bit us on the heading chip.
- MIDI note glyphs (U+1D15F etc.) are **not** in macOS system fonts — they
  render as tofu. The clef (U+1D11E) and ♯ ♭ ♮ **are** present and correct.
  Noteheads/stems/flags are therefore drawn as SVG geometry; clef size needs
  `font-size ≈ 9 × staff-space` to span the staff properly.
- GarageBand does not display MIDI text meta events, so the per-exercise task
  text has to live in the handout, not only in the file.

## Formats he asked for

- PDF and the `.txt` are **not** to be touched without being asked — he said so
  explicitly when the staff notation went in. Notation and chords are
  HTML-only at the moment.
- Chord line sits above the staff: progression + "first link is X, the chord
  rises with the sequence". Derivation lives in `chords.py` and already has
  three corrections baked in (bebop → dominant not maj7; root taken from the
  motif's tonic, not its lowest note; a fully chromatic run is not "blues").
