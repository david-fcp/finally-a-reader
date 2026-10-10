# Tests

No dependencies and no build step. From anywhere:

```
node tests/run.js
```

The suite loads `../main.js` with `obsidian` stubbed through `Module._load`,
then re-exports the internals by appending a `module.exports.__t = {...}` line
before compiling. If you add a function you want to test, add it to that list.

## What this is protecting

**`test-markdown.js`** — two things.

`renderMarkdown()`, the transcript written to `<name>.md`: reading order,
indentation, and the fact that highlighted text is quoted verbatim rather than
backslash-escaped.

More importantly, `writeMarkdown()`, which decides whether the plugin is
*allowed* to write that file. The transcript lives at `<name>.md` beside
`<name>.pdf`, which is also exactly what someone taking notes on a PDF by hand
would call their note. So a stamp of the last generated text is kept in the
sidecar, and the file is only rewritten when what is on disk is what we last
put there. The cases covered: no file yet, a file we wrote, somebody else's
note, a transcript edited by hand, and a transcript generated before stamps
were recorded but still in sync (adopted, so upgrading does not strand it).

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
  would stretch over a full stop the transcript left out, or the transcript
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
the fifty-change limit, and two things that must hold. A snapshot is a copy
rather than a reference, so a later edit cannot reach into the history. And the
marker recording whether the generated markdown file is still the plugin's own
is deliberately left out of a snapshot, because restoring an old one would make
the plugin think somebody else's note had appeared at that path.

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
anchored at that point, which in the transcript is a bullet of its own, so it
had nothing to sit under. The assertions say which item each kind of
right-click offers and which note it opens.

The zoom memory is covered too: which values the viewer will accept, the
least-recently-used pruning that keeps the store from growing without end, and
`syncZoom()`, which restores a remembered zoom once the viewer has pages and
records changes from then on. One assertion is there to keep it harmless:
reaching into Obsidian's PDF view is not part of the plugin API, so a shape
the plugin does not recognise must mean the zoom is not remembered rather than
an error.

`anchorFor()` and `placeBox()` decide where a note box opens. Carrying the
element from the click that asked for the note was a bug: a context-menu item
runs after the menu closes, a redraw may have replaced that element in the
meantime, and a detached element measures as nothing, which put the box in the
top-left corner of the window. The anchor is now looked up by id when the box
opens. The assertions cover skipping a replaced element, the fallbacks when
nothing is on screen, keeping the box inside the window, that the anchor covers
every line of a highlight rather than only its first, and that both ways of
asking for a note refuse in the same circumstances. `clampToViewport()` is
shared by the opening placement and by dragging, so a box cannot be left
somewhere it cannot be reached.

`BoxDrag` holds the state of a drag of the note box, apart from the event
wiring, because the drag failed to end when the button was released: the box
stops mouse events from travelling further, so it swallowed the release before
the document heard it. The listeners now go on in the capture phase, and two
rules here end the drag even when a release is missed entirely. The assertions
cover a move before a drag, after one, with no button held, and a second drag
starting from wherever the box was left.

## Not covered

Anything that needs a DOM or a running Obsidian: the selection handling that
drives the functions above, the highlight overlays, the note box, the toolbar
button, the mutation observer that redraws overlays as the viewer recycles page
DOM, and the reload that fires when the annotations file changes on disk. Those
need checking by hand.
