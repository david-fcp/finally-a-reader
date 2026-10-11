# Known issues

Where a highlight's two ends land in a PDF is the hardest part of this plugin.
Four problems with it were parked on 9 October 2026 and worked on on 11
October. Here is where each one stands.

To diagnose a highlight that comes out wrong, the plugin keeps a report it can
write about the current selection: the character array the highlight is cut
from, both ends, the characters either side of each, and where the browser had
put them before the pointer was consulted. It is no longer a command; run it
from the developer console (Cmd+Option+I) with the problem text selected:

```js
app.plugins.plugins['minimal-pdf-annotator'].writeSelectionReport()
```

It writes `Minimal PDF annotator selection report.md` at the vault root.

## 1. One sentence lost its last letter: no longer happens

The first sentence of the loneliness paper (`Loneliness in australian
men.pdf`) used to lose its final letter: "lonelines" for "loneliness". On 11
October it could not be made to happen. Drags ending at five different points
on the last letter all kept the whole word. It was probably fixed along the
way by the changes to how a selection's ends are measured. If it comes back, a
selection report of that sentence is the place to start.

## 2. Starting in the gap between words sometimes took the word before: fixed in the logic

The browser's idea of where a drag began can sit a letter away from the
pointer, so the plugin moves each end to the letter boundary nearest the
pointer. In the gap between two words, that could move the start back across
the space into the word before, and snapping to whole words then took that
word whole. A boundary is now never moved across a gap between words, whether
a space character or the visible gap a PDF leaves between two runs of text.

Unit tests cover the rule. In the window, 50 drags begun at different points
in ten word gaps all came out right, but they did with the old code too, so
the original failure (about one drag in six) could not be reproduced to show
the fix working there.

## 3. A full stop was sometimes taken: fixed in the logic

The same correction, at the other end. A drag released just past a word's last
letter could be nearer the boundary after the full stop than the one before
it, and take the full stop. The browser's own boundary now stands unless
another one is nearer the pointer by more than a pixel and a half. As with 2,
unit tests cover it, and the window could not reproduce the original failure.

## 4. A selection across a page break took a publisher's stamp: fixed

A PDF can draw text at any point in its content stream, not where it appears
on the page. The loneliness paper draws a production stamp, "777309
research-article 2018", tiny in page 1's top-left corner and last of all, so a
selection running off the bottom of page 1 swept it in. A small group of lines
standing apart from the rest of what was selected is now dropped when every
line in it is either far smaller than the body text or lies outside the body
text's span across the page. The top lines of a second column are neither, so
two-column papers are unaffected. The window test that used to report this as
a known issue now checks it.

A running header at the top of the next page can still be swept in when it is
ordinary-sized text above the body, as it can be in Zotero. A line standing
entirely on its own is dropped, as before.

## Other limitations

- **Mobile** has been checked only in Obsidian's mobile emulation on a
  computer, not on a phone or tablet.

## Where the relevant code is

In `main.js`, under the heading "the character model": `buildChars()`,
`refineBoundary()`, `wordGapBetween()`, `nearestPointer()`, `insideWord()`,
`snapStart()`, `snapEnd()`, `selectedSlice()` and `dropRunningHeads()`. All are
covered in `tests/test-markdown.js`, so a fix can be written against a test
before being tried in the app.
