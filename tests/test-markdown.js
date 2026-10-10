/* The generated markdown file, and the rule that decides whether the plugin is
   allowed to write it.

   That rule is the one piece of this plugin that can destroy something: the
   transcript lives at "<name>.md" next to "<name>.pdf", which is also exactly
   what a person taking notes on a PDF by hand would call their note. */
const Module = require("module"), path = require("path"), fs = require("fs");

const notices = [];
class TFile {}

/* A stand-in for Obsidian's context menu that records what was offered. */
class MenuStub {
  constructor() {
    this.items = [];
    MenuStub.last = this;
  }
  addItem(build) {
    const item = {
      title: "",
      icon: "",
      click: null,
      setTitle(t) {
        item.title = t;
        return item;
      },
      setIcon(i) {
        item.icon = i;
        return item;
      },
      setSection() {
        return item;
      },
      onClick(fn) {
        item.click = fn;
        return item;
      },
    };
    build(item);
    this.items.push(item);
    return this;
  }
  showAtMouseEvent() {
    this.shown = true;
  }
}
const stubs = {
  obsidian: {
    Plugin: class {},
    PluginSettingTab: class {},
    Setting: class {},
    Menu: MenuStub,
    Notice: class { constructor(message) { notices.push(message); } },
    TFile,
    Platform: { isMacOS: true },
    MarkdownRenderer: { render: async () => {} },
    normalizePath: (x) => x,
    setIcon: () => {},
    debounce: (fn) => fn,
  },
};
const o = Module._load;
Module._load = (r, p, i) => stubs[r] || o.apply(Module, [r, p, i]);
const P = path.join(__dirname, "..", "main.js");
const m = new Module(P, null); m.filename = P; m.paths = Module._nodeModulePaths(path.dirname(P));
m._compile(
  fs.readFileSync(P, "utf8") +
    "\nmodule.exports.__t={renderMarkdown,collapseWhitespace,stamp,pct,pageNumberOf,uuid," +
    "firstRect,migrateHighlight,dropRunningHeads,unionRect,pagePaddingBox," +
    "measurable,cell,round,blank,charAt,describePoint,sameLine,boundaryPosition," +
    "indexOfBoundary,touchedBounds,refineBoundary,nearestPointer,isWordChar,insideWord," +
    "snapStart,snapEnd,selectedSlice,linesFromChars,textOfChars,snapshot,NoteHistory,BoxDrag," +
    "validZoom,pdfViewerOf,pruneZooms,placeBox,clampToViewport};\n",
  P
);
const PluginClass = m.exports;
const T = m.exports.__t;

let pass = 0, fail = 0;
function eq(name, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got      ${JSON.stringify(got)}\n         expected ${JSON.stringify(expected)}`); }
}

/* A highlight in the current shape: every rectangle names its own page. */
const hl = (text, rects, extra) =>
  Object.assign({ id: text, text, rects, note: "" }, extra || {});
const r = (page, y, x = 0.1, w = 0.8, h = 0.02) => ({ page, x, y, w, h });

/* ------------------------------------------------- page geometry (the box) */

/* Obsidian gives .page a transparent border that scales with the zoom, so the
   bounding rect is bigger than the box an overlay with `inset: 0` is laid out
   against. Measuring against the wrong one shifted every highlight off centre
   and left a gap at each end of a line. */
console.log("--- pagePaddingBox");

function fakePage(rect, border) {
  return { rect, border };
}
global.getComputedStyle = (el) =>
  Object.assign(
    {
      borderLeftWidth: (el.border || 0) + "px",
      borderRightWidth: (el.border || 0) + "px",
      borderTopWidth: (el.border || 0) + "px",
      borderBottomWidth: (el.border || 0) + "px",
      height: "12px",
      userSelect: "auto",
      webkitUserSelect: "auto",
    },
    el.computed || {}
  );
const withRect = (page) => ({
  border: page.border,
  getBoundingClientRect: () => page.rect,
});

eq(
  "the border is taken off all four sides",
  T.pagePaddingBox(withRect(fakePage({ left: 100, top: 50, width: 816, height: 1056 }, 4))),
  { left: 104, top: 54, width: 808, height: 1048 }
);
eq(
  "with no border the box is the bounding rect",
  T.pagePaddingBox(withRect(fakePage({ left: 0, top: 0, width: 800, height: 1000 }, 0))),
  { left: 0, top: 0, width: 800, height: 1000 }
);
eq(
  "a page not laid out yet has no box",
  T.pagePaddingBox(withRect(fakePage({ left: 0, top: 0, width: 0, height: 0 }, 4))),
  null
);

/* The regression this fixes, stated as arithmetic. A line running the full
   width of an 816px page with a 4px border: measured against the outer box and
   then positioned inside the inner one, it starts 4px right of the text and
   ends about 4px short of it. */
{
  const outer = { left: 100, top: 0, width: 816, height: 1056 };
  const inner = T.pagePaddingBox(withRect(fakePage(outer, 4)));
  const lineLeft = 140;
  const lineRight = 876;
  const wrongX = (lineLeft - outer.left) / outer.width;
  const rightX = (lineLeft - inner.left) / inner.width;
  const wrongScreen = inner.left + wrongX * inner.width;
  const rightScreen = inner.left + rightX * inner.width;
  eq("measured correctly, the highlight lands on the text", Math.round(rightScreen), lineLeft);
  eq("measured against the outer box, it was off", Math.round(wrongScreen) !== lineLeft, true);
  const wrongW = ((lineRight - lineLeft) / outer.width) * inner.width;
  eq("and too narrow by several pixels", Math.round(lineRight - lineLeft - wrongW), 7);
}

/* ------------------------------------------- does a span's position count? */

/* Two boxes were appearing in the top-left corner of a PDF on any selection
   that crossed a page break. Obsidian's stylesheet gives a tagged PDF's
   structural spans `height: 0`, and pins the viewer's selection helper to the
   top of the page while a drag is in progress, so text inside either measures
   as a box at the page origin. The text still counts; the position does not. */
console.log("--- measurable");

const span = (opts) => {
  const o = opts || {};
  const classes = o.classes || [];
  return {
    tagName: "SPAN",
    className: classes.join(" "),
    classList: { contains: (c) => classes.includes(c) },
    closest: (sel) => (o.inEndOfContent && sel === ".endOfContent" ? {} : null),
    computed: o.computed || {},
  };
};
const textIn = (el) => ({ nodeType: 3, parentElement: el });

eq("an ordinary text span counts", T.measurable(textIn(span())).ok, true);
eq("and says where it is", T.measurable(textIn(span())).where, "span");
eq(
  "a tagged PDF's structural span does not",
  T.measurable(textIn(span({ classes: ["markedContent"] }))).ok,
  false
);
eq(
  "and says why",
  T.measurable(textIn(span({ classes: ["markedContent"] }))).where,
  "span.markedContent (zero height)"
);
eq(
  "the viewer's selection helper does not",
  T.measurable(textIn(span({ inEndOfContent: true }))).ok,
  false
);
eq(
  "nor does anything unselectable",
  T.measurable(textIn(span({ computed: { userSelect: "none" } }))).ok,
  false
);
eq(
  "nor anything of zero height",
  T.measurable(textIn(span({ computed: { height: "0px" } }))).ok,
  false
);
eq("a node with no parent does not", T.measurable({ nodeType: 3, parentElement: null }).ok, false);

/* ------------------------------------------------------ the character model

   A highlight is cut from one array of characters, each carrying its own
   rectangle. The text stored and the rectangles drawn are both slices of that
   array. The earlier design read the text from character offsets and the
   rectangles from the browser's selection geometry, which are two answers to
   the same question, and they disagreed by a glyph: a highlight would stretch
   over a full stop the transcript left out, or the transcript would carry one
   the highlight did not cover. */

const sharedNode = { nodeType: 3, nodeValue: "" };

/* Characters laid out left to right on a line, as buildChars would produce
   them, seven pixels to a glyph. */
function chars(spec) {
  const out = [];
  for (const [text, left, top, node] of spec) {
    for (let i = 0; i < text.length; i++) {
      out.push({
        ch: text[i],
        node: node || sharedNode,
        touched: true,
        box: { left: left + i * 7, right: left + (i + 1) * 7, top, bottom: top + 12 },
      });
    }
  }
  return out;
}
const textOf = (cs, from, to) => cs.slice(from, to).map((c) => c.ch).join("");
const unmeasured = (ch) => ({ ch, node: sharedNode, touched: true, box: null });

const LINE1 = chars([["episodes of loneliness.", 100, 500]]);
const xOf = (i) => T.boundaryPosition(LINE1, i).x;

console.log("--- sameLine");
eq("two characters side by side", T.sameLine(LINE1[0], LINE1[5]), true);
eq("two characters a line apart", T.sameLine(LINE1[0], chars([["x", 100, 530]])[0]), false);
eq("an unmeasured character is on no line", T.sameLine(LINE1[0], unmeasured("x")), false);

console.log("\n--- boundaryPosition");
eq("a boundary sits at the right edge of the character before it", T.boundaryPosition(LINE1, 1).x, 107);
eq("the first boundary uses the character after it", T.boundaryPosition(LINE1, 0).x, 100);
eq("the last uses the character before it", T.boundaryPosition(LINE1, LINE1.length).x, 100 + LINE1.length * 7);
eq("a boundary with nothing to measure has no position", T.boundaryPosition([unmeasured("a")], 1), null);

console.log("\n--- refineBoundary");

/* The reason this exists. The viewer stretches each span of text horizontally
   to match the document's letter spacing, and the browser picks a character
   boundary using the unstretched metrics, so its answer can sit a glyph away
   from where the pointer actually was. */
eq("the text under test", textOf(LINE1, 12, 22), "loneliness");
eq("and its full stop", textOf(LINE1, 22, 23), ".");

eq(
  "a pointer past the full stop reaches the boundary after it",
  T.refineBoundary(LINE1, 22, { x: xOf(23) + 1, y: 506 }),
  23
);
eq(
  "a pointer before the full stop stays before it",
  T.refineBoundary(LINE1, 23, { x: xOf(22) - 1, y: 506 }),
  22
);
eq("a pointer already at the boundary leaves it alone", T.refineBoundary(LINE1, 22, { x: xOf(22), y: 506 }), 22);
eq("a pointer on another line is ignored", T.refineBoundary(LINE1, 22, { x: xOf(10), y: 900 }), 22);
eq("no pointer, no change", T.refineBoundary(LINE1, 22, null), 22);
eq("the nudge reaches only a few characters", T.refineBoundary(LINE1, 22, { x: xOf(2), y: 506 }), 18);

console.log("\n--- nearestPointer");
{
  const down = { x: xOf(0), y: 506 };
  const up = { x: xOf(22), y: 506 };
  eq("the start is judged against where the drag began", T.nearestPointer(LINE1, 0, { down, up }), down);
  eq("and the end against where it finished", T.nearestPointer(LINE1, 22, { down, up }), up);
  eq("a drag made backwards sorts itself out", T.nearestPointer(LINE1, 0, { down: up, up: down }), down);
  eq("with nothing recorded there is nothing to judge against", T.nearestPointer(LINE1, 0, {}), null);
}

console.log("\n--- insideWord, snapStart and snapEnd");

eq("a word character", T.isWordChar(LINE1[12]), true);
eq("a full stop is not", T.isWordChar(LINE1[22]), false);
eq("nor a space", T.isWordChar(LINE1[8]), false);

eq("strictly inside a word", T.insideWord(LINE1, 15), true);
eq("on the first letter of a word is not inside it", T.insideWord(LINE1, 12), false);
eq("before a full stop is not inside a word", T.insideWord(LINE1, 22), false);
eq("the very start is not inside a word", T.insideWord(LINE1, 0), false);
eq("the very end is not inside a word", T.insideWord(LINE1, LINE1.length), false);

eq("a start inside a word widens back to its first letter", T.snapStart(LINE1, 15), 12);
eq("a start already on a boundary holds", T.snapStart(LINE1, 12), 12);
eq("an end inside a word widens to its last letter", T.snapEnd(LINE1, 20), 22);
eq("the case that was reported", textOf(LINE1, 12, T.snapEnd(LINE1, 21)), "loneliness");
eq("an end already on a boundary holds", T.snapEnd(LINE1, 22), 22);

/* The thing snapping must not do. A boundary already between two words stays
   put, so starting a drag in the gap before a word cannot reach back and take
   the word before it. */
eq("a boundary in the gap between words stays there", T.snapStart(LINE1, 11), 11);
eq("leaving the space in and the word before out", textOf(LINE1, T.snapStart(LINE1, 11), 22), " loneliness");

/* A PDF leaves no space character at a line break, so without the same-line
   test a word would be completed from the line below. */
{
  const broken = chars([["in the", 100, 500], ["experience", 100, 520]]);
  eq("snapping does not reach across a line break", T.snapEnd(broken, 6), 6);
}

console.log("\n--- linesFromChars");
{
  const two = chars([["first line", 100, 500], ["second line", 100, 520]]);
  const lines = T.linesFromChars(two, 0, two.length);
  eq("characters group into one line each", lines.length, 2);
  eq("in reading order", lines.map((l) => l.text), ["first line", "second line"]);
  eq(
    "with a rectangle covering the line",
    { left: lines[0].left, top: lines[0].top, width: lines[0].width, height: lines[0].height },
    { left: 100, top: 500, width: 70, height: 12 }
  );
}
{
  const some = T.linesFromChars(LINE1, 12, 22);
  eq("only the slice asked for is used", some.map((l) => l.text), ["loneliness"]);
  eq("the rectangle starts at the first character of it", some[0].left, LINE1[12].box.left);
  eq("and ends at the last", some[0].left + some[0].width, LINE1[21].box.right);
}
{
  const withGap = chars([["ab", 100, 500]]);
  withGap.splice(1, 0, unmeasured("X"));
  const lines = T.linesFromChars(withGap, 0, withGap.length);
  eq("an unmeasured character keeps its text", lines[0].text, "aXb");
  eq("and does not break the line in two", lines.length, 1);
  eq("the line's rectangle still covers the measured ends", lines[0].width, 14);
}
{
  const lines = T.linesFromChars([unmeasured("o")], 0, 1);
  eq("a line of nothing measurable has text but no geometry", lines[0], {
    text: "o",
    left: null,
    top: null,
    width: null,
    height: null,
  });
}

console.log("\n--- textOfChars");

/* A PDF's text layer carries no spaces between its spans, so reading the text
   without putting them back ran words together: "in theexperience". */
{
  const a = { nodeType: 3 };
  const b = { nodeType: 3 };
  eq(
    "a gap between two spans becomes a space",
    T.textOfChars(chars([["the", 100, 500, a], ["experience", 128, 500, b]])),
    "the experience"
  );
  eq(
    "two spans that adjoin get no space",
    T.textOfChars(chars([["ex", 100, 500, a], ["perience", 114, 500, b]])),
    "experience"
  );
}
{
  /* The viewer stretches a span's letters apart, so gaps inside one span say
     nothing and its characters are taken as they come. */
  const stretched = chars([["wide", 100, 500]]);
  stretched.forEach((c, i) => {
    c.box.left = 100 + i * 40;
    c.box.right = c.box.left + 7;
  });
  eq("gaps within one span are left alone", T.textOfChars(stretched), "wide");
}

console.log("\n--- indexOfBoundary and touchedBounds");
{
  const node = { nodeType: 3, nodeValue: "abcdef" };
  const cs = chars([["abcdef", 100, 500, node]]);
  eq("an offset becomes an index", T.indexOfBoundary(cs, node, 3), 3);
  eq("the end of the node is a valid boundary", T.indexOfBoundary(cs, node, 6), 6);
  eq("an offset past the end is clamped", T.indexOfBoundary(cs, node, 99), 6);
  eq("an element boundary is not a character offset", T.indexOfBoundary(cs, { nodeType: 1 }, 2), -1);
  eq("a node from another page is not here", T.indexOfBoundary(cs, { nodeType: 3, nodeValue: "x" }, 0), -1);
  eq("the touched span of the page", T.touchedBounds(cs), { from: 0, to: 6 });
  cs[0].touched = false;
  eq("narrowing when the first character is outside", T.touchedBounds(cs), { from: 1, to: 6 });
  cs.forEach((c) => (c.touched = false));
  eq("nothing touched", T.touchedBounds(cs), null);
}

console.log("\n--- selectedSlice");

/* The reported case end to end: the browser's boundary one glyph short of
   where the pointer was, inside a word, with a full stop just after it. */
{
  const node = { nodeType: 3, nodeValue: "episodes of loneliness." };
  const cs = chars([["episodes of loneliness.", 100, 500, node]]);
  const range = { startContainer: node, startOffset: 12, endContainer: node, endOffset: 21 };
  const pointers = { down: { x: cs[12].box.left, y: 506 }, up: { x: cs[21].box.right + 1, y: 506 } };

  const slice = T.selectedSlice(cs, range, pointers, true);
  eq("the boundary is corrected and the word completed", textOf(cs, slice.from, slice.to), "loneliness");

  const noSnap = T.selectedSlice(cs, range, pointers, false);
  eq("with snapping off the pointer still decides", textOf(cs, noSnap.from, noSnap.to), "loneliness");

  const noPointers = T.selectedSlice(cs, range, {}, false);
  eq("with neither, the browser's answer stands", textOf(cs, noPointers.from, noPointers.to), "lonelines");
}
{
  /* A pointer dragged past the full stop takes it, and the transcript and the
     rectangles then agree about it, because both are this one slice. */
  const node = { nodeType: 3, nodeValue: "episodes of loneliness." };
  const cs = chars([["episodes of loneliness.", 100, 500, node]]);
  const range = { startContainer: node, startOffset: 12, endContainer: node, endOffset: 22 };
  const pointers = { down: { x: cs[12].box.left, y: 506 }, up: { x: cs[22].box.right + 2, y: 506 } };
  const slice = T.selectedSlice(cs, range, pointers, true);
  eq("a full stop dragged over is included", textOf(cs, slice.from, slice.to), "loneliness.");
  const lines = T.linesFromChars(cs, slice.from, slice.to);
  eq("and the text matches the slice", lines[0].text, "loneliness.");
  eq("and the rectangle ends after it", lines[0].left + lines[0].width, cs[22].box.right);
}
{
  const node = { nodeType: 3, nodeValue: "a whole page of text" };
  const cs = chars([["a whole page of text", 100, 500, node]]);
  const elsewhere = { nodeType: 3, nodeValue: "another page" };
  const range = { startContainer: elsewhere, startOffset: 0, endContainer: elsewhere, endOffset: 1 };
  const slice = T.selectedSlice(cs, range, {}, false);
  eq("a middle page contributes all of itself", textOf(cs, slice.from, slice.to), "a whole page of text");
}
{
  const node = { nodeType: 3, nodeValue: "untouched" };
  const cs = chars([["untouched", 100, 500, node]]);
  cs.forEach((c) => (c.touched = false));
  const range = { startContainer: node, startOffset: 0, endContainer: node, endOffset: 0 };
  eq("a page the selection does not touch contributes nothing", T.selectedSlice(cs, range, {}, false), null);
}

console.log("\n--- report helpers");
eq("a rounded number", T.round(12.3456), 12.3);
eq("a table cell escapes pipes", T.cell("a|b"), "a\\|b");
eq("and flattens newlines", T.cell("a\nb"), "a b");
eq("a blank stands in for no number", T.blank(null), "");
eq("and a number is rounded", T.blank(1.27), 1.3);
eq("a character by index", T.charAt(LINE1, 12), "l");
eq("out of range is blank", T.charAt(LINE1, 999), "");
eq("a recorded pointer", T.describePoint({ x: 1.26, y: 2 }), "1.3, 2");
eq("an unrecorded one", T.describePoint(null), "not recorded");

/* ------------------------------------------------------ running headers */

console.log("\n--- dropRunningHeads");

const ln = (top, text = "body", height = 12) => ({ left: 0, top, width: 100, height, text });

/* The case that was reported: a selection running off the bottom of page 1
   also picked up a line at the very top of it, because the PDF draws its
   header late in the content stream. */
eq(
  "a stray line far above the rest goes, wherever it sits in reading order",
  T.dropRunningHeads([ln(600), ln(614), ln(628), ln(50, "Smith et al.   14")]).map((l) => l.text),
  ["body", "body", "body"]
);
eq(
  "a stray line far below the rest goes too",
  T.dropRunningHeads([ln(900, "- 14 -"), ln(100), ln(114), ln(128)]).map((l) => l.text),
  ["body", "body", "body"]
);
eq(
  "the lines that stay keep their reading order",
  T.dropRunningHeads([ln(614, "second"), ln(50, "header"), ln(600, "first")]).map((l) => l.text),
  ["second", "first"]
);

/* The thing this must not break. In a two-column paper, the top of the next
   column is far above the bottom of the previous one. */
const twoColumns = [ln(700), ln(714), ln(728), ln(100), ln(114), ln(128), ln(142)];
eq("a two-column selection is left alone", T.dropRunningHeads(twoColumns).length, 7);

eq(
  "an ordinary paragraph break is not a header",
  T.dropRunningHeads([ln(100), ln(114), ln(134), ln(148)]).length,
  4
);
eq(
  "at most two lines go from either extreme",
  T.dropRunningHeads([ln(0), ln(60), ln(120), ln(180), ln(240), ln(300)]).length,
  2
);
eq("too few lines to judge, so none are dropped", T.dropRunningHeads([ln(0), ln(600)]).length, 2);
eq("a single line is never dropped", T.dropRunningHeads([ln(100)]).length, 1);
eq("nor is an empty list disturbed", T.dropRunningHeads([]), []);
eq(
  "unmeasurable lines are never dropped",
  T.dropRunningHeads([
    { left: null, top: null, width: null, height: null, text: "orphan" },
    ln(100),
    ln(114),
    ln(128),
  ]).length,
  4
);

/* ------------------------------------------------------------- firstRect */

console.log("\n--- firstRect");

eq("the only rectangle", T.firstRect(hl("a", [r(3, 0.4)])).page, 3);
eq(
  "the earliest page wins over a higher position",
  T.firstRect(hl("a", [r(5, 0.1), r(4, 0.9)])).page,
  4
);
eq(
  "within a page, the topmost wins",
  T.firstRect(hl("a", [r(4, 0.9), r(4, 0.2)])).y,
  0.2
);
eq("no rectangles, no answer", T.firstRect(hl("a", [])), null);

/* ----------------------------------------------------------- old files */

console.log("\n--- migrateHighlight");

eq(
  "a one-page highlight gains the page on each rectangle",
  T.migrateHighlight({ id: "x", text: "t", page: 7, rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.02 }] }),
  { id: "x", text: "t", rects: [{ page: 7, x: 0.1, y: 0.2, w: 0.5, h: 0.02 }] }
);
eq(
  "a missing page number becomes page one",
  T.migrateHighlight({ id: "x", text: "t", rects: [{ x: 0, y: 0, w: 1, h: 1 }] }).rects[0].page,
  1
);
eq(
  "an already-migrated highlight is left alone",
  T.migrateHighlight(hl("t", [r(2, 0.5)])),
  hl("t", [r(2, 0.5)])
);
eq(
  "one with no rectangles survives",
  T.migrateHighlight({ id: "x", text: "t", rects: [] }),
  { id: "x", text: "t", rects: [] }
);

/* ----------------------------------------------------------- the transcript */

console.log("\n--- renderMarkdown");

eq("nothing to say produces nothing", T.renderMarkdown({ highlights: [], notes: [] }), "");

eq(
  "a highlight becomes a quoted bullet",
  T.renderMarkdown({ highlights: [hl("hello there", [r(1, 0.1)])], notes: [] }),
  '- "hello there"\n'
);

eq(
  "a PDF's own line breaks inside a highlight are collapsed",
  T.renderMarkdown({ highlights: [hl("broken\nacross   lines", [r(1, 0)])], notes: [] }),
  '- "broken across lines"\n'
);

eq(
  "a note on a highlight is indented under it",
  T.renderMarkdown({ highlights: [hl("quote", [r(1, 0)], { note: "first\nsecond" })], notes: [] }),
  '- "quote"\n\t- first\n\t- second\n'
);

eq(
  "a whitespace-only note on a highlight is left out",
  T.renderMarkdown({ highlights: [hl("quote", [r(1, 0)], { note: "   " })], notes: [] }),
  '- "quote"\n'
);

eq(
  "a standalone note is a plain bullet, continuation lines indented",
  T.renderMarkdown({ highlights: [], notes: [{ page: 1, text: "one\ntwo", position: { y: 0.5 } }] }),
  "- one\n\ttwo\n"
);

eq(
  "items come out in reading order: page, then down the page",
  T.renderMarkdown({
    highlights: [hl("second page", [r(2, 0.1)]), hl("lower", [r(1, 0.8)]), hl("upper", [r(1, 0.2)])],
    notes: [{ page: 1, text: "middle", position: { y: 0.5 } }],
  }),
  '- "upper"\n- middle\n- "lower"\n- "second page"\n'
);

eq(
  "a highlight spanning two pages is one bullet, placed by where it starts",
  T.renderMarkdown({
    highlights: [hl("later on page two", [r(2, 0.5)]), hl("across the break", [r(1, 0.9), r(2, 0.1)])],
    notes: [],
  }),
  '- "across the break"\n- "later on page two"\n'
);

eq(
  "a highlight with no rects still appears",
  T.renderMarkdown({ highlights: [hl("orphan", [])], notes: [] }),
  '- "orphan"\n'
);

eq("missing arrays are tolerated", T.renderMarkdown({}), "");

/* Quotes in the highlighted text are left as they are rather than
   backslash-escaped. Both forms render identically in markdown, so the escapes
   only showed up as stray backslashes when reading the file as text. */
eq(
  "quotes inside a highlight are not escaped",
  T.renderMarkdown({ highlights: [hl('he said "hi"', [r(1, 0)])], notes: [] }),
  '- "he said "hi""\n'
);
eq(
  "nor are backslashes",
  T.renderMarkdown({ highlights: [hl("a\\b", [r(1, 0)])], notes: [] }),
  '- "a\\b"\n'
);

/* ------------------------------------------------------------- the stamp */

console.log("\n--- stamp");

eq("the same text stamps the same", T.stamp("hello") === T.stamp("hello"), true);
eq("different text stamps differently", T.stamp("hello") === T.stamp("hellp"), false);
eq("a reordering is caught", T.stamp("ab") === T.stamp("ba"), false);
eq("the empty string has a stamp", typeof T.stamp(""), "string");
eq("length is part of it", T.stamp("a").split("-")[1], "1");

/* --------------------------------------------- may we write that .md file? */

console.log("\n--- writeMarkdown ownership");

/* A vault just big enough for writeMarkdown: files are TFile instances, so the
   instanceof checks in the plugin behave as they do in Obsidian. */
function fakeVault(files) {
  const contents = new Map(Object.entries(files));
  const handles = new Map();
  for (const p of contents.keys()) {
    const f = new TFile();
    f.path = p;
    handles.set(p, f);
  }
  return {
    log: [],
    getAbstractFileByPath(p) {
      return handles.get(p) || null;
    },
    async read(file) {
      return contents.get(file.path);
    },
    async modify(file, data) {
      this.log.push(["modify", file.path]);
      contents.set(file.path, data);
    },
    async create(p, data) {
      this.log.push(["create", p]);
      const f = new TFile();
      f.path = p;
      handles.set(p, f);
      contents.set(p, data);
    },
    read_(p) {
      return contents.get(p);
    },
  };
}

function harness(files, data) {
  const plugin = Object.create(PluginClass.prototype);
  const vault = fakeVault(files);
  plugin.app = { vault };
  plugin.settings = { highlightColor: "#ffeb3b", snapToWords: true };
  const pdf = new TFile();
  pdf.path = "refs/paper.pdf";
  const doc = {
    file: pdf,
    data: Object.assign({ highlights: [], notes: [], markdownStamp: null }, data),
    readOnly: false,
    markdownWarned: false,
    saveChain: Promise.resolve(),
  };
  return { plugin, vault, doc };
}

const ONE = { highlights: [hl("quote one", [r(1, 0)])], notes: [] };
const ONE_MD = '- "quote one"\n';

(async () => {
  {
    const { plugin, vault, doc } = harness({}, ONE);
    notices.length = 0;
    await plugin.writeMarkdown(doc);
    eq("no file there yet: one is created", vault.log, [["create", "refs/paper.md"]]);
    eq("with the transcript in it", vault.read_("refs/paper.md"), ONE_MD);
    eq("and the stamp recorded", doc.data.markdownStamp, T.stamp(ONE_MD));
    /* A file has appeared in the vault that was not there before, and where it
       appeared is not obvious, so this one is worth saying out loud. */
    eq("and the new file is announced, by its path", notices, ["Created refs/paper.md"]);
  }

  {
    const { plugin, vault, doc } = harness({}, { highlights: [], notes: [] });
    await plugin.writeMarkdown(doc);
    eq("nothing to write means no file is created", vault.log, []);
  }

  {
    /* The ordinary case: we wrote it last time, a highlight has been added. */
    const { plugin, vault, doc } = harness({ "refs/paper.md": ONE_MD }, {
      highlights: [hl("quote one", [r(1, 0)]), hl("quote two", [r(1, 0.5)])],
      notes: [],
      markdownStamp: T.stamp(ONE_MD),
    });
    notices.length = 0;
    await plugin.writeMarkdown(doc);
    eq("a file we wrote is updated", vault.log, [["modify", "refs/paper.md"]]);
    eq("to the new transcript", vault.read_("refs/paper.md"), '- "quote one"\n- "quote two"\n');
    eq("quietly, since it is not news", notices.length, 0);
  }

  {
    /* The dangerous case: someone's own note is sitting at that path. */
    const mine = "# Paper\n\nMy own notes on this paper, which took a while.\n";
    const { plugin, vault, doc } = harness({ "refs/paper.md": mine }, ONE);
    notices.length = 0;
    await plugin.writeMarkdown(doc);
    eq("a file we did not write is left alone", vault.log, []);
    eq("its contents survive untouched", vault.read_("refs/paper.md"), mine);
    eq("and the person is told once", notices.length, 1);
    eq("by a message naming the file", notices[0].includes("refs/paper.md"), true);

    await plugin.writeMarkdown(doc);
    eq("still left alone on the next save", vault.log, []);
    eq("and not told twice", notices.length, 1);
  }

  {
    /* Edited by hand after we generated it: the edit is somebody's work too. */
    const edited = ONE_MD + "\nand a thought of my own\n";
    const { plugin, vault, doc } = harness({ "refs/paper.md": edited }, {
      highlights: [hl("quote one", [r(1, 0)])],
      notes: [],
      markdownStamp: T.stamp(ONE_MD),
    });
    await plugin.writeMarkdown(doc);
    eq("an edited transcript is left alone", vault.log, []);
    eq("with the edit intact", vault.read_("refs/paper.md"), edited);
  }

  {
    /* Generated before stamps were recorded, and still in sync: adopt it,
       so upgrading does not strand the file. */
    const { plugin, vault, doc } = harness({ "refs/paper.md": ONE_MD }, ONE);
    notices.length = 0;
    await plugin.writeMarkdown(doc);
    eq("an unstamped file already in sync is adopted", notices.length, 0);
    eq("nothing needed writing", vault.log, []);
    eq("and it is stamped from now on", doc.data.markdownStamp, T.stamp(ONE_MD));
  }

  {
    /* No redundant writes: Obsidian would log a file change for each one. */
    const { plugin, vault, doc } = harness({ "refs/paper.md": ONE_MD }, {
      highlights: ONE.highlights,
      notes: [],
      markdownStamp: T.stamp(ONE_MD),
    });
    await plugin.writeMarkdown(doc);
    eq("an unchanged transcript is not rewritten", vault.log, []);
  }

  /* ------------------------------------------------------- small helpers */

  console.log("\n--- helpers");

  eq("whitespace collapses", T.collapseWhitespace("  a\n\tb   c "), "a b c");
  eq("a fraction becomes a percentage", T.pct(0.25), "25%");
  eq("a missing fraction becomes zero", T.pct(undefined), "0%");
  eq("an infinite fraction becomes zero", T.pct(Infinity), "0%");
  eq("a page number is read from the dataset", T.pageNumberOf({ dataset: { pageNumber: "7" } }), 7);
  eq("an unreadable page number falls back to one", T.pageNumberOf({ dataset: {} }), 1);
  eq("so does a nonsense one", T.pageNumberOf({ dataset: { pageNumber: "x" } }), 1);

  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(T.uuid());
  eq("ids do not repeat", ids.size, 500);

/* ----------------------------------------------------------- undo and redo

   The history holds whole copies of the annotations rather than descriptions
   of what changed, so a restore puts back a known-good state instead of
   trying to invert an operation. These check that it does, that a redo is
   discarded as soon as something new happens, and that the marker recording
   ownership of the generated markdown file is never restored along with it. */
console.log("\n--- undo and redo");

function undoHarness() {
  const plugin = Object.create(PluginClass.prototype);
  plugin.views = new Map();
  plugin.noteBox = null;
  plugin.saved = 0;
  plugin.queueSave = () => {
    plugin.saved++;
  };
  plugin.closeNoteBox = () => {
    plugin.closedBoxes = (plugin.closedBoxes || 0) + 1;
  };
  /* Drawing needs a real page in a real viewer; counted, not performed. */
  plugin.render = () => {
    plugin.renders = (plugin.renders || 0) + 1;
  };
  const pdf = new TFile();
  pdf.path = "refs/paper.pdf";
  const doc = {
    file: pdf,
    data: { highlights: [], notes: [], markdownStamp: "original" },
    readOnly: false,
    saveChain: Promise.resolve(),
    markdownWarned: false,
    sidecarStamp: null,
    baseline: T.snapshot({ highlights: [], notes: [] }),
    undoStack: [],
    redoStack: [],
  };
  return { plugin, doc };
}
const titles = (doc) => doc.data.highlights.map((h) => h.text);

console.log("  snapshot");
{
  const data = { highlights: [hl("one", [r(1, 0)])], notes: [], markdownStamp: "keep" };
  const copy = T.snapshot(data);
  data.highlights[0].text = "changed";
  eq("a snapshot is a copy, not a reference", copy.highlights[0].text, "one");
  eq("the ownership marker is left out of it", "markdownStamp" in copy, false);
  eq("missing arrays become empty ones", T.snapshot({}), { highlights: [], notes: [] });
}

console.log("  one step");
{
  const { plugin, doc } = undoHarness();
  doc.data.highlights.push(hl("one", [r(1, 0)]));
  plugin.commit(doc, "adding a highlight");
  eq("a change is recorded", doc.undoStack.length, 1);
  eq("with the state it replaced", doc.undoStack[0].state.highlights.length, 0);
  eq("and what was done", doc.undoStack[0].label, "adding a highlight");

  notices.length = 0;
  eq("undoing reports success", plugin.undo(doc), true);
  eq("and puts the highlight back", titles(doc), []);
  eq("the history is now empty", doc.undoStack.length, 0);
  eq("and a redo is waiting", doc.redoStack.length, 1);

  eq("redoing reports success", plugin.redo(doc), true);
  eq("and brings it back", titles(doc), ["one"]);
  eq("undo is available again", doc.undoStack.length, 1);
  /* Stepping through the history is ordinary work and says nothing about it;
     the change on screen is the feedback. */
  eq("and neither step announces itself", notices.length, 0);
}

console.log("  several steps");
{
  const { plugin, doc } = undoHarness();
  for (const name of ["one", "two", "three"]) {
    doc.data.highlights.push(hl(name, [r(1, 0)]));
    plugin.commit(doc, "adding a highlight");
  }
  eq("three changes, three steps back", doc.undoStack.length, 3);

  plugin.undo(doc);
  plugin.undo(doc);
  eq("two steps back", titles(doc), ["one"]);
  plugin.redo(doc);
  eq("one step forward", titles(doc), ["one", "two"]);
  plugin.undo(doc);
  plugin.undo(doc);
  eq("all the way back", titles(doc), []);
  eq("and no further", plugin.undo(doc), false);
  plugin.redo(doc);
  plugin.redo(doc);
  plugin.redo(doc);
  eq("all the way forward", titles(doc), ["one", "two", "three"]);
  eq("and no further", plugin.redo(doc), false);
}

console.log("  a new change after undoing");
{
  const { plugin, doc } = undoHarness();
  doc.data.highlights.push(hl("one", [r(1, 0)]));
  plugin.commit(doc, "adding a highlight");
  plugin.undo(doc);
  eq("a redo is waiting", doc.redoStack.length, 1);

  doc.data.highlights.push(hl("different", [r(1, 0)]));
  plugin.commit(doc, "adding a highlight");
  eq("doing something else discards it", doc.redoStack.length, 0);
  eq("and the new change stands", titles(doc), ["different"]);
}

console.log("  what it does not disturb");
{
  const { plugin, doc } = undoHarness();
  doc.data.highlights.push(hl("one", [r(1, 0)]));
  plugin.commit(doc, "adding a highlight");
  doc.data.markdownStamp = "written-since";
  plugin.undo(doc);
  eq("undoing leaves the ownership marker alone", doc.data.markdownStamp, "written-since");
  eq("and saves the result", plugin.saved > 0, true);
  eq("and closes any open note box", plugin.closedBoxes > 0, true);
  plugin.views.set("v", { view: "v", container: {}, doc });
  plugin.renders = 0;
  plugin.redo(doc);
  eq("every view of that PDF is redrawn", plugin.renders, 1);
}

console.log("  notes as well as highlights");
{
  const { plugin, doc } = undoHarness();
  doc.data.notes.push({ id: "n1", page: 1, text: "a thought", position: { x: 0.5, y: 0.5 } });
  plugin.commit(doc, "adding a note");
  doc.data.notes[0].text = "a better thought";
  plugin.commit(doc, "editing a note");

  plugin.undo(doc);
  eq("an edit to a note is undone", doc.data.notes[0].text, "a thought");
  plugin.undo(doc);
  eq("and so is adding it", doc.data.notes.length, 0);
  plugin.redo(doc);
  plugin.redo(doc);
  eq("and both come back", doc.data.notes[0].text, "a better thought");
}

console.log("  the limit");
{
  const { plugin, doc } = undoHarness();
  for (let i = 0; i < 60; i++) {
    doc.data.highlights.push(hl("h" + i, [r(1, 0)]));
    plugin.commit(doc, "adding a highlight");
  }
  eq("the history stops growing", doc.undoStack.length, 50);
  eq("keeping the most recent changes", doc.undoStack[49].state.highlights.length, 59);
}

console.log("  undo inside a note box");
{
  /* A textarea's native undo steps through a typed run one character at a
     time. CodeMirror, and so the rest of Obsidian, starts a new undo step only
     when you pause, and that is the behaviour being reproduced here. */
  function field(value) {
    return {
      value,
      selectionEnd: value.length,
      setSelectionRange(a) {
        this.selectionEnd = a;
      },
    };
  }
  /* Typing, with control over the clock: `type` advances it by `gap` first. */
  function typer(el, history) {
    let clock = 10000;
    return (text, gap) => {
      clock += gap === undefined ? 50 : gap;
      el.value += text;
      el.selectionEnd = el.value.length;
      history.record(clock);
    };
  }

  {
    const el = field("");
    const h = new T.NoteHistory(el);
    const type = typer(el, h);
    for (const ch of "hello world") type(ch);
    eq("a burst of typing is one step", h.undoStack.length, 1);
    h.undo();
    eq("so it all comes back at once", el.value, "");
    eq("and nothing more to undo", h.undo(), false);
    h.redo();
    eq("redo puts the whole burst back", el.value, "hello world");
  }

  {
    const el = field("");
    const h = new T.NoteHistory(el);
    const type = typer(el, h);
    for (const ch of "first") type(ch);
    for (const ch of " second") type(ch, ch === " " ? 2000 : 50);
    eq("a pause starts a new step", h.undoStack.length, 2);
    h.undo();
    eq("the second burst goes", el.value, "first");
    h.undo();
    eq("then the first", el.value, "");
    h.redo();
    h.redo();
    eq("and both return in order", el.value, "first second");
  }

  {
    const el = field("existing note");
    const h = new T.NoteHistory(el);
    const type = typer(el, h);
    type("!");
    h.undo();
    eq("a note opened with text can be returned to it", el.value, "existing note");
    eq("with the caret where it was", el.selectionEnd, "existing note".length);
  }

  {
    const el = field("");
    const h = new T.NoteHistory(el);
    const type = typer(el, h);
    for (const ch of "abc") type(ch);
    h.undo();
    eq("a redo is waiting", h.redoStack.length, 1);
    type("x", 2000);
    eq("typing something else discards it", h.redoStack.length, 0);
    eq("and the new text stands", el.value, "x");
  }

  {
    const el = field("");
    const h = new T.NoteHistory(el);
    const type = typer(el, h);
    type("a");
    h.undo();
    type("b");
    eq("after an undo, the next keystroke starts its own step", h.undoStack.length, 1);
    h.undo();
    eq("which undoes just that", el.value, "");
  }

  {
    const el = field("");
    const h = new T.NoteHistory(el);
    const type = typer(el, h);
    for (let i = 0; i < 120; i++) type("x" + i, 2000);
    eq("the history stops growing", h.undoStack.length, 100);
  }

  {
    /* Deleting is grouped the same way, since it arrives as a change like any
       other. */
    const el = field("hello");
    const h = new T.NoteHistory(el);
    let clock = 10000;
    const backspace = (gap) => {
      clock += gap === undefined ? 50 : gap;
      el.value = el.value.slice(0, -1);
      el.selectionEnd = el.value.length;
      h.record(clock);
    };
    backspace();
    backspace();
    backspace();
    eq("a run of deletions is one step", h.undoStack.length, 1);
    h.undo();
    eq("and comes back whole", el.value, "hello");
  }
}

console.log("  the undo keys");
{
  /* Cmd or Ctrl with Z is caught by the plugin rather than bound as a hotkey,
     because Obsidian's dispatcher would stop a bound key reaching CodeMirror,
     which is what actually performs editor undo on the desktop. So the
     listener has to be careful about which keystrokes it claims. */
  const { plugin, doc } = undoHarness();
  doc.data.highlights.push(hl("one", [r(1, 0)]));
  plugin.commit(doc, "adding a highlight");

  const inPdf = { closest: () => null };
  const container = { contains: (el) => el === inPdf, isShown: () => true };
  plugin.views.set("v", { view: "v", container, doc });
  plugin.recentView = "v";
  global.document = { activeElement: inPdf };
  global.Element = function () {};
  Object.defineProperty(global.Element, Symbol.hasInstance, {
    value: (x) => !!x && typeof x.closest === "function",
  });

  const press = (over, extra) =>
    Object.assign(
      {
        target: over,
        code: "KeyZ",
        key: "z",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        claimed: 0,
        preventDefault() {
          this.claimed++;
        },
        stopPropagation() {
          this.claimed++;
        },
      },
      extra || {}
    );

  let e = press(inPdf);
  plugin.onKeyDown(e);
  eq("in a PDF, the key undoes", titles(doc), []);
  eq("and is claimed, so nothing else sees it", e.claimed > 0, true);

  e = press(inPdf, { shiftKey: true });
  plugin.onKeyDown(e);
  eq("with shift it redoes", titles(doc), ["one"]);

  e = press(inPdf, { code: "KeyY", key: "y" });
  plugin.onKeyDown(e);
  eq("on a Mac, the other redo key is not used", e.claimed, 0);

  e = press(inPdf, { code: "KeyA", key: "a" });
  plugin.onKeyDown(e);
  eq("another letter is ignored", e.claimed, 0);

  e = press(inPdf, { metaKey: false, ctrlKey: false });
  plugin.onKeyDown(e);
  eq("the letter on its own is ignored", e.claimed, 0);

  e = press(inPdf, { altKey: true });
  plugin.onKeyDown(e);
  eq("so is the same key with alt held", e.claimed, 0);

  /* An open note box takes the key for its own text, through its own history,
     and the annotation around it is left alone. */
  {
    const textarea = { closest: (sel) => (sel.includes(".mpa-note-box") ? {} : null), value: "typed", selectionEnd: 5, setSelectionRange() {} };
    plugin.noteHistory = new T.NoteHistory(textarea);
    plugin.noteHistory.record(10000);
    textarea.value = "typed more";
    plugin.noteHistory.record(20000);

    const before = titles(doc).join();
    const ev = press(textarea);
    plugin.onKeyDown(ev);
    eq("the note box claims the key", ev.claimed > 0, true);
    eq("and undoes its own words", textarea.value, "typed");
    eq("leaving the annotations alone", titles(doc).join(), before);

    const ev2 = press(textarea, { shiftKey: true });
    plugin.onKeyDown(ev2);
    eq("and redoes them", textarea.value, "typed more");
    plugin.noteHistory = null;
  }

  /* The cases that must be left alone, each standing for something with an
     undo of its own. */
  for (const [what, selector] of [
    ["a note box with no history of its own", ".mpa-note-box"],
    ["a text editor", ".cm-editor"],
    ["a form field", "input"],
  ]) {
    const over = { closest: (sel) => (sel.includes(selector) ? {} : null) };
    const ev = press(over);
    const before = titles(doc).join();
    plugin.onKeyDown(ev);
    eq(`${what} keeps the key`, ev.claimed, 0);
    eq(`and its annotations are untouched`, titles(doc).join(), before);
  }

  /* No PDF in play: the key has to travel on, or it would go missing for
     everything else in Obsidian. */
  plugin.views.clear();
  plugin.recentView = null;
  e = press(inPdf);
  plugin.onKeyDown(e);
  eq("with no PDF open the key is passed on", e.claimed, 0);

  /* An annotations file that could not be read is shown but not edited. */
  plugin.views.set("v", { view: "v", container, doc });
  plugin.recentView = "v";
  doc.readOnly = true;
  e = press(inPdf);
  plugin.onKeyDown(e);
  eq("a read-only PDF passes it on too", e.claimed, 0);
  doc.readOnly = false;

  /* Claimed even with nothing left to undo, so the key never does something
     unexpected in a PDF. */
  doc.undoStack.length = 0;
  doc.redoStack.length = 0;
  e = press(inPdf);
  plugin.onKeyDown(e);
  eq("an empty history still claims the key", e.claimed > 0, true);

  global.document = undefined;
  global.Element = undefined;
}

console.log("  which PDF the commands act on");
{
  const { plugin, doc } = undoHarness();
  const shown = { contains: () => false, isShown: () => true };
  const hidden = { contains: () => false, isShown: () => false };

  global.document = { activeElement: null };
  eq("with nothing open there is nothing to act on", plugin.activeDoc(), null);

  plugin.views.set("v", { view: "v", container: shown, doc });
  plugin.recentView = "v";
  eq("the PDF last interacted with, while it is on screen", plugin.activeDoc(), doc);

  plugin.views.set("v", { view: "v", container: hidden, doc });
  eq("but not one hidden behind another tab", plugin.activeDoc(), null);

  const focused = {};
  global.document = { activeElement: focused };
  plugin.views.set("v", { view: "v", container: { contains: (el) => el === focused, isShown: () => false }, doc });
  eq("keyboard focus wins over everything", plugin.activeDoc(), doc);
  global.document = undefined;
}


console.log("\n--- where a note marker is drawn");

/* Enough of a DOM for drawHighlights. Placement has now been wrong twice, in
   opposite directions, so it is worth being able to check it without a PDF. */
function el(cls) {
  const node = {
    classes: new Set(String(cls || "").split(" ").filter(Boolean)),
    children: [],
    dataset: {},
    attrs: {},
    vars: {},
    removed: false,
    style: {
      setProperty(name, value) {
        node.vars[name] = value;
      },
    },
    addClass(c) {
      node.classes.add(c);
    },
    setAttribute(k, v) {
      node.attrs[k] = v;
    },
    createDiv(opts) {
      const child = el(opts && opts.cls);
      node.children.push(child);
      return child;
    },
    empty() {
      node.children.length = 0;
    },
    remove() {
      node.removed = true;
    },
    querySelector(selector) {
      const want = selector.replace(":scope > ", "").replace(".", "");
      return node.children.find((c) => c.classes.has(want)) || null;
    },
  };
  return node;
}

function pageOf(number) {
  const page = el("page");
  page.dataset.pageNumber = String(number);
  return page;
}

function drawn(data, pages) {
  const plugin = Object.create(PluginClass.prototype);
  plugin.settings = { highlightColor: "#ffeb3b" };
  const container = { querySelectorAll: () => pages };
  plugin.drawHighlights({ container, doc: { data } });
  return pages.map((page) => {
    const layer = page.children.find((c) => c.classes.has("mpa-layer"));
    if (!layer) return { highlights: [], icons: [] };
    return {
      highlights: layer.children.filter((c) => c.classes.has("mpa-highlight")),
      icons: layer.children.filter((c) => c.classes.has("mpa-note-icon")),
    };
  });
}

{
  /* A highlight whose note the reader added by clicking it. */
  const page = pageOf(1);
  const [out] = drawn(
    {
      highlights: [hl("quoted", [{ page: 1, x: 0.25, y: 0.5, w: 0.5, h: 0.25 }], { note: "a thought" })],
      notes: [],
    },
    [page]
  );
  eq("the highlight is drawn", out.highlights.length, 1);
  eq("at the place recorded for it", out.highlights[0].vars["--mpa-x"], "25%");
  eq("and its marker with it", out.icons.length, 1);
  eq("the marker takes no horizontal position from script", "--mpa-x" in out.icons[0].vars, false);
  eq("only a vertical one, the middle of the first line", out.icons[0].vars["--mpa-y"], "62.5%");
}

{
  /* The case that was reported: a note added by right-clicking highlighted
     text. Its marker used to be centred on the click, which put it on top of
     the words that were clicked. */
  const page = pageOf(1);
  const [out] = drawn(
    {
      highlights: [],
      notes: [{ id: "n1", page: 1, text: "a thought", position: { x: 0.5, y: 0.25 } }],
    },
    [page]
  );
  eq("the marker is drawn", out.icons.length, 1);
  eq("in the margin, not where the page was clicked", "--mpa-x" in out.icons[0].vars, false);
  eq("level with the point it was put at", out.icons[0].vars["--mpa-y"], "25%");
}

{
  /* Both kinds end up in one column, which is the whole point. */
  const page = pageOf(1);
  const [out] = drawn(
    {
      highlights: [hl("quoted", [{ page: 1, x: 0.25, y: 0.5, w: 0.5, h: 0 }], { note: "n" })],
      notes: [{ id: "n1", page: 1, text: "t", position: { x: 0.9, y: 0.25 } }],
    },
    [page]
  );
  eq("two markers", out.icons.length, 2);
  eq(
    "neither of them positioned horizontally",
    out.icons.every((i) => !("--mpa-x" in i.vars)),
    true
  );
}

{
  /* A highlight with no note has no marker. */
  const page = pageOf(1);
  const [out] = drawn(
    { highlights: [hl("quoted", [{ page: 1, x: 0.1, y: 0.1, w: 0.5, h: 0.02 }])], notes: [] },
    [page]
  );
  eq("no note, no marker", out.icons.length, 0);
}

{
  /* A highlight across a page break puts its marker on the page it starts on. */
  const first = pageOf(1);
  const second = pageOf(2);
  const out = drawn(
    {
      highlights: [
        hl("across", [{ page: 2, x: 0.1, y: 0.25, w: 0.5, h: 0 }, { page: 1, x: 0.1, y: 0.75, w: 0.5, h: 0 }], {
          note: "n",
        }),
      ],
      notes: [],
    },
    [first, second]
  );
  eq("a rectangle on each page", [out[0].highlights.length, out[1].highlights.length], [1, 1]);
  eq("one marker, on the page it starts on", [out[0].icons.length, out[1].icons.length], [1, 0]);
  eq("level with where it starts", out[0].icons[0].vars["--mpa-y"], "75%");
}

{
  /* A page with nothing on it loses its layer rather than keeping an empty
     one. */
  const page = pageOf(1);
  drawn({ highlights: [hl("q", [{ page: 1, x: 0, y: 0, w: 1, h: 1 }])], notes: [] }, [page]);
  const layer = page.children.find((c) => c.classes.has("mpa-layer"));
  const plugin = Object.create(PluginClass.prototype);
  plugin.settings = { highlightColor: "#ffeb3b" };
  plugin.drawHighlights({ container: { querySelectorAll: () => [page] }, doc: { data: { highlights: [], notes: [] } } });
  eq("the empty layer is taken away", layer.removed, true);
}


console.log("\n--- what the right-click menu offers");

/* Right-clicking highlighted text used to make a standalone note anchored at
   that point. In the transcript a standalone note is a bullet of its own, so
   it had nothing to sit under, which is how it was reported: "the note does
   not indent". A note asked for on top of a highlight is now that highlight's
   note. */
function menuFor(hit) {
  const plugin = Object.create(PluginClass.prototype);
  plugin.locate = () => hit;
  plugin.calls = [];
  plugin.openHighlightNote = (state, id) => plugin.calls.push(["highlight note", id]);
  plugin.openStandaloneNote = (state, id) => plugin.calls.push(["standalone note", id]);
  plugin.addStandaloneNote = () => plugin.calls.push(["new standalone note"]);
  plugin.commit = () => {};
  const event = { clientX: 10, clientY: 20, preventDefault() {} };
  plugin.onContextMenu(event);
  return { plugin, menu: MenuStub.last };
}
const icon = (kind, id) => ({ dataset: { noteKind: kind, noteId: id } });
const rectEl = (id) => ({ dataset: { highlightId: id } });
const docWith = (data) => ({ data, readOnly: false });
const page = {};

{
  const doc = docWith({ highlights: [hl("quoted", [r(1, 0.5)], { id: "h1" })], notes: [] });
  doc.data.highlights[0].id = "h1";
  const { plugin, menu } = menuFor({
    state: { doc },
    pageEl: page,
    highlightEl: rectEl("h1"),
    noteIconEl: null,
  });
  eq("on a highlight with no note, the offer is to add one", menu.items[0].title, "Add note");
  menu.items[0].click();
  eq("and it goes to that highlight", plugin.calls, [["highlight note", "h1"]]);
  eq("removing the highlight is offered too", menu.items.some((i) => i.title === "Remove highlight"), true);
  eq("but there is no note to remove yet", menu.items.some((i) => i.title === "Remove note"), false);
}

{
  const doc = docWith({ highlights: [hl("quoted", [r(1, 0.5)], { note: "a thought" })], notes: [] });
  doc.data.highlights[0].id = "h1";
  const { plugin, menu } = menuFor({
    state: { doc },
    pageEl: page,
    highlightEl: rectEl("h1"),
    noteIconEl: null,
  });
  eq("on a highlight that has one, the offer is to edit it", menu.items[0].title, "Edit note");
  menu.items[0].click();
  eq("still going to that highlight", plugin.calls, [["highlight note", "h1"]]);
  eq("and now it can be removed", menu.items.some((i) => i.title === "Remove note"), true);
}

{
  /* Right-clicking a highlight's own marker counts as right-clicking the
     highlight. */
  const doc = docWith({ highlights: [hl("quoted", [r(1, 0.5)], { note: "a thought" })], notes: [] });
  doc.data.highlights[0].id = "h1";
  const { plugin, menu } = menuFor({
    state: { doc },
    pageEl: page,
    highlightEl: null,
    noteIconEl: icon("highlight", "h1"),
  });
  eq("the marker leads back to its highlight", menu.items[0].title, "Edit note");
  menu.items[0].click();
  eq("and to its note", plugin.calls, [["highlight note", "h1"]]);
}

{
  const doc = docWith({
    highlights: [],
    notes: [{ id: "n1", page: 1, text: "a thought", position: { x: 0.5, y: 0.5 } }],
  });
  const { plugin, menu } = menuFor({
    state: { doc },
    pageEl: page,
    highlightEl: null,
    noteIconEl: icon("note", "n1"),
  });
  eq("a standalone marker offers to edit that note", menu.items[0].title, "Edit note");
  menu.items[0].click();
  eq("the standalone one", plugin.calls, [["standalone note", "n1"]]);
  eq("and to remove it", menu.items.some((i) => i.title === "Remove note"), true);
  eq("with no highlight to remove", menu.items.some((i) => i.title === "Remove highlight"), false);
}

{
  /* Bare page: a standalone note is still the right thing. */
  const doc = docWith({ highlights: [], notes: [] });
  const { plugin, menu } = menuFor({
    state: { doc },
    pageEl: page,
    highlightEl: null,
    noteIconEl: null,
  });
  eq("on bare page, a new standalone note", menu.items[0].title, "Add note");
  menu.items[0].click();
  eq("created at the point clicked", plugin.calls, [["new standalone note"]]);
  eq("and nothing to remove", menu.items.length, 1);
}

/* Tying it back to the complaint: a highlight's note is indented under it,
   where a standalone note is a bullet of its own. */
eq(
  "a note on a highlight indents under it",
  T.renderMarkdown({
    highlights: [hl("quoted", [r(1, 0)], { note: "a thought" })],
    notes: [],
  }),
  '- "quoted"\n\t- a thought\n'
);


console.log("\n--- remembering the zoom level");

console.log("  validZoom");
eq("a scale as a number", T.validZoom("1.5"), true);
eq("one of the viewer's own words", T.validZoom("page-width"), true);
eq("and the others", ["auto", "page-actual", "page-fit", "page-height"].every(T.validZoom), true);
eq("a word it does not know", T.validZoom("page-sideways"), false);
eq("an absurd scale", T.validZoom("500"), false);
eq("a scale of nothing", T.validZoom("0"), false);
eq("something that is not a number", T.validZoom("wide"), false);
eq("an empty string", T.validZoom(""), false);
eq("a number rather than a string, as the viewer wants", T.validZoom(1.5), false);
eq("nothing at all", T.validZoom(null), false);

console.log("  pdfViewerOf");
{
  const viewer = { currentScaleValue: "1.25", pagesCount: 10 };
  const view = { viewer: { child: { pdfViewer: { pdfViewer: viewer } } } };
  eq("the viewer is found through the chain", T.pdfViewerOf(view), viewer);
  /* Obsidian's PDF view is not part of the plugin API, so a shape we do not
     recognise has to mean "no zoom memory", never a crash. */
  eq("a missing viewer", T.pdfViewerOf({ viewer: {} }), null);
  eq("a missing child", T.pdfViewerOf({}), null);
  eq("nothing at all", T.pdfViewerOf(null), null);
  eq(
    "a chain that ends in the wrong kind of thing",
    T.pdfViewerOf({ viewer: { child: { pdfViewer: { pdfViewer: { currentScaleValue: 1.25 } } } } }),
    null
  );
}

console.log("  pruneZooms");
{
  const zooms = { a: "1", b: "2", c: "3" };
  eq("under the limit, nothing goes", Object.keys(T.pruneZooms(zooms, 5)), ["a", "b", "c"]);
  eq("over it, the oldest go first", Object.keys(T.pruneZooms(zooms, 2)), ["b", "c"]);
}

function zoomHarness(stored) {
  const plugin = Object.create(PluginClass.prototype);
  plugin.settings = { rememberZoom: true };
  plugin.saved = null;
  plugin.app = {
    loadLocalStorage: () => stored,
    saveLocalStorage: (key, value) => {
      plugin.saved = JSON.parse(JSON.stringify(value));
    },
  };
  plugin.zooms = plugin.readZooms();
  plugin.saveZooms = () => plugin.writeZooms();
  return plugin;
}

console.log("  reading what was stored");
{
  eq("good values are kept", zoomHarness({ "a.pdf": "1.5" }).zooms, { "a.pdf": "1.5" });
  eq("bad ones are dropped", zoomHarness({ "a.pdf": "1.5", "b.pdf": "nonsense" }).zooms, { "a.pdf": "1.5" });
  eq("nothing stored yet", zoomHarness(null).zooms, {});
  eq("something that is not a map", zoomHarness("junk").zooms, {});
}

console.log("  noting a change");
{
  const plugin = zoomHarness({});
  plugin.noteZoom("a.pdf", "1.5");
  eq("a zoom is remembered", plugin.zooms["a.pdf"], "1.5");
  eq("and written out", plugin.saved, { "a.pdf": "1.5" });

  plugin.saved = null;
  plugin.noteZoom("a.pdf", "1.5");
  eq("the same value again is not written again", plugin.saved, null);

  plugin.noteZoom("a.pdf", "invalid");
  eq("an invalid value is refused", plugin.zooms["a.pdf"], "1.5");

  plugin.settings.rememberZoom = false;
  plugin.noteZoom("a.pdf", "2");
  eq("and nothing is recorded when the setting is off", plugin.zooms["a.pdf"], "1.5");
}

{
  const plugin = zoomHarness({});
  for (let i = 0; i < 250; i++) plugin.noteZoom("p" + i + ".pdf", "1." + (i % 9));
  eq("the store does not grow without end", Object.keys(plugin.zooms).length, 200);
  eq("keeping the most recent", "p249.pdf" in plugin.zooms, true);
  eq("and letting the oldest go", "p0.pdf" in plugin.zooms, false);
}

console.log("  restoring and then following");
{
  const plugin = zoomHarness({ "a.pdf": "1.5" });
  const viewer = { currentScaleValue: "auto", pagesCount: 0 };
  const view = { viewer: { child: { pdfViewer: { pdfViewer: viewer } } } };
  const state = { view, doc: { file: { path: "a.pdf" } }, pendingZoom: plugin.zooms["a.pdf"] };

  plugin.syncZoom(state);
  eq("nothing happens before the pages exist", viewer.currentScaleValue, "auto");
  eq("and the restore is still pending", state.pendingZoom, "1.5");

  viewer.pagesCount = 12;
  plugin.syncZoom(state);
  eq("once they do, the zoom is restored", viewer.currentScaleValue, "1.5");
  eq("only once", state.pendingZoom, null);

  /* From then on it follows whatever the reader does. */
  viewer.currentScaleValue = "2";
  plugin.syncZoom(state);
  eq("a later change is recorded", plugin.zooms["a.pdf"], "2");
}

{
  /* A PDF never seen before is left at whatever the viewer chose. */
  const plugin = zoomHarness({});
  const viewer = { currentScaleValue: "page-width", pagesCount: 3 };
  const state = {
    view: { viewer: { child: { pdfViewer: { pdfViewer: viewer } } } },
    doc: { file: { path: "new.pdf" } },
    pendingZoom: null,
  };
  plugin.syncZoom(state);
  eq("the viewer's own choice stands", viewer.currentScaleValue, "page-width");
  eq("and is remembered for next time", plugin.zooms["new.pdf"], "page-width");
}

{
  /* An unrecognised view shape must be harmless. */
  const plugin = zoomHarness({});
  plugin.syncZoom({ view: {}, doc: { file: { path: "a.pdf" } }, pendingZoom: "1.5" });
  eq("no viewer, nothing recorded", plugin.zooms, {});
}


console.log("\n--- where a note box opens");

/* Both ways of asking for a note on a highlight go through one function and
   resolve the anchor themselves, when the box opens. Carrying the element from
   the click that asked for it was the bug: a context-menu item runs after the
   menu closes, a redraw may have replaced that element in the meantime, and a
   detached element measures as nothing, which put the box in the top-left
   corner of the window. */
console.log("  anchorFor");
{
  const laidOut = (left, top, width) => ({
    getBoundingClientRect: () => ({ left, top, bottom: top + 12, width, height: 12 }),
  });
  /* What a replaced element looks like: still referenced, no longer in the
     page, so every measurement is zero. */
  const detached = () => ({
    getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 0, width: 0, height: 0 }),
  });

  function plugin(elements, pointers, containerRect) {
    const p = Object.create(PluginClass.prototype);
    p.pointers = pointers || {};
    p.stateFor = {
      container: {
        querySelectorAll: () => elements,
        getBoundingClientRect: () => containerRect || { left: 500, top: 300 },
      },
    };
    return p;
  }

  {
    const p = plugin([laidOut(120, 400, 80)]);
    eq("the element's own box is used", p.anchorFor(p.stateFor, ".x").left, 120);
  }
  {
    const p = plugin([detached(), laidOut(120, 400, 80)]);
    const at = p.anchorFor(p.stateFor, ".x");
    eq("a replaced element is skipped", at.left, 120);
    eq("rather than measuring as the top-left corner", at.left === 0 && at.top === 0, false);
    eq("and does not drag the anchor up to the top of the window", at.top, 400);
  }
  {
    const p = plugin([detached()], { up: { x: 70, y: 90 } });
    const at = p.anchorFor(p.stateFor, ".x");
    eq("with nothing on screen, the pointer is used", [at.left, at.bottom], [70, 90]);
  }
  {
    const p = plugin([], {}, { left: 500, top: 300 });
    const at = p.anchorFor(p.stateFor, ".x");
    eq("and failing that, the top of the view", [at.left, at.top], [520, 320]);
  }
}

/* The two ways of asking for a note on a highlight must behave identically
   once the decision is made, including refusing in the same circumstances. */
console.log("  both ways of asking refuse together");
{
  function opener(readOnly) {
    const p = Object.create(PluginClass.prototype);
    const highlight = hl("quoted", [r(1, 0.5)], { note: "" });
    highlight.id = "h1";
    const doc = { data: { highlights: [highlight], notes: [] }, readOnly };
    p.opened = 0;
    p.pointers = {};
    p.openNoteBox = () => {
      p.opened++;
    };
    const state = {
      doc,
      container: {
        querySelectorAll: () => [
          { getBoundingClientRect: () => ({ left: 10, top: 20, bottom: 32, width: 50, height: 12 }) },
        ],
        getBoundingClientRect: () => ({ left: 0, top: 0 }),
      },
    };
    return { p, state };
  }

  const ok = opener(false);
  ok.p.openHighlightNote(ok.state, "h1");
  eq("an editable PDF opens the box", ok.p.opened, 1);

  const refused = opener(true);
  notices.length = 0;
  refused.p.openHighlightNote(refused.state, "h1");
  eq("one whose annotations could not be read does not", refused.p.opened, 0);
  eq("and says why", notices.length, 1);

  const gone = opener(false);
  gone.p.openHighlightNote(gone.state, "no-such-highlight");
  eq("a highlight that is gone opens nothing", gone.p.opened, 0);
}

console.log("  placeBox");
{
  const size = { width: 240, height: 90 };
  const screen = { width: 1200, height: 800 };
  const at = (left, top) => ({ left, top, bottom: top + 12 });

  eq(
    "normally, just below the anchor",
    T.placeBox(at(100, 400), size, screen),
    { left: 100, top: 418 }
  );
  eq(
    "near the right edge it is pulled back in",
    T.placeBox(at(1150, 400), size, screen).left,
    1200 - 240 - 8
  );
  eq(
    "near the left edge it keeps a margin",
    T.placeBox(at(-50, 400), size, screen).left,
    8
  );
  eq(
    "near the bottom it flips above the anchor",
    T.placeBox(at(100, 760), size, screen),
    { left: 100, top: 760 - 90 - 6 }
  );
  {
    /* A box too tall for the space either side of the anchor is pinned so its
       own bottom edge keeps the margin. */
    const tall = { width: 240, height: 780 };
    const placed = T.placeBox(at(100, 20), tall, screen);
    eq("a box too tall for either side is pinned inside the window", placed.top, 12);
    eq("with its bottom edge a margin clear", placed.top + tall.height, screen.height - 8);
  }
  eq("a fractional anchor is rounded", T.placeBox(at(100.6, 400.4), size, screen).left, 101);
}


console.log("\n--- the box clears what it belongs to");
{
  /* A highlight running over three lines. The box has to go below the last of
     them, not below the first, or it covers the words being annotated. */
  const line = (top) => ({
    getBoundingClientRect: () => ({ left: 120, top, bottom: top + 13, width: 400, height: 13 }),
  });
  const p = Object.create(PluginClass.prototype);
  p.pointers = {};
  const state = {
    container: {
      querySelectorAll: () => [line(400), line(413), line(426)],
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    },
  };
  const anchor = p.anchorFor(state, ".x");
  eq("the anchor covers every line of it", [anchor.top, anchor.bottom], [400, 439]);
  eq("and starts at the leftmost", anchor.left, 120);

  const placed = T.placeBox(anchor, { width: 240, height: 90 }, { width: 1200, height: 800 });
  eq("so the box sits below the last line", placed.top, 439 + 6);
  eq("aligned with the start of the text", placed.left, 120);
}
{
  /* Lines at differing indents, as a paragraph's first and last often are. */
  const at = (left, top, width) => ({
    getBoundingClientRect: () => ({ left, top, bottom: top + 13, width, height: 13 }),
  });
  const p = Object.create(PluginClass.prototype);
  p.pointers = {};
  const state = {
    container: {
      querySelectorAll: () => [at(300, 400, 220), at(120, 413, 400), at(120, 426, 90)],
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    },
  };
  const anchor = p.anchorFor(state, ".x");
  eq("the anchor reaches the leftmost line", anchor.left, 120);
  eq("and the lowest", anchor.bottom, 439);
}

console.log("\n--- clampToViewport");
{
  const size = { width: 240, height: 90 };
  const screen = { width: 1200, height: 800 };
  eq("inside already, nothing moves", T.clampToViewport(100, 300, size, screen), { left: 100, top: 300 });
  eq("too far right", T.clampToViewport(1190, 300, size, screen).left, 1200 - 240 - 8);
  eq("too far left", T.clampToViewport(-40, 300, size, screen).left, 8);
  eq("too far down", T.clampToViewport(100, 790, size, screen).top, 800 - 90 - 8);
  eq("too far up", T.clampToViewport(100, -40, size, screen).top, 8);
  eq("fractions are rounded", T.clampToViewport(100.6, 300.4, size, screen), { left: 101, top: 300 });
  eq(
    "a box bigger than the window is pinned rather than pushed off",
    T.clampToViewport(500, 500, { width: 2000, height: 2000 }, screen),
    { left: 8, top: 8 }
  );
}


console.log("\n--- dragging a note box");

/* A drag that did not end when the button was released, because the box stops
   mouse events from travelling further and so swallowed the release before the
   document heard it. The listeners now go on in the capture phase, and two
   rules here make the drag end even if a release is missed entirely. */
{
  const moves = [];
  const drag = new T.BoxDrag((left, top) => moves.push([left, top]));

  eq("nothing is dragging to begin with", drag.active, false);
  eq("a move before any drag does nothing", drag.move(50, 50, 1), false);
  eq("and moves nothing", moves.length, 0);

  drag.start(100, 200, 300, 400);
  eq("a drag is live once started", drag.active, true);

  eq("a move while held keeps it live", drag.move(110, 210, 1), true);
  eq("and shifts the box by the same amount", moves[0], [310, 410]);

  drag.move(90, 180, 1);
  eq("moving back the other way too", moves[1], [290, 380]);
  eq("always measured from where the drag began", moves.length, 2);

  eq("releasing ends it", drag.stop(), true);
  eq("so it is no longer live", drag.active, false);
  eq("stopping again reports there was nothing to stop", drag.stop(), false);

  eq("a move afterwards does nothing", drag.move(500, 500, 1), false);
  eq("and moves nothing", moves.length, 2);
}

{
  /* A button let go outside the window is never reported, so the next move
     with nothing held has to end the drag by itself. */
  const moves = [];
  const drag = new T.BoxDrag((left, top) => moves.push([left, top]));
  drag.start(100, 200, 300, 400);
  drag.move(110, 210, 1);
  eq("one move while held", moves.length, 1);

  eq("a move with no button held ends the drag", drag.move(120, 220, 0), false);
  eq("without moving the box again", moves.length, 1);
  eq("and it is no longer live", drag.active, false);
  eq("so later moves are ignored even with a button held", drag.move(130, 230, 1), false);
  eq("still one move", moves.length, 1);
}

{
  /* A second drag starts from wherever the box was left. */
  const moves = [];
  const drag = new T.BoxDrag((left, top) => moves.push([left, top]));
  drag.start(0, 0, 100, 100);
  drag.move(10, 10, 1);
  drag.stop();
  drag.start(50, 50, 110, 110);
  drag.move(60, 60, 1);
  eq("the second drag continues from the new position", moves[1], [120, 120]);
}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
