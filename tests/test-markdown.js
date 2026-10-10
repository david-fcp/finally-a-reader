/* Unit tests for Minimal PDF annotator's pure logic: page geometry, the
   character model behind a selection, the note made from the annotations,
   undo, the context menu, the sidebar's list and its search. Run with
   `node tests/test-markdown.js`; Obsidian is stubbed. */
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
    ItemView: class {},
    FileView: class {},
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
    "\nmodule.exports.__t={renderExport,escapeLineStart,collapseWhitespace,stamp,pct,pageNumberOf,uuid," +
    "firstRect,migrateHighlight,dropRunningHeads,unionRect,pagePaddingBox," +
    "measurable,cell,round,blank,charAt,describePoint,sameLine,boundaryPosition," +
    "indexOfBoundary,touchedBounds,refineBoundary,nearestPointer,isWordChar,insideWord," +
    "snapStart,snapEnd,selectedSlice,linesFromChars,textOfChars,snapshot,NoteHistory," +
    "annotationItems,compareOrder,findAnnotation,annotationTarget,flashing,flashElapsed,pdfInnerOf,AnnotationsView," +
    "searchWords,wordMatches,editDistance,matchesQuery,destPoint,footnoteRegion," +
    "resolveBookPath,drmProtected,snapOffset,findQuote,validTextSize,readZip," +
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
   over a full stop the stored text left out, or the text would carry one
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
  /* A pointer dragged past the full stop takes it, and the text and the
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

/* ------------------------------------------------- the note made on request */

console.log("\n--- renderExport");

const X = (data, settings) => T.renderExport(data, settings);
const quoteWithNote = { highlights: [hl("quote", [r(1, 0)], { note: "my thought" })], notes: [] };
const mixed = {
  highlights: [hl("first", [r(1, 0.1)], { note: "on first" }), hl("second", [r(1, 0.3)])],
  notes: [{ id: "n", page: 1, text: "loose", position: { y: 0.2 } }],
};

eq("nothing to say produces nothing", X({ highlights: [], notes: [] }), "");
eq("missing arrays are tolerated", X({}), "");
eq("by default, a highlight is a bullet in double quotation marks", X({ highlights: [hl("hello there", [r(1, 0.1)])], notes: [] }), '- "hello there"\n');
eq("a PDF's own line breaks inside a highlight are collapsed", X({ highlights: [hl("broken\nacross   lines", [r(1, 0)])], notes: [] }), '- "broken across lines"\n');
eq("its note is a bullet indented under it", X(quoteWithNote), '- "quote"\n\t- my thought\n');
eq("a note of several lines stays one bullet", X({ highlights: [hl("q", [r(1, 0)], { note: "one\ntwo" })], notes: [] }), '- "q"\n\t- one\n\t\ttwo\n');
eq("a whitespace-only note is left out", X({ highlights: [hl("q", [r(1, 0)], { note: "   " })], notes: [] }), '- "q"\n');
eq("a loose note is a bullet, in reading order", X(mixed), '- "first"\n\t- on first\n- loose\n- "second"\n');
eq("a loose note of several lines continues indented", X({ highlights: [], notes: [{ page: 1, text: "one\ntwo", position: { y: 0.5 } }] }), "- one\n\ttwo\n");
eq("an empty loose note is left out", X({ highlights: [], notes: [{ page: 1, text: " ", position: { y: 0.5 } }] }), "");
eq("a highlight spanning two pages is placed by where it starts",
  X({ highlights: [hl("later on page two", [r(2, 0.5)]), hl("across the break", [r(1, 0.9), r(2, 0.1)])], notes: [] }),
  '- "across the break"\n- "later on page two"\n');
eq("always in reading order, whatever the sidebar shows",
  X({ highlights: [hl("lower", [r(1, 0.8)], { createdAt: "1" }), hl("upper", [r(1, 0.2)], { createdAt: "2" })], notes: [] }, { sidebarSort: "date" }),
  '- "upper"\n- "lower"\n');
eq("quotation marks inside a highlight are left as they are", X({ highlights: [hl('he said "hi"', [r(1, 0)])], notes: [] }), '- "he said "hi""\n');

console.log("  quotation marks");
eq("single", X(quoteWithNote, { quoteMarks: "single" }), "- 'quote'\n\t- my thought\n");
eq("none", X(quoteWithNote, { quoteMarks: "none" }), "- quote\n\t- my thought\n");
eq("something unknown falls back to double", X(quoteWithNote, { quoteMarks: "odd" }), '- "quote"\n\t- my thought\n');

console.log("  highlights as lines or paragraphs");
const two = { highlights: [hl("one", [r(1, 0.1)]), hl("two", [r(1, 0.2)])], notes: [] };
eq("lines follow each other directly", X(two, { highlightLayout: "lines" }), '"one"\n"two"\n');
eq("paragraphs have a blank line between", X(two, { highlightLayout: "paragraphs" }), '"one"\n\n"two"\n');

console.log("  notes on highlights");
eq("on a new line", X(quoteWithNote, { noteLayout: "line" }), '- "quote"\n\tmy thought\n');
eq("on a new line, under a line", X(quoteWithNote, { noteLayout: "line", highlightLayout: "lines" }), '"quote"\nmy thought\n');
eq("in a new paragraph", X(quoteWithNote, { noteLayout: "paragraph", highlightLayout: "paragraphs" }), '"quote"\n\nmy thought\n');
eq("in a new paragraph after a bullet, a blank line apart", X(quoteWithNote, { noteLayout: "paragraph" }), '- "quote"\n\nmy thought\n');
eq("on the same line, after a space", X(quoteWithNote, { noteLayout: "same-line" }), '- "quote" my thought\n');
eq("an indented bullet under a line has nothing to indent under, so is a plain bullet",
  X(quoteWithNote, { highlightLayout: "lines" }), '"quote"\n\n- my thought\n');
eq("and the next line after that bullet is set apart from it",
  X({ highlights: [hl("a", [r(1, 0.1)], { note: "n" }), hl("b", [r(1, 0.2)])], notes: [] }, { highlightLayout: "lines" }),
  '"a"\n\n- n\n\n"b"\n');

console.log("  loose notes");
eq("as lines between bullets, set apart", X(mixed, { looseNoteLayout: "lines" }), '- "first"\n\t- on first\n\nloose\n\n- "second"\n');
eq("as paragraphs", X(mixed, { looseNoteLayout: "paragraphs", highlightLayout: "paragraphs", noteLayout: "paragraph" }),
  '"first"\n\non first\n\nloose\n\n"second"\n');

console.log("  text that looks like markdown");
eq("a bare highlight starting with # is not a heading", X({ highlights: [hl("# 1 Introduction", [r(1, 0)])], notes: [] }, { quoteMarks: "none", highlightLayout: "lines" }), "\\# 1 Introduction\n");
eq("nor a numbered one a list, and keeps its number", X({ highlights: [hl("1. First", [r(1, 0)])], notes: [] }, { quoteMarks: "none" }), "- 1\\. First\n");
eq("every line of a note is looked at, not just the first",
  X({ highlights: [hl("q", [r(1, 0)], { note: "line one\n- item\n# head\n2. x" })], notes: [] }),
  '- "q"\n\t- line one\n\t\t\\- item\n\t\t\\# head\n\t\t2\\. x\n');
eq("a loose note is escaped even with quotation marks on",
  X({ highlights: [hl("q", [r(1, 0)])], notes: [{ page: 1, text: "1. loose", position: { y: 0.5 } }] }, { looseNoteLayout: "lines" }),
  '- "q"\n\n1\\. loose\n');
eq("as is a note set in a paragraph of its own", X({ highlights: [hl("q", [r(1, 0)], { note: "# x" })], notes: [] }, { noteLayout: "paragraph" }), '- "q"\n\n\\# x\n');
eq("a note starting with > is not a quote", X({ highlights: [], notes: [{ page: 1, text: "> aside", position: { y: 0 } }] }), "- \\> aside\n");
eq("ordinary text is left alone", T.escapeLineStart("#hashtag and 1984"), "#hashtag and 1984");

/* ------------------------------------------------------------- the stamp */

console.log("\n--- stamp");

eq("the same text stamps the same", T.stamp("hello") === T.stamp("hello"), true);
eq("different text stamps differently", T.stamp("hello") === T.stamp("hellp"), false);
eq("a reordering is caught", T.stamp("ab") === T.stamp("ba"), false);
eq("the empty string has a stamp", typeof T.stamp(""), "string");
eq("length is part of it", T.stamp("a").split("-")[1], "1");

/* ------------------------------------------------ making the note itself */

console.log("\n--- exportNote");

/* A vault just big enough: files are TFile instances, so the instanceof
   checks in the plugin behave as they do in Obsidian. */
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
    /* The disk ignores case, as on most Macs. */
    adapter: { exists: async (p) => [...contents.keys()].some((k) => k.toLowerCase() === p.toLowerCase()) },
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
      return f;
    },
    read_(p) {
      return contents.get(p);
    },
  };
}

function harness(files, data) {
  const plugin = Object.create(PluginClass.prototype);
  const vault = fakeVault(files);
  const opened = [];
  plugin.app = {
    vault,
    workspace: {
      getLeaf: (kind) => ({ kind, async openFile(f) { opened.push([kind, f.path]); } }),
      setActiveLeaf: (leaf, opts) => opened.push(["focus", !!(opts && opts.focus)]),
    },
  };
  plugin.settings = Object.assign({}, { highlightColor: "#ffeb3b", snapToWords: true });
  const pdf = new TFile();
  pdf.path = "refs/paper.pdf";
  const doc = { file: pdf, data: Object.assign({ highlights: [], notes: [] }, data), readOnly: false, saveChain: Promise.resolve() };
  return { plugin, vault, doc, opened };
}

const ONE = { highlights: [hl("quote one", [r(1, 0)])], notes: [] };
const ONE_MD = '- "quote one"\n';

(async () => {
  {
    const { plugin, vault, doc, opened } = harness({}, ONE);
    notices.length = 0;
    await plugin.exportNote(doc);
    eq("a note named after the PDF is made beside it", vault.log, [["create", "refs/paper.md"]]);
    eq("holding the annotations", vault.read_("refs/paper.md"), ONE_MD);
    eq("opened in a new tab, with the cursor in it", opened, [["tab", "refs/paper.md"], ["focus", true]]);
    eq("and announced by its path", notices, ["Created refs/paper.md"]);
  }
  {
    const mine = "# Paper\n\nMy own notes on this paper.\n";
    const { plugin, vault, doc } = harness({ "refs/paper.md": mine, "refs/paper 1.md": "also mine" }, ONE);
    await plugin.exportNote(doc);
    eq("a name already taken is never written over", vault.log, [["create", "refs/paper 2.md"]]);
    eq("what was there survives", [vault.read_("refs/paper.md"), vault.read_("refs/paper 1.md")], [mine, "also mine"]);
  }
  {
    const { plugin, vault, doc } = harness({ "refs/Paper.md": "mine" }, ONE);
    await plugin.exportNote(doc);
    eq("a name taken in another case counts as taken", vault.log, [["create", "refs/paper 1.md"]]);
  }
  {
    const { plugin, vault, doc } = harness({}, { highlights: [], notes: [] });
    notices.length = 0;
    await plugin.exportNote(doc);
    eq("nothing to put in it makes no note", vault.log, []);
    eq("and says so", notices.length, 1);
  }
  {
    const { plugin, vault, doc } = harness({}, ONE);
    plugin.settings.quoteMarks = "single";
    await plugin.exportNote(doc);
    eq("the layout settings are followed", vault.read_("refs/paper.md"), "- 'quote one'\n");
  }
  {
    /* Saving annotations no longer writes any markdown. */
    const { plugin, vault, doc } = harness({}, ONE);
    plugin.getSidecarPath = () => "refs/paper.annotations.json";
    await plugin.save(doc);
    eq("saving writes only the annotations file", vault.log, [["create", "refs/paper.annotations.json"]]);
    eq("which holds only the annotations", Object.keys(JSON.parse(vault.read_("refs/paper.annotations.json"))), ["highlights", "notes"]);
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
   discarded as soon as something new happens. */
console.log("\n--- undo and redo");

function undoHarness() {
  const plugin = Object.create(PluginClass.prototype);
  plugin.views = new Map();
  plugin.noteFields = new WeakMap();
  plugin.app = { workspace: { getLeavesOfType: () => [] } };
  plugin.saved = 0;
  plugin.queueSave = () => {
    plugin.saved++;
  };
  plugin.notify = () => {
    plugin.notified = (plugin.notified || 0) + 1;
  };
  /* Drawing needs a real page in a real viewer; counted, not performed. */
  plugin.render = () => {
    plugin.renders = (plugin.renders || 0) + 1;
  };
  const pdf = new TFile();
  pdf.path = "refs/paper.pdf";
  const doc = {
    file: pdf,
    data: { highlights: [], notes: [] },
    readOnly: false,
    saveChain: Promise.resolve(),
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
  const data = { highlights: [hl("one", [r(1, 0)])], notes: [], extra: "not an annotation" };
  const copy = T.snapshot(data);
  data.highlights[0].text = "changed";
  eq("a snapshot is a copy, not a reference", copy.highlights[0].text, "one");
  eq("only the annotations are copied", Object.keys(copy), ["highlights", "notes"]);
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
  plugin.undo(doc);
  eq("undoing saves the result", plugin.saved > 0, true);
  eq("and the sidebar is told", plugin.notified > 0, true);
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

  /* A sidebar note box being typed in takes the key for its own text,
     through its own history, and tells the annotation what it now says. */
  {
    const textarea = { closest: (sel) => (sel.includes("textarea") ? {} : null), value: "typed", selectionEnd: 5, setSelectionRange() {} };
    const history = new T.NoteHistory(textarea);
    history.record(10000);
    textarea.value = "typed more";
    history.record(20000);
    let synced = 0;
    plugin.noteFields.set(textarea, { history, sync: () => synced++ });

    const before = titles(doc).join();
    const ev = press(textarea);
    plugin.onKeyDown(ev);
    eq("the note box claims the key", ev.claimed > 0, true);
    eq("and undoes its own words", textarea.value, "typed");
    eq("and passes them on to the annotation", synced, 1);
    eq("leaving the other annotations alone", titles(doc).join(), before);

    const ev2 = press(textarea, { shiftKey: true });
    plugin.onKeyDown(ev2);
    eq("and redoes them", textarea.value, "typed more");
    eq("passing that on too", synced, 2);
    plugin.noteFields.delete(textarea);
  }

  /* The cases that must be left alone, each standing for something with an
     undo of its own. */
  for (const [what, selector] of [
    ["a text box with no history of its own", "textarea"],
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
   that point. In the exported note a standalone note is a bullet of its own, so
   it had nothing to sit under, which is how it was reported: "the note does
   not indent". A note asked for on top of a highlight is now that highlight's
   note. */
function menuFor(hit) {
  const plugin = Object.create(PluginClass.prototype);
  plugin.locate = () => hit;
  plugin.calls = [];
  plugin.revealAnnotation = (doc, id, focusNote) => {
    plugin.calls.push(["sidebar", id, focusNote]);
    return Promise.resolve();
  };
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
  eq("and it goes to that highlight", plugin.calls, [["sidebar", "h1", true]]);
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
  eq("still going to that highlight", plugin.calls, [["sidebar", "h1", true]]);
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
  eq("and to its note", plugin.calls, [["sidebar", "h1", true]]);
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
  eq("the standalone one", plugin.calls, [["sidebar", "n1", true]]);
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
  T.renderExport({
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


console.log("\n--- placeBox");
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



  console.log("\n--- the sidebar's list");
  {
    const data = {
      highlights: [
        hl("later", [r(2, 0.1)], { createdAt: "2026-10-10T10:00:00Z" }),
        hl("first", [r(1, 0.5)], { createdAt: "2026-10-10T12:00:00Z" }),
      ],
      notes: [{ id: "n1", page: 1, text: "thought", position: { x: 0.5, y: 0.2 }, createdAt: "2026-10-10T11:00:00Z" }],
    };
    eq("in reading order: page, then down the page", T.annotationItems(data, "position").map((i) => i.id), ["n1", "first", "later"]);
    eq("or in the order they were made, oldest first", T.annotationItems(data, "date").map((i) => i.id), ["later", "n1", "first"]);
    eq("each knows its kind", T.annotationItems(data, "position").map((i) => i.kind), ["note", "highlight", "highlight"]);
    eq("an unknown order falls back to reading order", T.annotationItems(data, "nonsense").map((i) => i.id), ["n1", "first", "later"]);
    eq("an empty document lists nothing", T.annotationItems({}, "position"), []);
    eq("and so does no document", T.annotationItems(null, "position"), []);

    const tied = {
      highlights: [hl("lower", [r(1, 0.9)], { createdAt: "same" }), hl("upper", [r(1, 0.1)], { createdAt: "same" })],
      notes: [],
    };
    eq("made at the same moment, reading order decides", T.annotationItems(tied, "date").map((i) => i.id), ["upper", "lower"]);

    const sameLine = { highlights: [hl("right", [r(1, 0.5, 0.6)]), hl("left", [r(1, 0.5, 0.1)])], notes: [] };
    eq("on the same line, left before right", T.annotationItems(sameLine, "position").map((i) => i.id), ["left", "right"]);
  }

  console.log("\n--- compareOrder");
  eq("earlier first", T.compareOrder([1, 2], [1, 3]) < 0, true);
  eq("later after", T.compareOrder([2, 0], [1, 9]) > 0, true);
  eq("equal is equal", T.compareOrder([1, 2, 3], [1, 2, 3]), 0);
  eq("a missing part counts as nothing", T.compareOrder([1, 2], [1, 2, 0]), 0);

  console.log("\n--- findAnnotation and annotationTarget");
  {
    const data = {
      highlights: [hl("quoted", [r(3, 0.7), r(3, 0.4)])],
      notes: [{ id: "n1", page: 5, text: "x", position: { x: 0.2, y: 0.3 } }],
    };
    eq("a highlight is found", T.findAnnotation(data, "quoted").kind, "highlight");
    eq("so is a note", T.findAnnotation(data, "n1").kind, "note");
    eq("something that is not there is not", T.findAnnotation(data, "gone"), null);
    eq("a highlight is gone to at its first line", T.annotationTarget(data, "quoted"), { page: 3, y: 0.4 });
    eq("a note at the point it was put", T.annotationTarget(data, "n1"), { page: 5, y: 0.3 });
    eq("nothing to go to for something missing", T.annotationTarget(data, "gone"), null);
    eq("nor for a highlight with no rectangles", T.annotationTarget({ highlights: [hl("bare", [])], notes: [] }, "bare"), null);
  }

  console.log("\n--- flashing");
  {
    const later = Date.now() + 10000;
    eq("the annotation being pointed out", T.flashing({ flash: { id: "a", until: later } }, "a"), true);
    eq("not another one", T.flashing({ flash: { id: "a", until: later } }, "b"), false);
    eq("not once the moment has passed", T.flashing({ flash: { id: "a", until: Date.now() - 1 } }, "a"), false);
    eq("nothing when nothing is", T.flashing({}, "a"), false);
  }

  console.log("\n--- editing from the sidebar");
  {
    /* A note typed in the sidebar reaches the annotation as it is typed, is
       saved shortly after, and becomes one undo step when the box is left. */
    const { plugin, doc } = undoHarness();
    plugin.saveSoon = () => {
      plugin.savesQueued = (plugin.savesQueued || 0) + 1;
    };
    plugin.scheduleRedraw = () => {};
    doc.data.highlights.push(hl("quoted", [r(1, 0.5)]));
    plugin.commit(doc, "adding a highlight");
    const depth = doc.undoStack.length;

    plugin.setNote(doc, "quoted", "a");
    plugin.setNote(doc, "quoted", "a thought");
    eq("typing reaches the annotation at once", doc.data.highlights[0].note, "a thought");
    eq("and is saved", plugin.savesQueued, 2);
    eq("but is not yet an undo step", doc.undoStack.length, depth);
    plugin.endNoteEdit(doc);
    eq("leaving the box files one step for the whole edit", doc.undoStack.length, depth + 1);
    eq("labelled as such", doc.undoStack[doc.undoStack.length - 1].label, "editing a note");
    plugin.undo(doc);
    eq("which undoes all the typing at once", doc.data.highlights[0].note, "");
    plugin.redo(doc);
    eq("and redoes it at once", doc.data.highlights[0].note, "a thought");
  }
  {
    const { plugin, doc } = undoHarness();
    plugin.saveSoon = () => {};
    plugin.scheduleRedraw = () => {};
    doc.data.highlights.push(hl("quoted", [r(1, 0.5)]));
    plugin.commit(doc, "adding a highlight");
    const depth = doc.undoStack.length;
    plugin.setNote(doc, "quoted", "x");
    plugin.setNote(doc, "quoted", "");
    plugin.endNoteEdit(doc);
    eq("typed and rubbed out again, there is nothing to undo", doc.undoStack.length, depth);
    plugin.endNoteEdit(doc);
    eq("and leaving twice does not file anything either", doc.undoStack.length, depth);
  }
  {
    const { plugin, doc } = undoHarness();
    plugin.saveSoon = () => {};
    plugin.scheduleRedraw = () => {};
    doc.data.notes.push({ id: "n1", page: 1, text: "", position: { x: 0.5, y: 0.5 } });
    plugin.setNote(doc, "n1", "a note of its own");
    eq("a note of its own takes its words in its text", doc.data.notes[0].text, "a note of its own");
    plugin.setNote(doc, "missing", "nothing");
    eq("a note for something that is gone changes nothing", doc.data.notes.length, 1);
    doc.readOnly = true;
    plugin.setNote(doc, "n1", "changed");
    eq("a read-only document is not written to", doc.data.notes[0].text, "a note of its own");
  }

  console.log("\n--- deleting from the sidebar");
  {
    const { plugin, doc } = undoHarness();
    doc.data.highlights.push(hl("quoted", [r(1, 0.5)], { note: "kept with it" }));
    doc.data.notes.push({ id: "n1", page: 1, text: "mine", position: { x: 0.5, y: 0.5 } });
    plugin.commit(doc, "adding");
    plugin.deleteAnnotation(doc, "quoted");
    eq("a highlight is deleted with its note", doc.data.highlights.length, 0);
    eq("as one undo step", doc.undoStack[doc.undoStack.length - 1].label, "removing a highlight");
    plugin.deleteAnnotation(doc, "n1");
    eq("so is a note of its own", doc.data.notes.length, 0);
    plugin.undo(doc);
    plugin.undo(doc);
    eq("and both come back", [doc.data.highlights.length, doc.data.notes.length], [1, 1]);
    eq("note and all", doc.data.highlights[0].note, "kept with it");
    const depth = doc.undoStack.length;
    plugin.deleteAnnotation(doc, "gone");
    eq("deleting something that is not there does nothing", doc.undoStack.length, depth);
    notices.length = 0;
    doc.readOnly = true;
    plugin.deleteAnnotation(doc, "quoted");
    eq("a read-only document refuses", doc.data.highlights.length, 1);
    eq("and says why", notices.length, 1);
  }

  console.log("\n--- found in review");
  {
    /* A note being typed when the sidebar switches to another document is
       filed against the document it was typed in, not the one switched to. */
    const view = Object.create(T.AnnotationsView.prototype);
    const filed = [];
    view.plugin = { endNoteEdit: (doc) => filed.push(doc.name) };
    view.listEl = { empty() {} };
    view.cards = new Map();
    view.refresh = () => {};
    const a = { name: "A", editing: true };
    const b = { name: "B", editing: false };
    view.doc = a;
    view.setDoc(b);
    eq("the edit is filed against the document left", filed, ["A"]);
    eq("and the sidebar moves on", view.doc, b);
    filed.length = 0;
    view.setDoc(b);
    eq("refreshing the same document files nothing", filed, []);
    view.doc = { name: "C", editing: false };
    view.setDoc(a);
    eq("nothing is filed when nothing was being typed", filed, []);
  }
  {
    /* Two requests for the sidebar arriving together make one sidebar. */
    const leaves = [];
    const workspace = {
      getLeavesOfType: () => leaves.slice(),
      getRightLeaf: () => {
        const leaf = { view: null, async setViewState() { await new Promise((r) => setTimeout(r, 20)); this.view = Object.create(T.AnnotationsView.prototype); } };
        leaves.push(leaf);
        return leaf;
      },
      revealLeaf: async () => {},
    };
    const plugin = Object.create(PluginClass.prototype);
    plugin.app = { workspace };
    const [one, two] = await Promise.all([plugin.ensureSidebar(true), plugin.ensureSidebar(false)]);
    eq("only one sidebar is made", leaves.length, 1);
    eq("and both requests get it", one === two && !!one, true);
  }
  {
    /* A redrawn highlight carries on its flash from where it was. */
    const start = Date.now() - 400;
    const state = { flash: { id: "a", since: start, until: start + 1200 } };
    const elapsed = T.flashElapsed(state, "a");
    eq("partway through, it knows how far", elapsed >= 400 && elapsed < 1000, true);
    eq("another annotation is not flashing", T.flashElapsed(state, "b"), null);
    eq("nor is anything once it is over", T.flashElapsed({ flash: { id: "a", since: 0, until: 1 } }, "a"), null);
  }

  console.log("\n--- searching annotations");
  {
    const q = (text, query) => T.matchesQuery(text, query);
    eq("nothing typed matches everything", q("anything", "  "), true);
    eq("a word in the quote", q("The loneliness of the long-distance runner", "loneliness"), true);
    eq("case and accents are ignored", q("Café society", "CAFE"), true);
    eq("part of a word", q("communitarian", "commun"), true);
    eq("every word typed must be found", q("long-distance runner", "runner long"), true);
    eq("not just some of them", q("long-distance runner", "runner swimmer"), false);
    eq("a letter missed", q("loneliness", "lonliness"), true);
    eq("two letters swapped", q("manifesto", "mainfesto"), true);
    eq("a word typed partway, with a slip", q("localism", "lcoal"), true);
    eq("short words must be exact", q("the cat sat", "cot"), false);
    eq("too many slips is no match", q("loneliness", "lxnxlxness"), false);
    eq("letters scattered across a passage are no match", q("a big long sentence about nothing in particular", "bloat"), false);
    eq("the note is searched too", q("quoted words\nmy own thought", "thought"), true);
    eq("punctuation does not get in the way", q("“Hello,” she said.", "hello said"), true);
    eq("numbers count as words", q("in 1984 they", "1984"), true);
    eq("an edit distance gives up past its limit", T.editDistance("abcdef", "uvwxyz", 2), 3);
    eq("and counts exactly within it", T.editDistance("kitten", "sitten", 2), 1);
  }

  console.log("\n--- changing the sidebar's order");
  {
    let refreshed = 0, buttons = 0, saved = null;
    const plugin = Object.create(PluginClass.prototype);
    plugin.settings = { sidebarSort: "position" };
    plugin.saveData = async (d) => { saved = d.sidebarSort; };
    plugin.sidebars = () => [{ refresh: () => refreshed++, updateSortButton: () => buttons++ }];
    {
      await plugin.setSidebarSort("date");
      eq("the order is changed", plugin.settings.sidebarSort, "date");
      eq("and kept for next time", saved, "date");
      eq("and the sidebar redrawn", [refreshed, buttons], [1, 1]);
      await plugin.setSidebarSort("nonsense");
      eq("anything unknown means reading order", plugin.settings.sidebarSort, "position");
    }
  }

  console.log("\n--- footnote previews");
  {
    eq("XYZ gives a point", T.destPoint([{ num: 1 }, { name: "XYZ" }, 72, 112, null]), { x: 72, y: 112 });
    eq("a missing coordinate is left open", T.destPoint([{ num: 1 }, { name: "XYZ" }, null, 500, 0]), { x: null, y: 500 });
    eq("FitH gives only a height", T.destPoint([0, { name: "FitH" }, 300]), { x: null, y: 300 });
    eq("FitR gives its top-left corner", T.destPoint([0, { name: "FitR" }, 10, 20, 30, 40]), { x: 10, y: 40 });
    eq("Fit means the top of the page", T.destPoint([0, { name: "Fit" }]), { x: null, y: null });
    eq("nonsense is the top of the page too", T.destPoint(null), { x: null, y: null });

    const item = (str, x, y, width = 200, height = 9) => ({ str, transform: [height, 0, 0, height, x, y], width, height });
    const view = [0, 0, 612, 792];
    const page = [
      item("Body text across the column", 72, 600, 468, 12),
      item("1 The footnote text.", 72, 100),
      item("Lower down.", 72, 88),
    ];
    const atTop = T.footnoteRegion(page, view, { x: 72, y: 112 });
    eq("pointed at the top of the line: the line is shown whole", atTop.top, 111);
    eq("across the text column, with a little room", [atTop.left, atTop.right], [68, 544]);
    eq("down to the last line in reach, keeping its descenders", atTop.bottom, 84);
    eq("and its words are read out", atTop.text, "1 The footnote text. Lower down.");
    const atBaseline = T.footnoteRegion(page, view, { x: 72, y: 100 });
    eq("pointed at the baseline: the same line, not the one below", atBaseline.top, 111);
    const nowhere = T.footnoteRegion(page, view, { x: null, y: null });
    eq("no point: the top of the page", nowhere.top, 792);
    eq("and only as far as the preview reaches", nowhere.bottom, 792 - 110);
    eq("which here holds no words", nowhere.text, "");
    const narrow = T.footnoteRegion([item("2. A note.", 72, 690, 150)], view, { x: 72, y: 704 }, 300);
    eq("a narrow column is widened, not magnified", narrow.right - narrow.left, 300);
    eq("from where the text starts", narrow.left, 68);
    const blank = T.footnoteRegion([], view, { x: null, y: 400 });
    eq("a page with no text is shown across its width", [blank.left, blank.right], [0, 612]);
    eq("down the full depth", blank.top - blank.bottom, 110);
    const below = T.footnoteRegion([], view, { x: null, y: -50 });
    eq("a point below the page is kept on it", below.top > below.bottom && below.bottom === 0, true);
  }

  console.log("\n--- EPUB");
  {
    eq("a path beside the file", T.resolveBookPath("OEBPS/text/one.xhtml", "two.xhtml"), "OEBPS/text/two.xhtml");
    eq("a path up a folder", T.resolveBookPath("OEBPS/text/one.xhtml", "../css/book.css"), "OEBPS/css/book.css");
    eq("a fragment is not part of the path", T.resolveBookPath("OEBPS/text/one.xhtml", "notes.xhtml#en2"), "OEBPS/text/notes.xhtml");
    eq("a fragment alone is the same file", T.resolveBookPath("OEBPS/text/one.xhtml", "#fn1"), "OEBPS/text/one.xhtml");
    eq("encoded names are decoded", T.resolveBookPath("OEBPS/a.xhtml", "images/my%20picture.png"), "OEBPS/images/my picture.png");
    eq("a path from the root", T.resolveBookPath("OEBPS/text/one.xhtml", "/OEBPS/x.css"), "OEBPS/x.css");

    eq("font obfuscation is not DRM", T.drmProtected([{ algorithm: "http://www.idpf.org/2008/embedding" }, { algorithm: "http://ns.adobe.com/pdf/enc#RC" }]), false);
    eq("encrypted text is", T.drmProtected([{ algorithm: "http://www.w3.org/2001/04/xmlenc#aes128-cbc" }]), true);
    eq("nothing encrypted is not", T.drmProtected([]), false);

    const text = "The opening claim needs a source.";
    eq("a start inside a word moves to its beginning", T.snapOffset(text, 20, "start", true), 18);
    eq("an end inside a word moves to its end", T.snapOffset(text, 30, "end", true), 32);
    eq("spaces at the start are skipped", T.snapOffset(text, 17, "start", true), 18);
    eq("spaces at the end are dropped", T.snapOffset(text, 24, "end", true), 23);
    eq("without snapping, a start stays inside its word", T.snapOffset(text, 20, "start", false), 20);
    eq("but still leaves spaces out", T.snapOffset(text, 17, "start", false), 18);
    eq("an offset past the end is kept to the text", T.snapOffset(text, 999, "end", true), text.length);

    eq("moved words are found", T.findQuote("aaa needs a source bbb", "needs a source", 0), { start: 4, end: 18 });
    eq("whatever the spacing", T.findQuote("needs  a\nsource", "needs a source", 0), { start: 0, end: 15 });
    eq("the occurrence nearest where they were", T.findQuote("x y x y x", "x", 5).start, 4);
    eq("words that are gone are not found", T.findQuote("something else", "needs a source", 0), null);
    eq("nor are no words", T.findQuote("text", "  ", 0), null);
    eq("characters special to a pattern are taken as written", T.findQuote("cost (1+2)? yes", "(1+2)?", 0), { start: 5, end: 11 });

    eq("a text size from the list is valid", T.validTextSize(120), true);
    eq("one not on it is not", [T.validTextSize(123), T.validTextSize("120"), T.validTextSize(null)], [false, false, false]);

    const data = {
      highlights: [
        hl("later chapter", [], { epub: { start: [2, 10], end: [2, 20] } }),
        hl("first chapter, later", [], { epub: { start: [0, 500], end: [0, 520] } }),
      ],
      notes: [{ id: "n", text: "mine", epub: { at: [0, 100] } }],
    };
    eq("book annotations are in reading order: chapter, then place in it", T.annotationItems(data, "position").map((i) => i.id), ["n", "first chapter, later", "later chapter"]);

    const plugin = Object.create(PluginClass.prototype);
    const file = (p) => Object.assign(new TFile(), { path: p });
    eq("a PDF's annotations file", plugin.getSidecarPath(file("refs/paper.pdf")), "refs/paper.annotations.json");
    eq("a book's keeps its extension, so the two never share one", plugin.getSidecarPath(file("refs/paper.epub")), "refs/paper.epub.annotations.json");
  }

  console.log("\n--- reading a zip");
  {
    const zlib = require("zlib");
    const entry = (name, text, store) => {
      const data = Buffer.from(text);
      const packed = store ? data : zlib.deflateRawSync(data);
      return { name: Buffer.from(name), data, packed, method: store ? 0 : 8, crc: zlib.crc32(data) };
    };
    const entries = [entry("mimetype", "application/epub+zip", true), entry("OEBPS/text/one.xhtml", "<p>" + "hello ".repeat(200) + "</p>")];
    const parts = [];
    const dir = [];
    let offset = 0;
    for (const e of entries) {
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(e.method, 8);
      local.writeUInt32LE(e.crc, 14);
      local.writeUInt32LE(e.packed.length, 18);
      local.writeUInt32LE(e.data.length, 22);
      local.writeUInt16LE(e.name.length, 26);
      parts.push(local, e.name, e.packed);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.packed.length, 20);
      c.writeUInt32LE(e.data.length, 24);
      c.writeUInt16LE(e.name.length, 28);
      c.writeUInt32LE(offset, 42);
      dir.push(c, e.name);
      offset += 30 + e.name.length + e.packed.length;
    }
    const d = Buffer.concat(dir);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(d.length, 12);
    end.writeUInt32LE(offset, 16);
    const whole = Buffer.concat([...parts, d, end]);
    const zip = T.readZip(whole.buffer.slice(whole.byteOffset, whole.byteOffset + whole.length));
    eq("its files are listed", zip.names(), ["mimetype", "OEBPS/text/one.xhtml"]);
    eq("a stored file is read", await zip.text("mimetype"), "application/epub+zip");
    eq("a compressed one is unpacked", (await zip.text("OEBPS/text/one.xhtml")).length, 7 + 6 * 200);
    eq("a missing one is nothing", await zip.text("nope"), null);
    let threw = false;
    try {
      T.readZip(new ArrayBuffer(10));
    } catch (e) {
      threw = true;
    }
    eq("something that is not a zip is refused", threw, true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
