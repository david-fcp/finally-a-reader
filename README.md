# Minimal PDF annotator

Highlight text in a PDF, attach notes to the highlights, and get a markdown
transcript of them beside the PDF.

Deliberately small. There is one colour, one kind of highlight and one kind of
note. If you want stamps, drawing tools, a sidebar of annotation cards or
two-way sync between the PDF and a note, this is the wrong plugin and
[PDF++](https://github.com/RyotaUshio/obsidian-pdf-plus) is probably the right
one.

## Using it

1. Turn on highlight mode. Three equivalent controls: the highlighter icon in
   the ribbon, the swatch in the status bar, or the highlighter button added to
   the PDF viewer's own toolbar. There is also a command, **Toggle highlight
   mode**, if you would rather bind a key.
2. Select text in a PDF. It is highlighted as soon as you release the mouse.
3. **Click a highlight** to attach a note to it.
4. **Right-click a highlight** to add or edit its note, or to remove either.
   Right-click a blank part of a page for "Add note", which anchors a note of
   its own at that point.

In a note box, Cmd or Ctrl with Enter saves, and Esc discards. Clicking away
saves.

Highlights record the colour they were made with, so changing the colour in
settings affects new highlights and leaves existing ones as they are.

Highlights are cut from a single array of characters, each measured on the
page, so the text transcribed and the rectangles drawn are two slices of the
same thing and cannot disagree about a character. This matters more than it
sounds: a PDF viewer stretches each span of text horizontally to match the
document's own letter spacing, and the browser picks a character boundary using
the unstretched metrics, so its answer can sit a glyph away from where your
pointer was. Where a drag ends between two letters, the one nearer the pointer
wins. Unless you turn it off in the settings, the boundary then widens to the
whole word, and a boundary already between two words is never moved.

A selection that runs across a page break is one highlight, not two, so
removing it removes the whole thing. Such a selection also takes in whatever
sits between the two columns of body text, usually a running header or a page
number, and a PDF may draw those at any point in its content stream rather than
where they appear. A line standing on its own, far above or below everything
else selected on that page, is treated as one of them and left out. At most two
lines from either extreme, and only for a gap wider than any paragraph break,
so a two-column paper is unaffected.

Every note, whether it belongs to a highlight or stands on its own, is marked
by a small icon in the page's left margin, level with the thing it refers to.
They never sit over the text, and they line up in a column down the page. How
far in they sit is a CSS variable, `--mpa-margin-inset`, so a snippet can move
them without touching the plugin. Where a standalone note was anchored is still
recorded and still decides its place in the transcript; only the marker is in
the margin.

A note box opens below everything the note belongs to, clearing the last line
of a highlight rather than only its first, so the words stay readable while you
write. Drag the strip along its top to move it. It keeps itself inside the
window either way, flipping above its anchor when there is no room beneath.

Clicking a highlight and right-clicking it reach the same note through the same
code, including where the box appears and when it refuses, so the two cannot
drift apart.

The plugin stays quiet. Highlighting, noting, undoing and toggling highlight
mode say nothing, because what changed is already on screen. The only thing it
announces is the transcript being created, since a file has then appeared in
the vault that was not there before and where it appeared is not obvious. The
rest of its messages are failures: annotations it could not read, a save that
did not happen, a markdown file it has left alone because it is not the
plugin's own.

## Zoom

Each PDF reopens at the zoom you last read it at, which a setting turns off.

It is kept in Obsidian's per-device store rather than in the plugin's settings
file, because a comfortable zoom depends on the screen in front of you and
should not follow you between machines. Obsidian keeps which headings you have
folded in the same place, for the same reason. The two hundred most recently
read PDFs are remembered.

Reading and setting the zoom means reaching through Obsidian's PDF view into
the PDF.js viewer it wraps, which is not part of the plugin API. Every step of
that is checked, and a shape the plugin does not recognise means the zoom is
simply not remembered. Nothing else in the plugin depends on it, so an Obsidian
update that moves it can cost this feature and nothing more.

## Undoing

Cmd or Ctrl with Z steps back through the highlights and notes on the PDF you
are looking at. Adding Shift steps forward again, and on Windows and Linux so
does Y. Everywhere else those keys keep their usual meaning.

Inside a note box they undo what you typed rather than the annotation around
it, and they group it the way the rest of Obsidian does. A note box is a plain
text field, and a text field's own undo steps through a typed run one character
at a time, which felt foreign. It now keeps its own history using CodeMirror's
rule: a new undo step begins only when you pause typing, so a burst comes back
as a burst.

They cannot be rebound, and the reason is worth knowing. On the desktop the
editor's undo is not an Obsidian command but CodeMirror's own key handling, and
Obsidian's hotkey dispatcher sees keys before the editor does and stops a bound
key travelling any further. A plugin command on that key would stop editor undo
working anywhere, and because there is no command for it to conflict with, the
hotkey settings would not warn you. So the plugin catches the key itself and
claims it only for keystrokes that belong to a PDF. The trade is that it does
not appear in Settings under Hotkeys and cannot be changed there.

Two commands exist as well, **Undo last annotation change** and **Redo last
undone annotation change**, for the command palette or for a second key of your
own.

The history holds whole copies of the annotations rather than a description of
what changed, which is wasteful in principle and completely reliable at this
size. It goes fifty changes back per PDF, lives in memory, and is lost when
Obsidian restarts. It is also cleared whenever the annotations file changes from
outside the plugin, since an undo would otherwise write the plugin's older idea
of that file over somebody else's newer one. A sync between machines will
therefore clear it.

## The two files beside your PDF

For `refs/paper.pdf` you get:

**`refs/paper.annotations.json`** — the annotations themselves, and the only
copy of them. Plain JSON: syncs, diffs and backs up like anything else. Keep it
next to the PDF when you move things around. Each rectangle names its page and
is stored as fractions of that page, so highlights survive zooming and
re-rendering and a single highlight can span a page break.

**`refs/paper.md`** — a generated transcript, so highlights are searchable and
linkable as ordinary markdown. Highlights come out as quoted bullets in reading
order, a highlight's note indented underneath it, and a note of its own as a
plain bullet in its place on the page.

```markdown
- "the smallest unit that can still be called a place"
	- this is the definition the rest of chapter 3 leans on
- a thought of mine, anchored to page 14
```

That file is regenerated from the JSON, so edits to it are not read back and
will be replaced.

**It will not overwrite a note of your own.** `<name>.md` beside `<name>.pdf`
is exactly what you would call a note you were keeping on that PDF by hand, so
the plugin records a stamp of the last transcript it generated and only rewrites
the file when what is on disk is what it last put there. Anything else is your
work: the file is left alone, your highlights stay safe in the JSON, and you are
told once.

If the JSON file is ever unreadable, the PDF opens with annotations read-only
rather than starting over with an empty file, so there is something left to
recover.

## When a highlight comes out wrong

How a PDF's text layer is put together differs from file to file, and some of
it cannot be guessed at from the outside: a tagged PDF keeps some of its text
in spans the viewer gives no size, and a PDF may draw its running header at any
point in its content stream rather than where it appears on the page. Both
affect what a selection turns into.

The command **Report what the current selection looks like** writes a note
describing exactly what the viewer reports for every span in the current
selection, the lines built from them, and the text that would be stored. That
is the quickest way to say why a particular highlight came out wrong.

Four open problems with where a highlight's boundaries land are written up in
[KNOWN-ISSUES.md](KNOWN-ISSUES.md), with the suspected cause and the next step
for each.

As a backstop, the assembled text is checked against the browser's own idea of
what is selected. Assembling text span by span is what lets a missing space be
put back, but it is also a chance to lose a character, and losing one is worse
than losing a space. If the two disagree, the browser's text wins and the
discrepancy goes to the console.

## The text in the settings tab

It lives in `settings-help.md` in the plugin folder, so you can reword it. The
plugin writes that file out the first time it needs it and never overwrites it
afterwards, so your edits are kept. Reopen the settings tab to see them.

## Installing

From the community plugin browser, or by hand: copy `main.js`, `manifest.json`
and `styles.css` into `<vault>/.obsidian/plugins/minimal-pdf-annotator/` and
enable the plugin in Settings, then Community plugins.

Works with Obsidian's built-in PDF viewer.

## Tests

```
node tests/run.js
```

No dependencies, no build step. The suite covers the transcript format and the
rule that decides whether the markdown file may be written, which is the one
piece of this plugin that can destroy something. Everything that needs a real
PDF on screen has to be checked by hand; `tests/README.md` lists what.

## Licence

MIT. See [LICENSE](LICENSE).
