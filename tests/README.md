# Tests

No dependencies and no build step. From anywhere:

```
node tests/run.js
```

The suite loads `../main.js` with `obsidian` stubbed through `Module._load`,
then re-exports the internals by appending a `module.exports.__t = {...}` line
before compiling. If you add a function you want to test, add it to that list.

## What this is protecting

**`test-markdown.js`** holds every unit test. The name is historical.

`renderExport()` is the note the sidebar's note button makes. The tests cover
reading order, each of the layout settings and how they combine (a blank line
wherever a line would otherwise run into a bullet), and the escaping that
keeps someone's text from turning into a heading, a list or a quote. A number
keeps its digits and has its full stop escaped instead, since markdown shows a
backslash before a digit literally. `exportNote()` is covered through a
stand-in vault: a name already taken, in any case, gets a number rather than
being written over, and nothing is made when there is nothing to put in it.

The geometry and text extraction are covered too, since both were wrong once
and the symptoms were subtle:

- `pagePaddingBox()`. Obsidian gives a PDF page a transparent border that
  scales with the zoom level, so its bounding rect is not the box an overlay
  with `inset: 0` is laid out against. Measuring against the outer one put
  every highlight a few pixels off centre and left a gap at the start and end
  of each line, widening as you zoomed in. One assertion states that
  regression as arithmetic.
- `buildChars()` and the functions around it are the character model a
  highlight is cut from. The earlier design read the text from character
  offsets and the rectangles from the browser's selection geometry, which are
  two answers to the same question, and they disagreed by a glyph: a highlight
  would stretch over a full stop the stored text left out, or the text
  would carry one the highlight did not cover.
- `refineBoundary()` and `nearestPointer()`, which move a boundary to whichever
  nearby one is really closest to the pointer. A PDF viewer stretches each span
  of text horizontally, so the browser's own answer can be a glyph out.
- `snapStart()`, `snapEnd()` and `insideWord()`, which widen a boundary to a
  whole word. Two assertions pin the behaviour that must not regress: a
  boundary already between two words is never moved, so starting a drag in the
  gap before a word cannot take the word before it; and snapping never reaches
  across a line break, where a PDF leaves no space character to stop at.
- `linesFromChars()` and `textOfChars()`, the two slices. A PDF's text layer
  carries no spaces between its spans, so a gap on the page becomes the space
  it looks like, while gaps inside one span are left alone because the viewer
  stretched them.
- `measurable()`, whether a span's position means anything at all. Obsidian
  gives a tagged PDF's structural spans `height: 0` and pins the viewer's
  selection helper to the top of the page during a drag, so text in either
  measures as a box at the page origin. Two such boxes were being drawn in the
  top-left corner on any selection crossing a page break.
- `dropRunningHeads()`, which keeps a page number out of a highlight that runs
  across a page break. One assertion is the case that must not break: a
  two-column paper, where the next column starts far above the end of the
  previous one.

`snapshot()` and the undo history are covered too: stepping back and forward
over several changes, a redo being discarded as soon as something new happens,
the fifty-change limit, and a snapshot being a copy rather than a reference,
so a later edit cannot reach into the history.

`NoteHistory` is covered as well. A note box is a plain text field, and a text
field's own undo steps through a typed run one character at a time, which does
not match the rest of Obsidian. The assertions hold CodeMirror's rule: a burst
of typing is one undo step, a pause starts a new one, a redo is discarded as
soon as something else is typed, and a run of deletions groups like a run of
insertions.

`drawHighlights()` is covered through a stand-in DOM, because marker placement
has now been wrong twice in opposite directions. The assertions say that a
marker takes no horizontal position from script, that both kinds of note are
marked the same way, that a highlight spanning a page break is marked on the
page it starts on, and that a page with nothing on it loses its overlay rather
than keeping an empty one.

`onContextMenu()` is covered through a stand-in menu that records what was
offered. Right-clicking highlighted text used to create a note of its own
anchored at that point, which in an exported note is a bullet of its own, so
it had nothing to sit under. The assertions say which item each kind of
right-click offers and which card it sends you to.

The zoom memory is covered too: which values the viewer will accept, the
least-recently-used pruning that keeps the store from growing without end, and
`syncZoom()`, which restores a remembered zoom once the viewer has pages and
records changes from then on. One assertion is there to keep it harmless:
reaching into Obsidian's PDF view is not part of the plugin API, so a shape
the plugin does not recognise must mean the zoom is not remembered rather than
an error.

`placeBox()` and `clampToViewport()` place the footnote preview beside its
marker and inside the window.

The sidebar's pure parts are covered: `annotationItems()` (reading order and
date order, for PDFs and books alike), `matchesQuery()` and the edit distance
behind it (a slip or two forgiven per word, but letters scattered across a
passage are no match), editing and deleting from a card as undo steps, and
changing the order.

`destPoint()` and `footnoteRegion()` decide what a PDF footnote preview
shows: the line the link points at whether the PDF marks its top or its
baseline, the text column's width, no further down than the last line in
reach, and a narrow column widened rather than magnified.

For EPUBs: `readZip()` against a real zip, paths inside a book,
`drmProtected()` (font obfuscation is not DRM), `snapOffset()`,
`findQuote()` for a highlight whose place in a changed book has moved, and the
name of a book's annotations file.

## The window suite

Everything that needs a document on screen is covered by a second suite that
drives a real Obsidian window through Obsidian's command line, with real mouse
and key events: highlighting to the pixel in PDFs and EPUBs, undo keys, the
sidebar, search, the note button, footnote previews, text size, and the
refusal messages for DRM and fixed-layout books. It needs a test vault and a
window on screen, so it lives outside this repository, beside the vault it
was developed in.
