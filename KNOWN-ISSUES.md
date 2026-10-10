# Known issues

Open problems in selection accuracy, parked on 9 October 2026 to be picked up
in a later session. Everything here is about where a highlight's two boundaries
land, which is the hardest part of this plugin. Large highlights, the
transcript, the markdown ownership guard, undo-free editing and the rest are
behaving.

Reproduce any of these with the command **Report what the current selection
looks like**, which writes `Minimal PDF annotator selection report.md` at the
vault root. It lists the character array the highlight is cut from, both
boundaries, the characters either side of each, and where the browser had put
them before the pointer was consulted.

## 1. One sentence resists everything

The first sentence of `Groups and well-being/Loneliness in australian men.pdf`
loses its final letter: "lonelines" for "loneliness". It survived the character
model, pointer refinement and word snapping, and it is the only clause in that
PDF that misbehaves. Turning snapping off fixes every other case but not this
one.

Because it is one clause in one file, the next step is to read a report for it
specifically and compare the character array against the span structure the
viewer built, rather than to change the boundary logic again. Suspect something
particular to that span: a ligature, a soft hyphen, a marked-content boundary
falling mid-word.

## 2. Starting in the gap between words sometimes takes the word before

One failure in six attempts. `insideWord()` is meant to prevent this: a
boundary already sitting in whitespace is left alone. A failure means the
boundary did not start in the whitespace, so pointer refinement moved it into
the preceding word and snapping then completed that word.

The likely fix is to stop `refineBoundary()` crossing a whitespace character:
if the browser's boundary is in a gap, candidates on the far side of that gap
should not be considered. That is a small, testable change to the candidate
window.

## 3. A full stop before a space is sometimes captured

Same mechanism, the other direction. The pointer lands close enough to the
boundary after the full stop that it wins. Tightening the refinement to prefer
the browser's own boundary unless another is clearly closer, rather than merely
closer, would help. A dead zone of a pixel or two, or a requirement that the
winning boundary beat the browser's by some margin.

## 4. A selection across a page break can take a running header

Left alone deliberately. A PDF may draw its running header at any point in its
content stream rather than where it appears on the page, so a selection
sweeping to the end of a page in reading order picks it up. Zotero has the same
behaviour on the same file, which is a good sign that it is inherent rather
than a defect here.

The "boxes in the top-left corner" reported earlier are the same mechanism,
diagnosed on 10 October 2026 with the real-window harness. In the loneliness
paper they are the publisher's production stamp, "777309 research-article
2018", printed tiny in page 1's top-left corner and drawn last in the content
stream, so a selection running off the bottom of page 1 sweeps them in. They
survive the filter below because they form two lines close to each other, and
the filter only drops a line that stands alone. Dropping a detached group of
two would fix this, but would also drop the first two lines of a second column
in a two-column paper. A narrower test would be text lying entirely in the page
margin, outside the horizontal span of the body lines, or text drawn at a
near-zero height (two of the three stamp words are about a pixel tall). The
harness reports this as a known issue rather than a failure.

Whether the boxes are drawn depends on the zoom. Two of the three stamp words
are about a pixel tall, and below half a pixel they are treated as having no
position. That leaves "777309" on its own, which the filter then drops, so at
small zooms the boxes disappear while the stamp's text is still swept into the
highlight. The harness pins the zoom for this check so the result does not
depend on how wide the sidebar leaves the page.

`dropRunningHeads()` catches the common case: a line standing far above or
below everything else selected on that page is dropped. It is deliberately
timid, because dropping real text would be worse than leaving a page number
in, and a two-column paper has to survive it untouched.

## Where the relevant code is

In `main.js`, under the heading "the character model": `buildChars()`,
`refineBoundary()`, `nearestPointer()`, `insideWord()`, `snapStart()`,
`snapEnd()` and `selectedSlice()`. All of the pure ones are covered in
`tests/test-markdown.js`, so a fix can be written against a test before being
tried in the app.
