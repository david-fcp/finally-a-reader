# Minimal PDF annotator

[PDF++](https://github.com/RyotaUshio/obsidian-pdf-plus) has the most features
of Obsidian readers, but is busy and clunky for some workflows.
[Zotero](https://www.zotero.org/) might be the best annotation and study app,
but maybe you want to keep everything in Obsidian.

This plugin suits anyone who wants to highlight and add notes to a PDF or EPUB
file, have those annotations appear in an interactive sidebar (like in Zotero),
and then be able to instantly generate a markdown file containing all of those
notes.

For me, this replaces Zotero and Zotero-like plugins. Enjoy!

## Using it

1. **Turn on highlight mode.** Use the highlighter button at the top of a
   PDF or a book, the highlighter icon in the ribbon, the swatch in the status
   bar, or the command **Toggle highlight mode**.
2. **Select text** in a PDF or an EPUB. It is highlighted as soon as you let
   go of the mouse, and appears in the sidebar.

While highlight mode is on, text being selected shows in the highlight colour.

With highlight mode off, selecting text brings up a small bar of icons beside
it, as in Zotero: **Highlight**, **Add note** (highlights it and puts the
cursor in its note) and **Copy**. It goes away when you click elsewhere,
scroll or type.

Right-clicking in a document brings up the same kind of bar, with what fits
where you clicked: on selected text, Highlight, Add note and Copy; on a
highlight, its note, Copy and Remove; on plain text, Add note. On a Mac it
also offers **Look up**, which shows the word's dictionary entry; a setting
turns that off. Hover over an icon to see its name.

PDFs and books look the same: the top of the tab holds the highlighter and
the zoom buttons, and nothing else. Zooming a book works as it does a PDF:
the page is magnified, its lines keep their length, and a page wider than the
tab scrolls sideways. Each book's zoom, and the place you were reading, are
remembered on each device.
3. **Add a note** by typing in the "Add note" box under a highlight in the
   sidebar. Notes save as you type.

The sidebar opens by itself the first time you open a PDF or EPUB. The command
**Open annotations sidebar** brings it back.

### Getting around

- **Click a highlight in the document** to land in its note box in the
  sidebar.
- **Click a highlight's words in the sidebar** to go to it in the document.
- **Right-click plain text** for "Add note", which makes a note of its own at
  that point.
- **Delete** a highlight or note with the trash can on its card, by
  right-clicking the card, or by selecting the card and pressing Delete. Right-clicking a
  highlight in the document offers the same.
- **Hover over a footnote or endnote marker** to read the note without
  leaving your place. Click the marker, or the preview, to jump to it. This
  works for any link to somewhere else in the same document.

Every note is marked by a small icon in the left margin, level with what it
belongs to, so it never covers the text.

### The sidebar

- **Search annotations**, at the top, filters the cards as you type. It
  forgives a slip or two in each word. Clicking a result shows it among all
  the others; clicking it again goes to it in the document. Esc clears the
  search.
- **The order button** beside the search box switches between the order things
  appear in the document and the order you added them.
- **A highlight longer than five lines** is cut short, fading out. Click it
  once to read the whole thing and again to go to it. "Show less" cuts it
  short again. A note longer than five lines is cut short in the same way
  whenever you're not typing in it.
- **The card you're working with** has a bold outline, which goes when you
  click anywhere else.
- **The note button** makes a markdown note (see below).

### Making a note

The note button at the top of the sidebar, or the command **Create note from
annotations**, makes a markdown file with the same name as the PDF or EPUB,
beside it, and opens it. It holds every highlight and note in reading order.

```markdown
- "the smallest unit that can still be called a place"
	- this is the definition the rest of chapter 3 leans on
- a thought of mine, anchored on page 14
```

How it is laid out is up to you; see the settings below. If a file of that
name already exists, a number is added, so nothing is ever written over. The
note is yours to edit: the plugin never touches it again, so make another one
when you want an updated copy.

### EPUB

EPUBs open in the plugin's own reader, as one continuous scroll through the
whole book. Everything above works in them as it does in PDFs. The book uses
your theme's colours and font unless it sets its own.
A chapter heading that only links back to the table of contents, as many
ebook tools make them, is shown as plain text, so clicking it doesn't take
you away from the chapter.

Books with DRM, and fixed-layout books such as picture books and magazines,
can't be opened; the reader says so. Nothing in a book can run: it is shown
in a sandbox with scripts switched off.

## Settings

- **Snap highlight to whole words.** For boring reasons, highlights can be
  inaccurate. If you often want to highlight half a word, turn this off.
  Otherwise, this toggle should improve performance.
- **Highlight colour.** Used for new highlights. Existing ones keep the colour
  they were made with.
- **Highlighted text is enclosed in** single quotation marks, double quotation
  marks, or nothing.
- **Highlighted text appears in the .md file as** new bullets, new lines or new
  paragraphs.
- **Each note attached to highlighted text appears in the .md file** as a
  bullet indented under the highlighted text, on a new line under it, in a new
  paragraph under it, or on the same line as it.
- **Notes that aren't attached to highlighted text appear in the .md file as**
  new bullets, new lines or new paragraphs.
- **Look up in the right-click menu** (Mac only). Adds a button that shows the
  dictionary entry for the word you right-click.
- **Remember each PDF's zoom level.** Each PDF reopens at the zoom you last
  read it at. This is kept per device, since a comfortable zoom depends on the
  screen in front of you.

## Undoing

Cmd or Ctrl with Z steps back through the highlights and notes on the document
you are looking at. Adding Shift steps forward again, and on Windows and Linux
so does Y. Everywhere else those keys keep their usual meaning. Inside a note
box they undo your typing, a burst at a time, as the rest of Obsidian does.

The keys can't be rebound. On the desktop, the editor's undo isn't an Obsidian
command, and a plugin command bound to Cmd+Z would stop it working everywhere
without the hotkey settings warning you. So the plugin catches the key itself,
only for keystrokes that belong to a document it shows.

The history goes fifty changes back per document, lives in memory, and is lost
when Obsidian restarts. It is also cleared when the annotations file changes
from outside the plugin, by a sync for instance.

## Where your annotations live

For `refs/paper.pdf`, the annotations are kept in `refs/paper.annotations.json`.
For `refs/book.epub`, they are kept in `refs/book.epub.annotations.json`. The
extension stays in the name so that a PDF and an EPUB with the same name can't
share one file.

That file is the only copy of your annotations. It is plain JSON, so it
syncs, diffs and backs up like anything else. Keep it next to its document when
you move things around. If it is ever unreadable, the document opens with its
annotations read-only rather than starting over, so there is something left to
recover.

## Notes

- Want Zotero's citation functions? Just point an AI at a final draft and a
  folder of notes and sources, and it will generate accurate citations in
  whatever style you like.
- PDFs and EPUBs can be made in different ways. This means that, like in any
  annotation tool, highlights may occasionally be mildly inaccurate, like
  capturing a full stop that you didn't highlight. This is annoying. Will try
  to improve in v1. The known cases are written up in
  [KNOWN-ISSUES.md](KNOWN-ISSUES.md).

## Wishlist

- Text-to-speech. This keeps getting better and better. I would rather wait a
  few generations before trying to add this.
- AI study partner-like integration. To me, Third Mind Reader has the most
  interesting approach to this. I may or may not mess with this in the future.
- RSS / Webclipper integration. I would love to have all of my reading in one
  app. Maybe in v1.
- To stop vault bloat, I'd like a command that moves sources to a folder
  outside of the vault once I'm done with them. I would also like a "Recall"
  command that would bring them back in quickly if needed, keeping all of the
  annotation links in place.
- Integrate with an Obsidian-based source library that shows progress, where
  you can drag and drop sources to indicate priority, and that auto-detects new
  PDF and EPUB files.

## Installing

From the community plugin browser, or by hand: copy `main.js`, `manifest.json`
and `styles.css` into `<vault>/.obsidian/plugins/minimal-pdf-annotator/` and
enable the plugin in Settings, then Community plugins.

PDFs open in Obsidian's own PDF viewer, which the plugin works alongside. EPUBs
open in the plugin's reader. If another plugin already opens EPUBs, only one
of them can; disable the other to use this one for books.

Documents in pop-out windows work as they do in the main window.

On phones and tablets the sidebar is a drawer, so it doesn't open by itself:
open it from the right edge. Clicking a highlight still opens it at that
highlight's note, and clicking a card closes it again to show the place. This
has been checked in Obsidian's mobile emulation on a computer, not yet on a
real phone or tablet.

## Tests

```
node tests/run.js
```

No dependencies, no build step. The unit tests cover the pure logic: page
geometry, how a selection becomes a highlight, the note's layout, undo, the
sidebar's search and order, footnote regions, and reading an EPUB's zip.
Everything that needs a document on screen is covered by a separate suite
that drives a real Obsidian window, kept outside this repository;
`tests/README.md` says more.

## Licence

MIT. See [LICENSE](LICENSE).
