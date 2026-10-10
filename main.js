'use strict';

/*
 * Minimal PDF annotator.
 *
 * Select text in a PDF with highlight mode on and it is highlighted. The
 * annotations sidebar lists every highlight and note on the document in front
 * of you, after Zotero's: click a card's words to go to them, type in its
 * "Add note" box to annotate them, and click a highlight in the document to
 * land in its box. Right-click a bare part of a page for a note of its own.
 *
 * The annotations are kept in <name>.annotations.json beside the PDF, the one
 * source of truth for both the document and the sidebar. A button in the
 * sidebar makes a markdown note of them on request; nothing is written to
 * markdown otherwise.
 */

const {
  Plugin,
  PluginSettingTab,
  Setting,
  Menu,
  Notice,
  TFile,
  Platform,
  MarkdownRenderer,
  debounce,
  setIcon,
  normalizePath,
  ItemView,
} = require('obsidian');

const DEFAULT_SETTINGS = {
  highlightColor: '#ffeb3b',
  snapToWords: true,
  rememberZoom: true,
  /* 'position' or 'date'. */
  sidebarSort: 'position',
  /* How the note made from the annotations is laid out. See renderExport. */
  quoteMarks: 'double',
  highlightLayout: 'bullets',
  noteLayout: 'indented-bullet',
  looseNoteLayout: 'bullets',
};

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/* How many changes back the undo history goes, per PDF. The history lives in
   memory and is lost when Obsidian restarts, as undo histories are. */
const UNDO_LIMIT = 50;

/* Remembered zoom levels, kept per device rather than in the plugin's settings
   file. A comfortable zoom depends on the screen in front of you, so this is
   not something to carry between machines. Obsidian's own per-device store is
   the right home for it; it is also where Obsidian keeps which headings you
   have folded, for the same reason. */
const ZOOM_STORE_KEY = 'pdf-zoom';
const ZOOM_LIMIT = 200;
/* What the viewer accepts besides a number. */
const ZOOM_WORDS = ['auto', 'page-actual', 'page-fit', 'page-width', 'page-height'];

/* Obsidian's built-in PDF viewer registers this view type. */
const PDF_VIEW_TYPE = 'pdf';

/* The plugin's own annotations sidebar. */
const SIDEBAR_VIEW_TYPE = 'mpa-annotations';

class MinimalPdfAnnotatorPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    /* Per PDF: the annotations, and the lock that serialises writes to them.
       Keyed by path, because two leaves can show the same PDF and must not
       each keep their own copy of the data. */
    /** @type {Map<string, DocState>} */
    this.docs = new Map();
    /* Per open leaf: the DOM it owns. Keyed by the view object itself rather
       than by path, for the same reason. */
    /** @type {Map<object, ViewState>} */
    this.views = new Map();

    this.highlightMode = false;
    this.recentView = null;
    /* The PDF view used most recently, whose document the sidebar shows. */
    this.focusView = null;
    /* Each sidebar note box being typed in, with its own undo history. */
    this.noteFields = new WeakMap();
    this.sidebarOffered = false;
    this.zooms = this.readZooms();
    /* A pinch or a run of zoom steps changes the value many times over; the
       store only needs the one it settles on. */
    this.saveZooms = debounce(() => this.writeZooms(), 400, false);
    /* Where the drag began and ended. Needed because the browser's idea of
       which character a pointer landed on is approximate in a PDF; see
       refineBoundary(). */
    this.pointers = { down: null, up: null };

    this.applyModeColor();

    this.registerView(SIDEBAR_VIEW_TYPE, (leaf) => new AnnotationsView(leaf, this));

    this.ribbonEl = this.addRibbonIcon('highlighter', 'Toggle PDF highlight mode', () =>
      this.toggleHighlightMode()
    );

    /* A status bar toggle as well, so the feature is still reachable when the
       ribbon is hidden. */
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('mpa-status');
    this.statusEl.setAttribute('aria-label', 'Toggle PDF highlight mode');
    this.registerDomEvent(this.statusEl, 'click', () => this.toggleHighlightMode());
    this.updateStatusEl();

    this.addCommand({
      id: 'toggle-highlight-mode',
      name: 'Toggle highlight mode',
      callback: () => this.toggleHighlightMode(),
    });

    this.addCommand({
      id: 'open-annotations',
      name: 'Open annotations sidebar',
      callback: () => {
        this.ensureSidebar(true).catch((e) => this.report('could not open the sidebar', e));
      },
    });

    this.addCommand({
      id: 'create-note',
      name: 'Create note from annotations',
      checkCallback: (checking) => {
        const doc = this.focusDoc();
        if (!doc) return false;
        if (!checking) this.exportNote(doc).catch((e) => this.report('could not create the note', e));
        return true;
      },
    });

    /* Cmd or Ctrl with Z already works inside a PDF, from onKeyDown. These
       exist for the command palette, and for anyone who wants a second key of
       their own; that key must not be the one onKeyDown handles, for the
       reason given there. */
    this.addCommand({
      id: 'undo-annotation',
      name: 'Undo last annotation change',
      checkCallback: (checking) => {
        const doc = this.activeDoc();
        if (!doc || doc.readOnly || !doc.undoStack.length) return false;
        if (!checking) this.undo(doc);
        return true;
      },
    });

    this.addCommand({
      id: 'redo-annotation',
      name: 'Redo last undone annotation change',
      checkCallback: (checking) => {
        const doc = this.activeDoc();
        if (!doc || doc.readOnly || !doc.redoStack.length) return false;
        if (!checking) this.redo(doc);
        return true;
      },
    });

    this.addCommand({
      id: 'report-selection',
      name: 'Report what the current selection looks like',
      callback: () => {
        this.writeSelectionReport().catch((e) => this.report('could not write the report', e));
      },
    });

    this.addSettingTab(new MinimalPdfAnnotatorSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile) {
          this.reloadSidecar(file).catch((e) => this.report('could not reload annotations', e));
        }
      })
    );

    this.registerEvent(this.app.workspace.on('layout-change', () => this.scheduleSync()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      this.scheduleSync();
      this.refreshFocus();
    }));
    this.registerEvent(this.app.workspace.on('file-open', () => this.scheduleSync()));
    this.app.workspace.onLayoutReady(() => this.scheduleSync());

    /* Document-level handlers, so events are caught however Obsidian's PDF
       viewer wires its own listeners. Each one works out which PDF view the
       event happened in, if any. mouseup bubbles, so the browser has settled
       the text selection by the time it is read; click and contextmenu are
       captured so nothing swallows them first. */
    this.registerDomEvent(document, 'keydown', (e) => this.onKeyDown(e), true);
    this.registerDomEvent(document, 'mousedown', (e) => this.onMouseDown(e));
    this.registerDomEvent(document, 'mouseup', (e) => this.onMouseUp(e));
    this.registerDomEvent(document, 'click', (e) => this.onClick(e), true);
    this.registerDomEvent(document, 'contextmenu', (e) => this.onContextMenu(e), true);
  }

  onunload() {
    for (const state of this.views.values()) this.syncZoom(state);
    /* Typing still waiting to be saved is saved now rather than dropped. */
    for (const doc of this.docs.values()) {
      if (!doc.saveTimer) continue;
      window.clearTimeout(doc.saveTimer);
      doc.saveTimer = null;
      this.queueSave(doc);
    }
    document.body.removeClass('mpa-mode-active');
    document.body.style.removeProperty('--mpa-mode-color');
    for (const view of Array.from(this.views.keys())) this.teardownView(view);
    this.views.clear();
    this.docs.clear();
  }

  report(what, error) {
    const message = `Minimal PDF annotator: ${what}`;
    if (error === undefined) console.error(message);
    else console.error(message, error);
  }

  /* ----------------------------------------------------------------- modes */

  applyModeColor() {
    document.body.style.setProperty('--mpa-mode-color', this.settings.highlightColor);
  }

  toggleHighlightMode() {
    this.highlightMode = !this.highlightMode;
    document.body.toggleClass('mpa-mode-active', this.highlightMode);
    if (this.ribbonEl) this.ribbonEl.toggleClass('mpa-ribbon-active', this.highlightMode);
    this.updateStatusEl();
    /* Every viewer's toolbar button shows the mode, whichever control was
       actually used to change it. */
    for (const state of this.views.values()) this.refreshToolbarButton(state);
  }

  updateStatusEl() {
    const el = this.statusEl;
    if (!el) return;
    el.empty();
    el.toggleClass('mpa-status-active', this.highlightMode);
    el.createSpan({ cls: 'mpa-status-swatch' });
    el.createSpan({ text: this.highlightMode ? 'Highlight: on' : 'Highlight: off' });
  }

  /* ----------------------------------------------------------------- zoom */

  readZooms() {
    const out = {};
    let stored = null;
    try {
      stored = this.app.loadLocalStorage(ZOOM_STORE_KEY);
    } catch (e) {
      return out;
    }
    if (!stored || typeof stored !== 'object') return out;
    for (const path of Object.keys(stored)) {
      if (validZoom(stored[path])) out[path] = stored[path];
    }
    return out;
  }

  writeZooms() {
    try {
      this.app.saveLocalStorage(ZOOM_STORE_KEY, this.zooms);
    } catch (e) {
      this.report('could not save the zoom level', e);
    }
  }

  noteZoom(path, value) {
    if (!this.settings.rememberZoom || !validZoom(value)) return;
    if (this.zooms[path] === value) return;
    /* Deleted first, so the key moves to the end and the order stays
       least recently used first. */
    delete this.zooms[path];
    this.zooms[path] = value;
    pruneZooms(this.zooms, ZOOM_LIMIT);
    this.saveZooms();
  }

  /* Restores the remembered zoom once, then records any change to it
     afterwards. Called from render(), which already runs on the frame after
     the viewer rebuilds its pages, and changing the zoom is one of the things
     that rebuilds them. */
  syncZoom(state) {
    const viewer = pdfViewerOf(state.view);
    if (!viewer) return;

    if (state.pendingZoom) {
      /* Before the pages exist, setting the scale does nothing. */
      if (!viewer.pagesCount) return;
      const wanted = state.pendingZoom;
      state.pendingZoom = null;
      if (viewer.currentScaleValue === wanted) return;
      try {
        viewer.currentScaleValue = wanted;
      } catch (e) {
        this.report('could not restore the zoom level', e);
      }
      return;
    }

    if (state.doc) this.noteZoom(state.doc.file.path, viewer.currentScaleValue);
  }

  /* ------------------------------------------------------- attach / detach */

  /* A leaf's view exists before its file is loaded into it, and the layout
     events can all fire inside that window. Syncing again a tick later is what
     catches a PDF opened in a new tab, which otherwise never gets attached to
     and shows none of its highlights. */
  scheduleSync() {
    this.syncViews();
    if (this.syncQueued) return;
    this.syncQueued = true;
    const timer = window.setTimeout(() => {
      this.syncQueued = false;
      this.syncViews();
    }, 100);
    this.register(() => window.clearTimeout(timer));
  }

  /* Picks up PDF leaves that have appeared and lets go of the ones that have
     gone. */
  syncViews() {
    const live = new Set();
    for (const leaf of this.app.workspace.getLeavesOfType(PDF_VIEW_TYPE)) {
      const view = leaf.view;
      if (!view) continue;
      /* Still open, so not a teardown candidate even if its file has not
         arrived yet. */
      live.add(view);
      if (this.views.has(view) || !(view.file instanceof TFile)) continue;
      this.setupView(view).catch((e) => this.report('could not attach to a PDF view', e));
    }
    for (const view of Array.from(this.views.keys())) {
      if (!live.has(view)) this.teardownView(view);
    }
    this.refreshFocus();
  }

  async setupView(view) {
    const file = view.file;
    const container = view.containerEl || view.contentEl;

    /* Claim the slot before the first await, so a second layout-change
       arriving mid-load does not start a duplicate attach. */
    /** @type {ViewState} */
    const state = { view, container, doc: null, observer: null, frame: 0, pendingZoom: null };
    this.views.set(view, state);

    try {
      state.doc = await this.loadDoc(file);
    } catch (e) {
      this.views.delete(view);
      throw e;
    }
    /* The leaf may have closed while the sidecar was being read. */
    if (!this.views.has(view)) return;

    if (this.settings.rememberZoom) state.pendingZoom = this.zooms[file.path] || null;

    /* The viewer rebuilds page DOM as you scroll and on every zoom step, which
       wipes our overlays, so they are re-drawn on mutation. Our own drawing
       mutates the same subtree, so the observer is suspended for the duration:
       without that it retriggers itself and spins for as long as the PDF is
       open. */
    state.observer = new MutationObserver(() => this.scheduleRedraw(state));
    state.observer.observe(container, { childList: true, subtree: true });

    for (const other of this.views.values()) {
      if (other.doc === state.doc) this.render(other);
    }
    this.refreshFocus();
    this.maybeOpenSidebar();
  }

  teardownView(view) {
    const state = this.views.get(view);
    if (!state) return;
    /* A last look before the view goes, in case the zoom was changed and
       nothing redrew afterwards. */
    this.syncZoom(state);
    this.views.delete(view);
    if (this.focusView === view) this.focusView = null;
    if (state.observer) state.observer.disconnect();
    if (state.frame) window.cancelAnimationFrame(state.frame);
    state.container
      .querySelectorAll('.mpa-layer, .mpa-toolbar-btn')
      .forEach((el) => el.remove());
    /* The annotations stay cached for the session. Dropping them here would
       discard a save still in flight, and would race a second tab that is
       part-way through loading the same PDF. */
  }

  /* Redraws on the next animation frame, coalescing a burst of mutations into
     one pass. A timer was visible as a flicker: zooming replaces the page DOM,
     taking our overlays with it, and anything longer than a frame leaves the
     highlights missing for long enough to see. */
  scheduleRedraw(state) {
    if (state.frame) return;
    state.frame = window.requestAnimationFrame(() => {
      state.frame = 0;
      this.render(state);
    });
  }

  /* Runs `fn` without the view's own observer reacting to it. */
  withoutObserver(state, fn) {
    const observer = state.observer;
    if (observer) observer.disconnect();
    try {
      fn();
    } finally {
      if (observer && this.views.has(state.view)) {
        observer.observe(state.container, { childList: true, subtree: true });
      }
    }
  }

  /* ------------------------------------------------------ paths and the IO */

  getSidecarPath(pdfFile) {
    return pdfFile.path.replace(/\.pdf$/i, '') + '.annotations.json';
  }

  async loadDoc(file) {
    const existing = this.docs.get(file.path);
    if (existing) return existing;

    const loaded = await this.readSidecar(file);
    /* A second caller may have finished first while this one was reading. */
    const raced = this.docs.get(file.path);
    if (raced) return raced;

    /** @type {DocState} */
    const doc = {
      file,
      data: loaded.data,
      readOnly: !loaded.ok,
      saveChain: Promise.resolve(),
      sidecarStamp: null,
      /* The state as of the last change, which is what commit() pushes. */
      baseline: snapshot(loaded.data),
      undoStack: [],
      redoStack: [],
      /* A note being typed in the sidebar, not yet filed as an undo step. */
      editing: false,
      saveTimer: null,
    };
    this.docs.set(file.path, doc);
    return doc;
  }

  async readSidecar(pdfFile) {
    const path = this.getSidecarPath(pdfFile);
    const file = this.app.vault.getAbstractFileByPath(path);
    const empty = { highlights: [], notes: [] };
    if (!(file instanceof TFile)) return { data: empty, ok: true };
    try {
      const parsed = JSON.parse(await this.app.vault.read(file));
      const highlights = Array.isArray(parsed.highlights) ? parsed.highlights : [];
      return {
        ok: true,
        data: {
          highlights: highlights.map(migrateHighlight),
          notes: Array.isArray(parsed.notes) ? parsed.notes : [],
        },
      };
    } catch (e) {
      /* Carrying on with empty data would present as "annotations lost" and
         then overwrite the damaged file with nothing. The PDF opens read-only
         instead, so whatever is in that file is still there to be recovered. */
      this.report(`could not parse ${path}; annotations for this PDF are read-only until it is fixed`, e);
      new Notice(
        `Could not read ${path}. Annotations for this PDF are read-only until that file is fixed.`,
        10000
      );
      return { data: empty, ok: false };
    }
  }

  /* Writes are queued per PDF: a burst of highlights would otherwise have
     several vault.modify calls in flight against the same file at once. */
  queueSave(doc) {
    if (doc.readOnly) return doc.saveChain;
    doc.saveChain = doc.saveChain
      .then(() => this.save(doc))
      .catch((e) => {
        this.report('could not save annotations', e);
        new Notice('Could not save the annotation. See the console for details.');
      });
    return doc.saveChain;
  }

  async save(doc) {
    const path = this.getSidecarPath(doc.file);
    const content = JSON.stringify(doc.data, null, 2) + '\n';
    /* Recorded before the write, not after. The vault's change event can
       arrive while the write is still being awaited, and reloadSidecar would
       then read a file it had not been told about and throw away the undo
       history after every single change. */
    doc.sidecarStamp = stamp(content);

    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, content);
    else await this.app.vault.create(path, content);
  }

  /* A markdown note of every annotation on the document, beside it and named
     after it, opened in a new tab. Made fresh each time and never touched
     again, so it is the reader's to edit: a name already taken gets a number
     rather than being written over. */
  async exportNote(doc) {
    if (!doc) return;
    const md = renderExport(doc.data, this.settings);
    if (!md) {
      new Notice('There are no annotations to make a note of yet.');
      return;
    }
    const base = doc.file.path.replace(/\.[^./]+$/, '');
    let path = normalizePath(`${base}.md`);
    /* Also asked of the disk, which on most Macs and PCs ignores case, so
       "Paper.md" counts as taken by "paper.md". */
    const taken = async (p) =>
      !!this.app.vault.getAbstractFileByPath(p) || (await this.app.vault.adapter.exists(p));
    for (let n = 1; await taken(path); n++) path = normalizePath(`${base} ${n}.md`);
    const file = await this.app.vault.create(path, md);
    new Notice(`Created ${path}`);
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.openFile(file);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  /* The settings tab's explanatory text, from the editable file beside the
     plugin. Created from the built-in text the first time it is wanted. */
  async loadHelpText() {
    const dir = this.manifest.dir;
    if (!dir) return DEFAULT_HELP;
    const path = normalizePath(`${dir}/${HELP_FILE}`);
    const adapter = this.app.vault.adapter;
    try {
      if (await adapter.exists(path)) {
        const text = await adapter.read(path);
        /* Written by an earlier version and never edited: the newer wording
           replaces it. An edited copy is the reader's and is kept. */
        if (!OLD_HELP_STAMPS.includes(stamp(text))) return text;
      }
      await adapter.write(path, DEFAULT_HELP);
    } catch (e) {
      this.report(`could not read or create ${path}, using the built-in text`, e);
    }
    return DEFAULT_HELP;
  }

  /* ----------------------------------------------------------- dispatching */

  /* The view an event landed in, plus whichever of our own elements it hit. */
  locate(e) {
    const target = e.target;
    if (!(target instanceof Element)) return null;
    for (const state of this.views.values()) {
      if (!state.doc || !state.container.contains(target)) continue;
      this.recentView = state.view;
      return {
        state,
        pageEl: target.closest('.page'),
        highlightEl: target.closest('.mpa-highlight'),
        noteIconEl: target.closest('.mpa-note-icon'),
      };
    }
    return null;
  }

  /* A PDF whose sidecar would not parse is shown but not edited, so a change
     is refused up front rather than accepted and then dropped at save time.
     Checked by every way of starting a change, so that clicking a highlight
     and right-clicking it behave the same. */
  canEdit(doc) {
    if (!doc.readOnly) return true;
    new Notice('This PDF’s annotations file could not be read, so it cannot be edited.');
    return false;
  }

  /* Cmd or Ctrl with Z inside a PDF, caught here rather than registered as a
     hotkey.

     The difference matters. Obsidian's hotkey dispatcher listens on the window
     in the capture phase and stops a bound key travelling any further, and on
     the desktop the editor's undo is not an Obsidian command but CodeMirror's
     own key handling. A plugin command bound to this key would therefore stop
     editor undo working everywhere, and the hotkey settings would not warn
     about it, because there is no command for it to conflict with.

     Nothing is bound to the key, so Obsidian passes it on, and this listener
     claims it only for keystrokes that belong to a PDF. The cost of working
     this way is that the key cannot be rebound from the settings; the two
     commands can. */
  onKeyDown(e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;

    const code = e.code;
    const key = (e.key || '').toLowerCase();
    const isZ = code === 'KeyZ' || key === 'z';
    const isY = code === 'KeyY' || key === 'y';
    const undo = isZ && !e.shiftKey;
    /* Shift with Z everywhere, and Y as well where that is the convention. */
    const redo = (isZ && e.shiftKey) || (isY && !Platform.isMacOS);
    if (!undo && !redo) return;

    const target = e.target;
    if (target instanceof Element) {
      /* A note box undoes the words in it, not the annotation around it, and
         does so through its own history rather than the browser's, which
         steps one character at a time. */
      const field = this.noteFields.get(target);
      if (field) {
        e.preventDefault();
        e.stopPropagation();
        const changed = undo ? field.history.undo() : field.history.redo();
        if (changed) field.sync();
        return;
      }
      /* Anything else with an undo of its own keeps the key untouched. */
      if (target.closest('input, textarea, .cm-editor, [contenteditable="true"]')) {
        return;
      }
    }

    const doc = this.activeDoc();
    if (!doc || doc.readOnly) return;

    /* Claimed either way, so the key never does something unexpected in a
       PDF just because there is nothing left to undo. */
    e.preventDefault();
    e.stopPropagation();
    if (undo) this.undo(doc);
    else this.redo(doc);
  }

  onMouseDown(e) {
    if (e.button !== 0) return;
    this.pointers.down = { x: e.clientX, y: e.clientY };
    this.pointers.up = null;
  }

  onMouseUp(e) {
    if (!this.highlightMode || e.button !== 0) return;
    this.pointers.up = { x: e.clientX, y: e.clientY };
    const hit = this.locate(e);
    if (!hit || !this.canEdit(hit.state.doc)) return;
    const id = this.addHighlightsFromSelection(hit.state);
    if (id) this.showInSidebar(hit.state.doc, id);
  }

  onClick(e) {
    if (e.button !== 0) return;
    const hit = this.locate(e);
    if (!hit) return;

    /* A highlight, or a note's marker, puts the cursor in its note box in the
       sidebar. Clicking the page anywhere else does nothing of ours. */
    const id = hit.noteIconEl
      ? hit.noteIconEl.dataset.noteId
      : hit.highlightEl
      ? hit.highlightEl.dataset.highlightId
      : null;
    if (!id) return;
    if (hit.noteIconEl) e.stopPropagation();
    this.revealAnnotation(hit.state.doc, id, true).catch((err) => this.report('could not show the note', err));
  }

  onContextMenu(e) {
    const hit = this.locate(e);
    if (!hit || !hit.pageEl) return; // only intercept a right-click on a page
    if (hit.state.doc.readOnly) return; // leave the viewer's own menu in place

    const { state, pageEl, noteIconEl } = hit;
    const iconKind = noteIconEl ? noteIconEl.dataset.noteKind : null;
    const iconId = noteIconEl ? noteIconEl.dataset.noteId : null;

    /* Right-clicking the icon of a highlight's note counts as right-clicking
       that highlight. */
    let highlightId = hit.highlightEl ? hit.highlightEl.dataset.highlightId : null;
    if (!highlightId && iconKind === 'highlight') highlightId = iconId;

    const menu = new Menu();

    /* A note asked for on top of a highlight belongs to that highlight, not to
       the point on the page. Making a standalone note there instead left it
       with nothing to sit under in an exported note, and gave the highlight two
       separate things attached to the same words. */
    if (iconKind === 'note') {
      menu.addItem((item) =>
        item
          .setTitle('Edit note')
          .setIcon('sticky-note')
          .onClick(() => this.revealAnnotation(state.doc, iconId, true))
      );
    } else if (highlightId) {
      const existing = state.doc.data.highlights.find((h) => h.id === highlightId);
      menu.addItem((item) =>
        item
          .setTitle(existing && existing.note ? 'Edit note' : 'Add note')
          .setIcon('sticky-note')
          .onClick(() => this.revealAnnotation(state.doc, highlightId, true))
      );
    } else {
      menu.addItem((item) =>
        item
          .setTitle('Add note')
          .setIcon('sticky-note')
          .onClick(() => this.addStandaloneNote(state, e, pageEl))
      );
    }

    if (iconKind === 'note') {
      menu.addItem((item) =>
        item
          .setTitle('Remove note')
          .setIcon('trash')
          .onClick(() => {
            state.doc.data.notes = state.doc.data.notes.filter((n) => n.id !== iconId);
            this.commit(state.doc, 'removing a note');
          })
      );
    } else if (highlightId) {
      const highlight = state.doc.data.highlights.find((h) => h.id === highlightId);
      if (highlight && highlight.note) {
        menu.addItem((item) =>
          item
            .setTitle('Remove note')
            .setIcon('trash')
            .onClick(() => {
              highlight.note = '';
              this.commit(state.doc, 'removing a note');
            })
        );
      }
      menu.addItem((item) =>
        item
          .setTitle('Remove highlight')
          .setIcon('trash')
          .onClick(() => {
            state.doc.data.highlights = state.doc.data.highlights.filter((h) => h.id !== highlightId);
            this.commit(state.doc, 'removing a highlight');
          })
      );
    }

    e.preventDefault();
    menu.showAtMouseEvent(e);
  }

  /* Persist a change and redraw every view showing that PDF.

     The state being replaced goes onto the undo stack here rather than at each
     place that changes something, so a new kind of change cannot be added
     without becoming undoable. `label` says what was done, for the notice that
     undoing it shows. */
  commit(doc, label) {
    doc.undoStack.push({ state: doc.baseline, label: label || 'that change' });
    while (doc.undoStack.length > UNDO_LIMIT) doc.undoStack.shift();
    doc.redoStack.length = 0;
    doc.baseline = snapshot(doc.data);

    if (doc.saveTimer) {
      window.clearTimeout(doc.saveTimer);
      doc.saveTimer = null;
    }
    this.queueSave(doc);
    for (const state of this.views.values()) {
      if (state.doc === doc) this.render(state);
    }
    this.notify(doc);
  }

  /* ------------------------------------------------------------ undo / redo */

  /* The PDF these commands act on: the one with keyboard focus, or failing
     that the one last interacted with, as long as it is still on screen. */
  activeDoc() {
    const focused = document.activeElement;
    for (const state of this.views.values()) {
      if (focused && state.container.contains(focused)) return state.doc;
    }
    /* Focus in the sidebar, outside a note box: its document. */
    for (const sidebar of this.sidebars()) {
      if (focused && sidebar.doc && sidebar.containerEl.contains(focused)) return sidebar.doc;
    }
    const recent = this.views.get(this.recentView);
    if (recent && recent.container.isShown && recent.container.isShown()) return recent.doc;
    return null;
  }

  step(doc, from, to) {
    if (!from.length) return false;
    const entry = from.pop();
    to.push({ state: snapshot(doc.data), label: entry.label });

    doc.data.highlights = entry.state.highlights;
    doc.data.notes = entry.state.notes;
    doc.baseline = snapshot(doc.data);

    this.queueSave(doc);
    for (const state of this.views.values()) {
      if (state.doc === doc) this.render(state);
    }
    this.notify(doc);
    return true;
  }

  undo(doc) {
    return this.step(doc, doc.undoStack, doc.redoStack);
  }

  redo(doc) {
    return this.step(doc, doc.redoStack, doc.undoStack);
  }

  /* The annotations file changed underneath us, so whatever history we were
     holding describes a document that no longer exists. Undoing onto it would
     write our old idea of the file over somebody else's newer one. */
  async reloadSidecar(file) {
    for (const doc of this.docs.values()) {
      if (file.path !== this.getSidecarPath(doc.file)) continue;
      let raw;
      try {
        raw = await this.app.vault.read(file);
      } catch (e) {
        return;
      }
      if (stamp(raw) === doc.sidecarStamp) return; // our own write coming back

      const loaded = await this.readSidecar(doc.file);
      doc.data = loaded.data;
      doc.readOnly = !loaded.ok;
      doc.sidecarStamp = stamp(raw);
      doc.baseline = snapshot(doc.data);
      doc.undoStack.length = 0;
      doc.redoStack.length = 0;
      for (const state of this.views.values()) {
        if (state.doc === doc) this.render(state);
      }
      this.notify(doc);
      return;
    }
  }

  /* ------------------------------------------------------------ highlights */

  addHighlightsFromSelection(state) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);

    /* The pages the selection actually touches, in document order. */
    const pages = Array.from(state.container.querySelectorAll('.page')).filter((pageEl) => {
      const textLayer = pageEl.querySelector('.textLayer');
      return textLayer && range.intersectsNode(textLayer);
    });
    if (!pages.length) return;

    const rects = [];
    const parts = [];

    for (const pageEl of pages) {
      const textLayer = pageEl.querySelector('.textLayer');
      const box = pagePaddingBox(pageEl);
      if (!textLayer || !box) continue;

      const chars = buildChars(involvedNodes(range, textLayer));
      const slice = selectedSlice(chars, range, this.pointers, this.settings.snapToWords);
      if (!slice) continue;

      /* A selection crossing a page break also takes in whatever the text
         layer holds between the two columns of body text: a running header, a
         page number, a footer. Those sit apart from the body text, so they are
         dropped. Only for a multi-page selection: within one page, a first or
         last line standing apart is as likely to be a heading the reader meant
         to include. */
      const all = linesFromChars(chars, slice.from, slice.to);
      const lines = pages.length > 1 ? dropRunningHeads(all) : all;
      if (!lines.length) continue;

      const page = pageNumberOf(pageEl);
      for (const line of lines) {
        /* A line the viewer gave no position to contributes its text but has
           nothing to draw. */
        if (line.top === null) continue;
        rects.push({
          page,
          x: (line.left - box.left) / box.width,
          y: (line.top - box.top) / box.height,
          w: line.width / box.width,
          h: line.height / box.height,
        });
      }
      parts.push(lines.map((line) => line.text).join(' '));
    }

    const text = collapseWhitespace(parts.join(' '));
    if (!rects.length || !text) return;

    selection.removeAllRanges();
    /* One highlight, however many pages it runs across, so that removing it
       removes the whole thing. */
    const id = uuid();
    state.doc.data.highlights.push({
      id,
      text,
      rects,
      /* Recorded per highlight, so changing the setting later recolours
         nothing that already exists. */
      color: this.settings.highlightColor,
      note: '',
      createdAt: new Date().toISOString(),
    });
    this.commit(state.doc, 'adding a highlight');
    return id;
  }

  /* ------------------------------------------------------------ diagnostics */

  /* Writes down what the viewer reports for the current selection: the
     character array a highlight is cut from, where the two boundaries ended up
     and where the browser had put them, and the lines and text that follow.

     Some of this depends on how a particular PDF's text layer is put together,
     which differs between files and cannot be guessed at from the outside.
     When a highlight comes out wrong, this is what says why. */
  async writeSelectionReport() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      new Notice('Select some text in a PDF first.');
      return;
    }
    const range = selection.getRangeAt(0);

    let found = null;
    for (const state of this.views.values()) {
      if (state.container.contains(range.commonAncestorContainer)) found = state;
    }
    if (!found) {
      new Notice('That selection is not inside a PDF this plugin is watching.');
      return;
    }

    const pages = Array.from(found.container.querySelectorAll('.page')).filter((pageEl) => {
      const textLayer = pageEl.querySelector('.textLayer');
      return textLayer && range.intersectsNode(textLayer);
    });

    const out = [];
    out.push('# Selection report');
    out.push('');
    out.push('PDF: `' + found.doc.file.path + '`');
    out.push(`Pages touched: ${pages.length}`);
    out.push(`Snap to whole words: ${this.settings.snapToWords ? 'on' : 'off'}`);
    out.push(`Pointer down: ${describePoint(this.pointers.down)}`);
    out.push(`Pointer up: ${describePoint(this.pointers.up)}`);
    out.push('');
    out.push('## What the browser says is selected');
    out.push('');
    out.push('```');
    out.push(range.toString());
    out.push('```');
    out.push('');

    const parts = [];
    for (const pageEl of pages) {
      const page = pageNumberOf(pageEl);
      const textLayer = pageEl.querySelector('.textLayer');
      const box = pagePaddingBox(pageEl);

      out.push(`## Page ${page}`);
      out.push('');
      out.push(
        box
          ? `Page box: left ${round(box.left)}, top ${round(box.top)}, ${round(box.width)} by ${round(box.height)}`
          : 'Page box: could not be measured'
      );

      const chars = buildChars(involvedNodes(range, textLayer));
      const bounds = touchedBounds(chars);
      const slice = selectedSlice(chars, range, this.pointers, this.settings.snapToWords);

      out.push('');
      out.push(`Characters measured: ${chars.length}`);
      out.push(`Where the browser put the two ends: ${bounds ? bounds.from + ' to ' + bounds.to : 'neither is on this page'}`);
      out.push(`Where they ended up: ${slice ? slice.from + ' to ' + slice.to : 'nothing selected on this page'}`);
      out.push('');

      if (slice) {
        out.push('### The two edges');
        out.push('');
        out.push('| edge | at | character before | character after | x |');
        out.push('| --- | --- | --- | --- | --- |');
        for (const [label, index] of [['start', slice.from], ['end', slice.to]]) {
          const at = boundaryPosition(chars, index);
          out.push(
            `| ${label} | ${index} | ${cell(charAt(chars, index - 1))} | ${cell(charAt(chars, index))} | ${at ? round(at.x) : ''} |`
          );
        }
        out.push('');
      }

      const all = slice ? linesFromChars(chars, slice.from, slice.to) : [];
      const kept = pages.length > 1 ? dropRunningHeads(all) : all;
      const dropped = all.filter((line) => !kept.includes(line));

      out.push(`### Lines (${all.length}, of which ${dropped.length} dropped as a running head)`);
      out.push('');
      out.push('| kept | top | height | left | width | text |');
      out.push('| --- | --- | --- | --- | --- | --- |');
      for (const line of all) {
        out.push(
          `| ${kept.includes(line) ? 'yes' : 'no'} | ${blank(line.top)} | ${blank(line.height)} ` +
            `| ${blank(line.left)} | ${blank(line.width)} | ${cell(line.text)} |`
        );
      }
      out.push('');
      parts.push(kept.map((line) => line.text).join(' '));
    }

    out.push('## What would be stored');
    out.push('');
    out.push('```');
    out.push(collapseWhitespace(parts.join(' ')));
    out.push('```');
    out.push('');

    const path = 'Minimal PDF annotator selection report.md';
    const body = out.join('\n');
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, body);
    else await this.app.vault.create(path, body);
    await this.app.workspace.openLinkText(path, '', true);
  }

  /* ------------------------------------------------------- the sidebar side */

  sidebars() {
    return this.app.workspace
      .getLeavesOfType(SIDEBAR_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view) => view instanceof AnnotationsView);
  }

  /* The document the sidebar shows: the one in the PDF view used most
     recently, for as long as that view stays open. Moving into the sidebar, or
     into a markdown note, leaves it where it was. */
  focusDoc() {
    const state = this.views.get(this.focusView);
    if (state && state.doc) return state.doc;
    for (const other of this.views.values()) if (other.doc) return other.doc;
    return null;
  }

  refreshFocus() {
    const recent = this.app.workspace.getMostRecentLeaf && this.app.workspace.getMostRecentLeaf();
    if (recent && recent.view && this.views.has(recent.view)) this.focusView = recent.view;
    if (this.focusView && !this.views.has(this.focusView)) this.focusView = null;
    const doc = this.focusDoc();
    for (const sidebar of this.sidebars()) sidebar.setDoc(doc);
  }

  /* Tells every sidebar showing this document that it changed. */
  notify(doc) {
    for (const sidebar of this.sidebars()) {
      if (sidebar.doc === doc) sidebar.refresh();
    }
  }

  /* The sidebar, made if there is none, and brought into view if asked. */
  ensureSidebar(reveal) {
    /* Two requests arriving together, such as the first PDF opening while a
       highlight is clicked, would otherwise each make a sidebar. */
    const pending = this.sidebarPending || Promise.resolve();
    const next = pending.then(() => this.ensureSidebarNow(reveal));
    this.sidebarPending = next.catch(() => null);
    return next;
  }

  async ensureSidebarNow(reveal) {
    const workspace = this.app.workspace;
    let leaf = workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return null;
      await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: false });
    }
    if (reveal) await workspace.revealLeaf(leaf);
    /* A sidebar tab that has not been looked at yet is a placeholder until it
       is loaded. */
    if (leaf.isDeferred && typeof leaf.loadIfDeferred === 'function') await leaf.loadIfDeferred();
    return leaf.view instanceof AnnotationsView ? leaf.view : null;
  }

  /* The sidebar comes into view by itself the first time a PDF is opened in a
     session, so it is there without being asked for, the way Zotero's is.
     Only once: if it is closed after that, it stays closed until something
     needs it. */
  maybeOpenSidebar() {
    if (this.sidebarOffered) return;
    this.sidebarOffered = true;
    if (this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE).length) return;
    this.ensureSidebar(true).catch((e) => this.report('could not open the sidebar', e));
  }

  /* Clicking a highlight or note marker in the document: its card, with the
     cursor in its note. */
  async revealAnnotation(doc, id, focusNote) {
    const sidebar = await this.ensureSidebar(true);
    if (!sidebar) return;
    sidebar.setDoc(doc);
    sidebar.showCard(id, { focusNote: !!focusNote });
  }

  /* A new highlight shows up in any sidebar that is already open, without
     opening one or taking the keyboard away from the page. */
  showInSidebar(doc, id) {
    for (const sidebar of this.sidebars()) {
      if (sidebar.doc === doc) sidebar.showCard(id, { focusNote: false });
    }
  }

  /* The open view showing a document, preferring the one used most recently. */
  viewForDoc(doc) {
    const focused = this.views.get(this.focusView);
    if (focused && focused.doc === doc) return focused;
    for (const state of this.views.values()) if (state.doc === doc) return state;
    return null;
  }

  /* Clicking a card's words: scrolls the document to them and marks them
     briefly. Works from the page's own box, which exists for every page even
     before the page is drawn. */
  navigateTo(doc, id) {
    const state = doc && this.viewForDoc(doc);
    if (!state) return false;
    const target = annotationTarget(doc.data, id);
    const inner = pdfInnerOf(state.view);
    if (!target || !inner || !inner.container) return false;

    if (!state.container.isShown()) this.app.workspace.revealLeaf(state.view.leaf);
    const pageEl = state.container.querySelector(`.page[data-page-number="${target.page}"]`);
    const box = pageEl && pagePaddingBox(pageEl);
    if (box) {
      const scroller = inner.container;
      const top = scroller.getBoundingClientRect().top;
      scroller.scrollTop += box.top + target.y * box.height - top - scroller.clientHeight * 0.3;
    } else {
      inner.currentPageNumber = target.page;
    }
    state.flash = { id, since: Date.now(), until: Date.now() + FLASH_MS };
    this.scheduleRedraw(state);
    return true;
  }

  /* Typing in a note box. Saved shortly after, and drawn at once so a note
     marker appears or goes as the note does. Not yet an undo step: that is
     filed once, when the box is left. */
  setNote(doc, id, text) {
    if (!doc || doc.readOnly) return;
    const found = findAnnotation(doc.data, id);
    if (!found) return;
    if (found.kind === 'highlight') found.obj.note = text;
    else found.obj.text = text;
    doc.editing = true;
    this.saveSoon(doc);
    for (const state of this.views.values()) {
      if (state.doc === doc) this.scheduleRedraw(state);
    }
  }

  endNoteEdit(doc) {
    if (!doc.editing) return;
    doc.editing = false;
    /* Typed and then rubbed out again: nothing to undo. */
    if (JSON.stringify(doc.baseline) === JSON.stringify(snapshot(doc.data))) return;
    this.commit(doc, 'editing a note');
  }

  deleteAnnotation(doc, id) {
    if (!doc || !this.canEdit(doc)) return;
    const found = findAnnotation(doc.data, id);
    if (!found) return;
    if (found.kind === 'highlight') {
      doc.data.highlights = doc.data.highlights.filter((h) => h.id !== id);
    } else {
      doc.data.notes = doc.data.notes.filter((n) => n.id !== id);
    }
    this.commit(doc, found.kind === 'highlight' ? 'removing a highlight' : 'removing a note');
  }

  /* Right-clicking a bare part of a page. The note is made at once, empty,
     and the cursor goes to its box in the sidebar. An empty note is kept, as
     Zotero keeps one; it is removed from its card's menu. */
  addStandaloneNote(state, e, pageEl) {
    if (!this.canEdit(state.doc)) return;
    const box = pagePaddingBox(pageEl);
    if (!box) return;
    const note = {
      id: uuid(),
      page: pageNumberOf(pageEl),
      text: '',
      position: { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height },
      createdAt: new Date().toISOString(),
    };
    state.doc.data.notes.push(note);
    this.commit(state.doc, 'adding a note');
    this.revealAnnotation(state.doc, note.id, true).catch((err) => this.report('could not show the note', err));
  }

  /* Debounced save for typing, so a word is one write rather than one per
     letter. */
  saveSoon(doc) {
    if (doc.saveTimer) window.clearTimeout(doc.saveTimer);
    doc.saveTimer = window.setTimeout(() => {
      doc.saveTimer = null;
      this.queueSave(doc);
    }, 400);
  }

  /* -------------------------------------------------------------- drawing */

  render(state) {
    if (!state.doc || !this.views.has(state.view)) return;
    /* Outside withoutObserver, so that the page rebuild a zoom change causes
       is seen and the overlays are drawn again at the new scale. */
    this.syncZoom(state);
    this.withoutObserver(state, () => {
      this.drawToolbarButton(state);
      this.drawHighlights(state);
    });
  }

  drawHighlights(state) {
    const { highlights, notes } = state.doc.data;

    /* A highlight can span pages, so its rectangles are bucketed by the page
       they belong to. Its note marker goes on whichever page its first
       rectangle is on. */
    const byPage = new Map();
    const bucket = (page) => {
      if (!byPage.has(page)) byPage.set(page, { rects: [], icons: [] });
      return byPage.get(page);
    };

    for (const highlight of highlights) {
      const color = HEX_COLOR_RE.test(highlight.color || '')
        ? highlight.color
        : this.settings.highlightColor;
      for (const rect of highlight.rects || []) {
        bucket(rect.page).rects.push({ highlight, rect, color });
      }
      const first = firstRect(highlight);
      if (highlight.note && first) {
        /* In the margin, level with the middle of the highlight's first line,
           so the marker never sits over the words it belongs to. */
        bucket(first.page).icons.push({
          id: highlight.id,
          kind: 'highlight',
          y: first.y + (first.h || 0) / 2,
          inMargin: true,
          color,
        });
      }
    }
    for (const note of notes) {
      /* Also in the margin, level with the point it was put at. Keeping the
         marker where the page was right-clicked meant it sat on top of the
         words there, which is the thing the margin exists to avoid. Where it
         was put is still recorded, and still decides its place in the
         sidebar and in an exported note; only the marker moves. */
      const position = note.position || { x: 0, y: 0 };
      bucket(note.page).icons.push({
        id: note.id,
        kind: 'note',
        y: position.y,
        inMargin: true,
        color: this.settings.highlightColor,
      });
    }

    for (const pageEl of state.container.querySelectorAll('.page')) {
      const items = byPage.get(pageNumberOf(pageEl));
      let layer = pageEl.querySelector(':scope > .mpa-layer');

      if (!items || (!items.rects.length && !items.icons.length)) {
        if (layer) layer.remove();
        continue;
      }
      if (!layer) layer = pageEl.createDiv({ cls: 'mpa-layer' });
      layer.empty();

      for (const { highlight, rect, color } of items.rects) {
        const el = layer.createDiv({ cls: 'mpa-highlight' });
        el.dataset.highlightId = highlight.id;
        el.style.setProperty('--mpa-x', pct(rect.x));
        el.style.setProperty('--mpa-y', pct(rect.y));
        el.style.setProperty('--mpa-w', pct(rect.w));
        el.style.setProperty('--mpa-h', pct(rect.h));
        el.style.setProperty('--mpa-color', color);
        markFlash(el, state, highlight.id);
      }

      for (const item of items.icons) {
        /* Only the vertical position comes from script. The margin placement
           is in the stylesheet, so there is one rule for every marker. */
        const icon = this.createNoteIcon(layer, item.id, item.kind, item.color);
        icon.style.setProperty('--mpa-y', pct(item.y));
        if (item.kind === 'note') markFlash(icon, state, item.id);
      }
    }
  }

  createNoteIcon(layer, id, kind, color) {
    const el = layer.createDiv({ cls: 'mpa-note-icon' });
    el.dataset.noteId = id;
    el.dataset.noteKind = kind;
    el.setAttribute('aria-label', kind === 'note' ? 'Open note' : 'Open highlight note');
    el.style.setProperty('--mpa-color', color);
    setIcon(el, 'sticky-note');
    return el;
  }

  /* A highlighter button in the PDF viewer's own toolbar, so the mode can be
     reached without the ribbon or the status bar. */
  drawToolbarButton(state) {
    const toolbar =
      state.container.querySelector('.pdf-toolbar') ||
      state.container.querySelector('.pdf-toolbar-container') ||
      state.container.querySelector('.pdf-container') ||
      state.container;
    const floating = !toolbar.matches('.pdf-toolbar, .pdf-toolbar-container');

    let btn = toolbar.querySelector(':scope > .mpa-toolbar-btn');
    if (!btn) {
      /* A stale button from an earlier layout, now in the wrong container. */
      state.container.querySelectorAll('.mpa-toolbar-btn').forEach((el) => el.remove());
      btn = toolbar.createDiv({ cls: 'mpa-toolbar-btn clickable-icon' });
      btn.setAttribute('aria-label', 'Toggle PDF highlight mode');
      setIcon(btn, 'highlighter');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleHighlightMode();
      });
    }
    btn.toggleClass('mpa-toolbar-btn-floating', floating);
    this.styleToolbarButton(btn);
  }

  refreshToolbarButton(state) {
    const btn = state.container.querySelector('.mpa-toolbar-btn');
    if (btn) this.styleToolbarButton(btn);
  }

  styleToolbarButton(btn) {
    btn.toggleClass('is-active', this.highlightMode);
    btn.style.setProperty('--mpa-color', this.settings.highlightColor);
  }

  /* ------------------------------------------------------------- settings */

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!HEX_COLOR_RE.test(this.settings.highlightColor)) {
      this.settings.highlightColor = DEFAULT_SETTINGS.highlightColor;
    }
    this.settings.snapToWords = this.settings.snapToWords !== false;
    this.settings.rememberZoom = this.settings.rememberZoom !== false;
    const valid = {
      quoteMarks: Object.keys(QUOTE_MARKS),
      highlightLayout: Object.keys(LAYOUT_SHAPES),
      noteLayout: ['indented-bullet', 'line', 'paragraph', 'same-line'],
      looseNoteLayout: Object.keys(LAYOUT_SHAPES),
      sidebarSort: ['position', 'date'],
    };
    for (const [key, allowed] of Object.entries(valid)) {
      if (!allowed.includes(this.settings[key])) this.settings[key] = DEFAULT_SETTINGS[key];
    }
  }

  async setSidebarSort(sort) {
    this.settings.sidebarSort = sort === 'date' ? 'date' : 'position';
    await this.saveData(this.settings);
    for (const sidebar of this.sidebars()) {
      sidebar.updateSortButton();
      sidebar.refresh();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyModeColor();
    this.updateStatusEl();
    for (const state of this.views.values()) this.render(state);
    for (const sidebar of this.sidebars()) sidebar.refresh();
  }
}

/* The settings tab's explanatory text lives in a file beside the plugin, so
   the wording can be edited without touching JavaScript. Obsidian's installer
   only fetches main.js, manifest.json and styles.css, so the file cannot
   simply be shipped: the text below is the source of truth, and the plugin
   writes it out on first load if it is not already there. It is never
   overwritten after that, so an edit survives. */
const HELP_FILE = 'settings-help.md';

/* Stamps of help text written out by earlier versions, so an unedited copy
   can be recognised and brought up to date. Add the current text's stamp
   here whenever DEFAULT_HELP changes. */
const OLD_HELP_STAMPS = ['41f1859b-3282'];

const DEFAULT_HELP = `## How it works

Turn on highlight mode from the ribbon, the status bar or the PDF toolbar, then
select text in a PDF to highlight it.

The annotations sidebar lists every highlight and note on the PDF in front of
you. It opens by itself the first time you open a PDF, and the command **Open
annotations sidebar** brings it back.

- **Click a card's words** to go to that place in the PDF.
- **Type in "Add note"** under a highlight to annotate it. Notes save as you
  type.
- **Click a highlight in the PDF** to land in its note box in the sidebar.
- **Right-click a bare part of a page** for "Add note", which makes a note of
  its own at that point.
- **Delete** a highlight or note from the ··· menu on its card, or by
  selecting the card and pressing Delete.

A highlight longer than five lines is cut short in the sidebar. Click it once
to read all of it, and again to go to it.

**Search annotations** at the top of the sidebar filters the cards as you type,
forgiving a slip or two in each word. Clicking a result shows it among all the
others; clicking it again goes to it in the PDF. The button beside the search
box switches between the order things appear in and the order you added them.

## Making a note

The note button at the top of the sidebar creates a note with the same name as
the PDF, beside it, holding every highlight and note in reading order, and
opens it. If that name is taken, a number is added. The note is yours: the
plugin never changes it afterwards, so make another when you want an updated
copy. How it is laid out is set above.

## Undoing

Cmd or Ctrl with Z steps back through the highlights and notes on the PDF you
are looking at, and adding Shift steps forward again. The same keys keep their
usual meaning everywhere else. Inside a note box they undo what you typed,
grouped by pauses the way the rest of Obsidian groups it.

They cannot be rebound. The keys are caught by the plugin rather than
registered in Obsidian's hotkey settings, because a hotkey bound to this key
would stop the editor's own undo working everywhere. There are also two
commands, **Undo last annotation change** and **Redo last undone annotation
change**, which you can reach from the command palette or give a second key of
your own.

The history goes fifty changes back per PDF, lives in memory, and is lost when
Obsidian restarts. It is also cleared if the annotations file changes from
outside the plugin, by a sync for instance, since by then it describes a
document that no longer exists.

## Zoom

Each PDF reopens at the zoom you last read it at. This is kept per device,
since a comfortable zoom depends on the screen in front of you, so it is not
carried between machines.

## Where your annotations live

For \`refs/paper.pdf\`, the annotations are kept in
\`refs/paper.annotations.json\` beside it. That file is the only copy of them, so
keep it with the PDF when you move things around.

## When a highlight comes out wrong

Run the command **Report what the current selection looks like** with the
problem text selected. It writes a note describing what the viewer reports for
every span in the selection, which is what explains the result.

---

*This text lives in \`${HELP_FILE}\` in the plugin folder, so you can edit it.
Reopen this tab to see your changes. The plugin only ever creates that file, so
your wording is kept.*
`;

class MinimalPdfAnnotatorSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const settings = this.plugin.settings;
    const save = async (key, value) => {
      settings[key] = value;
      await this.plugin.saveSettings();
    };

    new Setting(containerEl)
      .setName('Snap highlight to whole words')
      .setDesc(
        'For boring reasons, highlights can be inaccurate. If you often want to highlight half ' +
          'a word, turn this off. Otherwise, this toggle should improve performance.'
      )
      .addToggle((toggle) => toggle.setValue(settings.snapToWords).onChange((v) => save('snapToWords', v)));

    new Setting(containerEl)
      .setName('Highlight colour')
      .setDesc('Used for new highlights. Existing ones keep the colour they were made with.')
      .addColorPicker((picker) =>
        picker.setValue(settings.highlightColor).onChange(async (value) => {
          if (!HEX_COLOR_RE.test(value)) return;
          await save('highlightColor', value);
        })
      );

    const choice = (name, key, options) =>
      new Setting(containerEl)
        .setName(name)
        .addDropdown((dropdown) =>
          dropdown
            .addOptions(options)
            .setValue(settings[key])
            .onChange((v) => save(key, v))
        );

    choice('Highlighted text is enclosed in', 'quoteMarks', {
      single: "Single quotation marks ('')",
      double: 'Double quotation marks ("")',
      none: 'Nothing',
    });
    choice('Highlighted text appears in the .md file as', 'highlightLayout', {
      bullets: 'new bullets',
      lines: 'new lines',
      paragraphs: 'new paragraphs',
    });
    choice('Each note attached to highlighted text appears in the .md file', 'noteLayout', {
      'indented-bullet': 'as a bullet indented under the highlighted text',
      line: 'on a new line under the highlighted text',
      paragraph: 'in a new paragraph under the highlighted text',
      'same-line': 'on the same line as the highlighted text',
    });
    choice('Notes that aren\u2019t attached to highlighted text appear in the .md file as', 'looseNoteLayout', {
      bullets: 'new bullets',
      lines: 'new lines',
      paragraphs: 'new paragraphs',
    });

    new Setting(containerEl)
      .setName('Remember each PDF\u2019s zoom level')
      .setDesc(
        'Reopen a PDF at the zoom you last read it at. Kept per device, since a comfortable ' +
          'zoom depends on the screen, so it is not carried between machines.'
      )
      .addToggle((toggle) => toggle.setValue(settings.rememberZoom).onChange((v) => save('rememberZoom', v)));

    /* Reading the file is asynchronous and display() is not, so the text is
       rendered into a container that is already in place. */
    const help = containerEl.createDiv({ cls: 'mpa-help' });
    this.renderHelp(help).catch((e) => {
      this.plugin.report(`could not render ${HELP_FILE}`, e);
      help.empty();
      help.createEl('p', {
        text: 'Turn on highlight mode from the ribbon, the status bar or the PDF toolbar, then select text in a PDF to highlight it.',
        cls: 'setting-item-description',
      });
    });
  }

  async renderHelp(el) {
    const markdown = await this.plugin.loadHelpText();
    el.empty();
    /* render() replaced renderMarkdown() during the 1.5 series; accept either
       so the stated minimum app version holds. */
    if (MarkdownRenderer.render) {
      await MarkdownRenderer.render(this.app, markdown, el, '', this.plugin);
    } else {
      await MarkdownRenderer.renderMarkdown(markdown, el, '', this.plugin);
    }
  }
}

/* ------------------------------------------------------------------ sidebar

   The annotations sidebar, after Zotero's. One card per highlight or note on
   the document in front of you: the highlighted words, and an "Add note" box
   under them. Clicking the words takes you to them in the document; clicking
   a highlight in the document puts you in its box here. Every change in either
   place is the same change, made once, through the plugin. */

/* Whether the browser can grow a text box to fit its contents by itself. Where
   it cannot, the sidebar does it by measuring. */
/* How many lines of a highlight's words a card shows before cutting them. */
const QUOTE_LINES = 5;

const FIELD_SIZING =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');

class AnnotationsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    /* undefined until opened, so the first setDoc always draws. */
    this.doc = undefined;
    /** @type {Map<string, Card>} */
    this.cards = new Map();
    this.selectedId = null;
    this.query = '';
  }

  getViewType() {
    return SIDEBAR_VIEW_TYPE;
  }

  getDisplayText() {
    return 'Annotations';
  }

  getIcon() {
    return 'highlighter';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('mpa-sidebar');
    this.buildHeader(root.createDiv({ cls: 'mpa-sidebar-header' }));
    this.listEl = root.createDiv({ cls: 'mpa-sidebar-list' });
    this.emptyEl = root.createDiv({ cls: 'mpa-sidebar-empty' });
    /* Quotes are measured again whenever the list changes width, including
       when a folded-away sidebar is opened out, which onResize alone may not
       report. */
    this.resizeObserver = new ResizeObserver(() => this.measureQuotes([...this.cards.values()]));
    this.resizeObserver.observe(this.listEl);
    /* A mouse button held down in the sidebar: a search is not reapplied
       until it is let go, so a card cannot vanish between press and click. */
    this.pressing = false;
    this.registerDomEvent(root, 'pointerdown', () => (this.pressing = true), { capture: true });
    this.registerDomEvent(window, 'pointerup', () => {
      if (!this.pressing) return;
      this.pressing = false;
      if (this.refilterPending) setTimeout(() => this.applyFilter(), 0);
      this.refilterPending = false;
    });
    this.doc = undefined;
    this.setDoc(this.plugin.focusDoc());
  }

  async onClose() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.cards.clear();
    this.listEl = null;
  }

  /* The sidebar's width changed, or it was shown: a quote fills a different
     number of lines than it did. */
  onResize() {
    this.measureQuotes([...this.cards.values()]);
  }

  buildHeader(header) {
    const box = header.createDiv({ cls: 'search-input-container mpa-search' });
    const input = (this.searchEl = box.createEl('input', {
      type: 'search',
      attr: { placeholder: 'Search annotations', spellcheck: 'false', enterkeyhint: 'search' },
    }));
    const clear = (this.searchClearEl = box.createDiv({
      cls: 'search-input-clear-button',
      attr: { 'aria-label': 'Clear search' },
    }));
    clear.hide();
    input.addEventListener('input', () => this.setQuery(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !input.value) return;
      e.preventDefault();
      e.stopPropagation();
      this.clearSearch();
    });
    clear.addEventListener('click', () => {
      this.clearSearch();
      input.focus();
    });

    this.sortEl = header.createDiv({ cls: 'clickable-icon mpa-sort' });
    this.sortEl.addEventListener('click', () => {
      this.plugin.setSidebarSort(this.plugin.settings.sidebarSort === 'date' ? 'position' : 'date');
    });
    this.updateSortButton();

    const exportEl = header.createDiv({
      cls: 'clickable-icon mpa-export',
      attr: { 'aria-label': 'Create a note from these annotations' },
    });
    setIcon(exportEl, 'file-plus');
    exportEl.addEventListener('click', () => {
      if (!this.doc) return;
      this.plugin.exportNote(this.doc).catch((e) => this.plugin.report('could not create the note', e));
    });
  }

  updateSortButton() {
    if (!this.sortEl) return;
    const byDate = this.plugin.settings.sidebarSort === 'date';
    setIcon(this.sortEl, byDate ? 'clock' : 'list-ordered');
    this.sortEl.setAttr(
      'aria-label',
      byDate
        ? 'In the order they were added. Click to list them in the order they appear.'
        : 'In the order they appear. Click to list them in the order they were added.'
    );
  }

  setQuery(query) {
    this.query = query;
    if (this.searchEl && this.searchEl.value !== query) this.searchEl.value = query;
    if (this.searchClearEl) this.searchClearEl.toggle(!!query);
    this.applyFilter();
  }

  clearSearch() {
    this.setQuery('');
  }

  searching() {
    return searchWords(this.query).length > 0;
  }

  /* Hides the cards that do not match the search. A card whose note is being
     typed in stays, even if what is typed stops it matching: it would
     otherwise vanish under the cursor. */
  applyFilter() {
    if (!this.listEl) return;
    const query = this.query;
    let shown = 0;
    for (const card of this.cards.values()) {
      const keep =
        !this.searching() ||
        document.activeElement === card.note ||
        matchesQuery(`${card.quoteText || ''}\n${card.note.value}`, query);
      card.el.toggleClass('mpa-hidden', !keep);
      if (keep) shown++;
    }
    /* Cards hidden when their quote last changed, or when the width did,
       could not be measured then. */
    this.measureQuotes([...this.cards.values()].filter((card) => card.unmeasured));
    const empty = !this.doc || !this.cards.size || !shown;
    this.emptyEl.toggle(empty);
    this.emptyEl.setText(
      !this.doc
        ? 'Open a PDF to see its annotations here.'
        : !this.cards.size
          ? 'No annotations yet. Turn on highlight mode and select some text.'
          : 'No annotations match.'
    );
  }

  /* Marks the quotes too long for five lines, which are cut there until
     clicked. Measured all at once, then marked, so the page is laid out once
     rather than once per card. A sidebar that is not on screen has nothing
     to measure; it is measured when it is shown. */
  measureQuotes(cards) {
    const found = [];
    for (const card of cards) {
      const quote = card.quote;
      if (!quote) continue;
      const line = quote.isConnected && quote.clientWidth ? parseFloat(getComputedStyle(quote).lineHeight) || 0 : 0;
      if (!line) {
        card.unmeasured = true;
        continue;
      }
      found.push([card, quote.scrollHeight > line * QUOTE_LINES + 1]);
    }
    for (const [card, long] of found) {
      card.unmeasured = false;
      card.long = long;
      card.el.toggleClass('is-long', long);
      card.el.toggleClass('is-expanded', long && !!card.expanded);
    }
  }

  setExpanded(card, expanded) {
    card.expanded = expanded;
    card.el.toggleClass('is-expanded', !!card.long && expanded);
  }

  /* Shows a different document, or refreshes the one already shown. */
  setDoc(doc) {
    if (!this.listEl) return;
    if (doc === this.doc) {
      this.refresh();
      return;
    }
    /* A note being typed belongs to the document being left. Filed now, while
       that is still the document in hand: emptying the list below takes the
       cursor out of the box, and by the time that is noticed, the sidebar
       would already be showing the other document. */
    if (this.doc && this.doc.editing) this.plugin.endNoteEdit(this.doc);
    this.doc = doc;
    this.selectedId = null;
    /* A search was for the document being left. */
    this.query = '';
    if (this.searchEl) this.searchEl.value = '';
    if (this.searchClearEl) this.searchClearEl.hide();
    this.listEl.empty();
    this.cards.clear();
    this.refresh();
  }

  items() {
    return this.doc ? annotationItems(this.doc.data, this.plugin.settings.sidebarSort) : [];
  }

  /* Brings the cards in line with the annotations, touching only what
     changed. Rebuilding the list wholesale would take the cursor out of a note
     being typed whenever anything else in the document changed. */
  refresh() {
    if (!this.listEl) return;
    const items = this.items();
    const wanted = new Set(items.map((item) => item.id));
    for (const [id, card] of this.cards) {
      if (wanted.has(id)) continue;
      card.el.remove();
      this.cards.delete(id);
    }

    let previous = null;
    const changed = [];
    for (const item of items) {
      let card = this.cards.get(item.id);
      const fresh = !card;
      if (fresh) {
        card = this.buildCard(item);
        this.cards.set(item.id, card);
      }
      /* Moved only when out of place: moving an element takes the focus out
         of anything inside it. */
      const slot = previous ? previous.el.nextSibling : this.listEl.firstChild;
      if (card.el !== slot) this.listEl.insertBefore(card.el, slot);
      if (this.updateCard(card, item) || fresh) changed.push(card);
      if (fresh) this.fit(card.note);
      previous = card;
    }
    this.measureQuotes(changed);
    this.applyFilter();
  }

  buildCard(item) {
    /** @type {Card} */
    const card = { id: item.id, kind: item.kind, doc: this.doc };
    /* The kind as its own class, kept apart from the card's parts: "mpa-card-note"
       is the note box inside every card. */
    const el = (card.el = createDiv({ cls: `mpa-card mpa-kind-${item.kind}` }));
    el.tabIndex = 0;
    el.dataset.id = item.id;

    const head = el.createDiv({ cls: 'mpa-card-head' });
    if (item.kind === 'highlight') {
      const words = head.createDiv({ cls: 'mpa-card-words' });
      card.quote = words.createDiv({ cls: 'mpa-card-quote' });
      card.quote.addEventListener('click', () => this.activate(card));
      const less = words.createDiv({ cls: 'mpa-card-less', text: 'Show less' });
      less.addEventListener('click', () => this.setExpanded(card, false));
    } else {
      /* A note of its own has no words to click, so its header does the same
         job: it takes you to where the note was put. */
      const label = head.createDiv({ cls: 'mpa-card-label', attr: { 'aria-label': 'Go to note' } });
      setIcon(label, 'sticky-note');
      label.addEventListener('click', () => this.activate(card));
    }

    const more = head.createDiv({ cls: 'mpa-card-more clickable-icon', attr: { 'aria-label': 'More' } });
    setIcon(more, 'more-horizontal');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openMenu(card, e);
    });

    card.note = el.createEl('textarea', {
      cls: 'mpa-card-note',
      attr: { placeholder: 'Add note', rows: '1' },
    });
    this.wireNote(card);

    el.addEventListener('keydown', (e) => {
      if (e.target !== el) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.plugin.deleteAnnotation(card.doc, card.id);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.activate(card);
      }
    });
    el.addEventListener('focusin', () => this.select(card.id));
    return card;
  }

  updateCard(card, item) {
    const settings = this.plugin.settings;
    const color = HEX_COLOR_RE.test(item.obj.color || '') ? item.obj.color : settings.highlightColor;
    card.el.style.setProperty('--mpa-color', color);
    card.el.toggleClass('is-selected', this.selectedId === card.id);

    let quoteChanged = false;
    if (card.quote) {
      const text = collapseWhitespace(item.obj.text || '');
      card.quoteText = text;
      if (card.quote.textContent !== text) {
        card.quote.setText(text);
        quoteChanged = true;
      }
    }

    /* A note being typed is left alone: what is in the box is newer than
       anything this could put there. */
    const note = item.kind === 'highlight' ? item.obj.note || '' : item.obj.text || '';
    if (document.activeElement !== card.note && card.note.value !== note) {
      card.note.value = note;
      this.fit(card.note);
    }
    card.note.readOnly = !!(this.doc && this.doc.readOnly);
    return quoteChanged;
  }

  /* A note box saves as it is typed in, as Zotero's does, with no button.
     Its undo keys step through the typing in pauses, like the rest of
     Obsidian, through a history of its own. Leaving the box files the whole
     edit as one step in the document's undo history. */
  wireNote(card) {
    const plugin = this.plugin;
    const field = card.note;
    /* The card's own document, not whatever the sidebar shows by the time an
       event arrives. */
    const doc = card.doc;
    const sync = () => {
      if (!doc) return;
      plugin.setNote(doc, card.id, field.value);
      this.fit(field);
    };
    /* Leaving a box whose note no longer matches the search hides it then,
       not while it is being typed in. */
    field.addEventListener('blur', () => {
      if (!this.searching()) return;
      if (this.pressing) this.refilterPending = true;
      else setTimeout(() => this.applyFilter(), 0);
    });
    field.addEventListener('focus', () => {
      plugin.noteFields.set(field, { history: new NoteHistory(field), sync });
      this.select(card.id);
    });
    field.addEventListener('input', () => {
      const entry = plugin.noteFields.get(field);
      if (entry) entry.history.record(Date.now());
      sync();
    });
    field.addEventListener('blur', () => {
      plugin.noteFields.delete(field);
      if (doc) plugin.endNoteEdit(doc);
    });
    /* Esc leaves the box. Focus does not move to the card: there, Delete and
       Backspace delete the whole annotation, and a Backspace pressed out of
       habit straight after Esc would take the highlight with it. */
    field.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      field.blur();
    });
  }

  /* Grows a note box to fit what is in it, where the browser cannot. */
  fit(field) {
    if (FIELD_SIZING || !field.isConnected) return;
    field.style.setProperty('--mpa-note-height', 'auto');
    field.style.setProperty('--mpa-note-height', `${field.scrollHeight}px`);
  }

  /* Clicking a card's words. In a search's results, that finds the card in
     the whole list; a long quote cut short opens out; otherwise it goes to
     the place in the document. */
  activate(card) {
    if (this.searching()) {
      this.clearSearch();
      this.showCard(card.id, { block: 'center' });
      return;
    }
    if (card.long && !card.expanded) {
      this.select(card.id);
      this.setExpanded(card, true);
      return;
    }
    this.select(card.id);
    this.plugin.navigateTo(card.doc, card.id);
  }

  select(id) {
    if (this.selectedId === id) return;
    const previous = this.cards.get(this.selectedId);
    if (previous) previous.el.removeClass('is-selected');
    this.selectedId = id;
    const card = this.cards.get(id);
    if (card) card.el.addClass('is-selected');
  }

  openMenu(card, e) {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(card.kind === 'highlight' ? 'Delete highlight' : 'Delete note')
        .setIcon('trash')
        .onClick(() => this.plugin.deleteAnnotation(card.doc, card.id))
    );
    menu.showAtMouseEvent(e);
  }

  /* Scrolls a card into view, briefly marks it, and optionally puts the
     cursor at the end of its note. */
  showCard(id, options) {
    const opts = options || {};
    this.refresh();
    const card = this.cards.get(id);
    if (!card) return;
    /* Something pointed to from the page is not left hidden by a search. */
    if (card.el.hasClass('mpa-hidden')) this.clearSearch();
    if (opts.select !== false) this.select(id);
    card.el.scrollIntoView({ block: opts.block || 'nearest' });
    card.el.removeClass('mpa-flash');
    void card.el.offsetWidth;
    card.el.addClass('mpa-flash');
    if (opts.focusNote) {
      card.note.focus();
      const end = card.note.value.length;
      card.note.setSelectionRange(end, end);
    }
  }
}

/* ----------------------------------------------------------------- helpers */

function round(n) {
  return Math.round(n * 10) / 10;
}

function describePoint(point) {
  return point ? `${round(point.x)}, ${round(point.y)}` : 'not recorded';
}

function charAt(chars, index) {
  return index >= 0 && index < chars.length ? chars[index].ch : '';
}

function blank(n) {
  return n === null || n === undefined ? '' : round(n);
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function pct(n) {
  return (typeof n === 'number' && isFinite(n) ? n * 100 : 0) + '%';
}

function pageNumberOf(pageEl) {
  const n = parseInt(pageEl.dataset.pageNumber || '', 10);
  return Number.isInteger(n) ? n : 1;
}

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  /* Only reached in a context without the Web Crypto API. Uniqueness within
     one PDF's annotations is all that is asked of it. */
  return 'mpa-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/* Keeps a box inside the window, with a margin. Shared by the opening
   placement and by dragging, so a box cannot be left somewhere it cannot be
   reached. */
const BOX_MARGIN = 8;
const BOX_GAP = 6;

function clampToViewport(left, top, size, viewport) {
  const widest = Math.max(BOX_MARGIN, viewport.width - size.width - BOX_MARGIN);
  const tallest = Math.max(BOX_MARGIN, viewport.height - size.height - BOX_MARGIN);
  return {
    left: Math.round(Math.min(Math.max(left, BOX_MARGIN), widest)),
    top: Math.round(Math.min(Math.max(top, BOX_MARGIN), tallest)),
  };
}

/* Where a note box opens: below everything it belongs to, so the words it
   refers to stay readable. A highlight near the bottom of the window would
   push the box out of view, so it flips above instead when there is no room
   beneath. Pure, so the arithmetic can be checked without a window. */
function placeBox(anchor, size, viewport) {
  let top = anchor.bottom + BOX_GAP;
  if (top + size.height + BOX_MARGIN > viewport.height) {
    const above = anchor.top - size.height - BOX_GAP;
    if (above >= BOX_MARGIN) top = above;
  }
  return clampToViewport(anchor.left, top, size, viewport);
}

/* Whether a stored zoom is something the viewer will accept, so a stale or
   hand-edited value cannot put a PDF into a strange state. */
function validZoom(value) {
  if (typeof value !== 'string' || !value) return false;
  if (ZOOM_WORDS.includes(value)) return true;
  const scale = Number(value);
  return Number.isFinite(scale) && scale >= 0.1 && scale <= 10;
}

/* The viewer behind a PDF view, or null.

   This reaches through Obsidian's PDF view into the PDF.js viewer it wraps,
   which is not part of the plugin API, so every step is checked and a shape we
   do not recognise simply means the zoom is not remembered. Nothing else
   depends on it. */
function pdfViewerOf(view) {
  const child = view && view.viewer && view.viewer.child;
  const wrapper = child && child.pdfViewer;
  const viewer = wrapper && wrapper.pdfViewer;
  return viewer && typeof viewer.currentScaleValue === 'string' ? viewer : null;
}

/* Keeps the most recently used entries and drops the rest. Objects keep their
   keys in insertion order, and a remembered zoom is deleted before being set
   again, so the order is least recently used first. */
function pruneZooms(zooms, limit) {
  const paths = Object.keys(zooms);
  for (const path of paths.slice(0, Math.max(0, paths.length - limit))) delete zooms[path];
  return zooms;
}

/* Undo inside a note box.

   A text box comes with the browser's own undo, which steps through a typed
   run one character at a time. The rest of Obsidian does not behave that way:
   CodeMirror starts a new undo step only when you pause, so a burst of typing
   comes back as a burst. Rather than leave the note box feeling foreign, this
   keeps its own history using CodeMirror's rule.

   The delay is CodeMirror's own default. */
const NOTE_GROUP_MS = 500;
const NOTE_UNDO_LIMIT = 100;

class NoteHistory {
  constructor(el) {
    this.el = el;
    /* The state the current group of keystrokes started from. */
    this.previous = this.capture();
    this.undoStack = [];
    this.redoStack = [];
    this.lastAt = 0;
  }

  capture() {
    return { value: this.el.value, caret: this.el.selectionEnd };
  }

  /* Called after every change to the text. A new undo step begins only when
     the typing has paused; otherwise this keystroke joins the one before it. */
  record(at) {
    if (at - this.lastAt >= NOTE_GROUP_MS) {
      this.undoStack.push(this.previous);
      while (this.undoStack.length > NOTE_UNDO_LIMIT) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    this.lastAt = at;
    this.previous = this.capture();
  }

  undo() {
    return this.step(this.undoStack, this.redoStack);
  }

  redo() {
    return this.step(this.redoStack, this.undoStack);
  }

  step(from, to) {
    if (!from.length) return false;
    const entry = from.pop();
    to.push(this.capture());
    this.el.value = entry.value;
    if (this.el.setSelectionRange) this.el.setSelectionRange(entry.caret, entry.caret);
    this.previous = { value: entry.value, caret: entry.caret };
    /* Whatever is typed next starts a group of its own. */
    this.lastAt = 0;
    return true;
  }
}

/* A copy of the annotations as they stand, for the undo history.

   Deliberately the whole lot rather than a description of what changed. A
   PDF's annotations are a few kilobytes, so copying them is cheap, and a
   restore that puts back a known-good state cannot get the bookkeeping wrong
   the way an inverse operation can.

   Only the annotations themselves: anything else a sidecar might carry is
   not part of what an undo restores. */
function snapshot(data) {
  return {
    highlights: JSON.parse(JSON.stringify(data.highlights || [])),
    notes: JSON.parse(JSON.stringify(data.notes || [])),
  };
}

/* FNV-1a over the text, with the length appended. Enough to answer "is this
   file still the one we wrote", which is all it is used for. */
function stamp(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}-${text.length}`;
}

/* The box an absolutely positioned child with `inset: 0` is laid out against:
   the page's padding box.

   This is not getBoundingClientRect(). Obsidian gives .page a transparent
   border that scales with the zoom level, and the bounding rect includes it
   while our overlay layer is positioned inside it. Measuring against the outer
   box put every highlight a few pixels off centre and left a gap at the start
   and end of each line, widening as you zoomed in. */
function pagePaddingBox(pageEl) {
  const rect = pageEl.getBoundingClientRect();
  const style = getComputedStyle(pageEl);
  const left = parseFloat(style.borderLeftWidth) || 0;
  const right = parseFloat(style.borderRightWidth) || 0;
  const top = parseFloat(style.borderTopWidth) || 0;
  const bottom = parseFloat(style.borderBottomWidth) || 0;
  const width = rect.width - left - right;
  const height = rect.height - top - bottom;
  if (width <= 0 || height <= 0) return null;
  return { left: rect.left + left, top: rect.top + top, width, height };
}

/* ------------------------------------------------------- the character model

   A highlight is cut from one array of characters, each carrying the rectangle
   the browser reports for it. The text stored and the rectangles drawn are
   both slices of that array, so they cannot describe different characters.

   The earlier design read the text from character offsets and the rectangles
   from the browser's own selection geometry. Those are two answers to the same
   question, and they disagreed by a glyph: a highlight would stretch over a
   full stop the stored text left out, or the text would carry one the
   highlight did not cover. Zotero avoids this by keeping its own character
   positions and taking both answers from one of them. This is the same idea,
   measured through the DOM instead of through the PDF's font metrics. */

/* The text nodes of one page's text layer that a range touches, plus one on
   either side. The margin matters because a boundary gets nudged below, and
   may land just outside the nodes the browser thought were involved. */
function involvedNodes(range, textLayer) {
  const all = [];
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode()) !== null) all.push(node);

  let first = -1;
  let last = -1;
  for (let i = 0; i < all.length; i++) {
    if (!range.intersectsNode(all[i])) continue;
    if (first === -1) first = i;
    last = i;
  }
  if (first === -1) return { nodes: [], touched: new Set() };

  const nodes = all.slice(Math.max(0, first - 1), Math.min(all.length, last + 2));
  const touched = new Set(all.slice(first, last + 1));
  return { nodes, touched };
}

/* Every character of those nodes, with its own rectangle. One Range is reused
   for the measuring, and nothing is mutated in between, so the whole array
   costs a single layout. */
function buildChars(involved) {
  const chars = [];
  const measure = document.createRange();

  for (const node of involved.nodes) {
    const value = node.nodeValue || '';
    const placed = measurable(node).ok;
    const touched = involved.touched.has(node);
    for (let i = 0; i < value.length; i++) {
      measure.setStart(node, i);
      measure.setEnd(node, i + 1);
      chars.push({
        ch: value[i],
        node,
        touched,
        box: placed ? unionRect(measure.getClientRects()) : null,
      });
    }
  }
  return chars;
}

/* Two characters are on the same line when their vertical centres are within
   roughly half a line height of each other. Used to stop anything reaching
   across a line break, where a PDF leaves no space character to stop at. */
function sameLine(a, b) {
  if (!a || !b || !a.box || !b.box) return false;
  const centreA = (a.box.top + a.box.bottom) / 2;
  const centreB = (b.box.top + b.box.bottom) / 2;
  const height = Math.min(a.box.bottom - a.box.top, b.box.bottom - b.box.top);
  return Math.abs(centreA - centreB) <= Math.max(3, height * 0.6);
}

/* Where a boundary between two characters sits on the screen. */
function boundaryPosition(chars, index) {
  const before = index > 0 ? chars[index - 1] : null;
  const after = index < chars.length ? chars[index] : null;
  if (before && before.box) {
    return { x: before.box.right, top: before.box.top, bottom: before.box.bottom };
  }
  if (after && after.box) {
    return { x: after.box.left, top: after.box.top, bottom: after.box.bottom };
  }
  return null;
}

/* The index in `chars` of a range or selection boundary, or -1 when that
   boundary is not in this page's characters at all. */
function indexOfBoundary(chars, container, offset) {
  if (!container || container.nodeType !== 3) return -1;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i].node === container) return i + Math.min(offset, (container.nodeValue || '').length);
  }
  return -1;
}

/* The first and last boundary of the part of the selection that lies on this
   page, for when one or both of its ends are on another page. */
function touchedBounds(chars) {
  let from = -1;
  let to = -1;
  for (let i = 0; i < chars.length; i++) {
    if (!chars[i].touched) continue;
    if (from === -1) from = i;
    to = i + 1;
  }
  return from === -1 ? null : { from, to };
}

const BOUNDARY_WINDOW = 4;

/* Moves a boundary to whichever nearby one is actually closest to the pointer.

   The viewer stretches each span of text horizontally to match the document's
   own letter spacing, and the browser picks a character boundary using the
   unstretched metrics, so its answer can sit a glyph away from where the
   pointer was. Comparing the pointer against the real positions of the
   boundaries around it puts that right, and is why a full stop is now either
   highlighted and transcribed or neither. */
function refineBoundary(chars, index, point) {
  if (!point || index < 0) return index;
  const lo = Math.max(0, index - BOUNDARY_WINDOW);
  const hi = Math.min(chars.length, index + BOUNDARY_WINDOW);

  let best = index;
  let bestDistance = Infinity;
  for (let i = lo; i <= hi; i++) {
    const at = boundaryPosition(chars, i);
    /* Only boundaries on the pointer's own line are candidates. */
    if (!at || point.y < at.top - 2 || point.y > at.bottom + 2) continue;
    const distance = Math.abs(at.x - point.x);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/* Which of the drag's two ends to judge a boundary against. A drag made
   backwards, or one whose other end is on another page, sorts itself out. */
function nearestPointer(chars, index, pointers) {
  const at = boundaryPosition(chars, index);
  if (!at) return null;
  const distance = (p) =>
    p ? Math.abs(at.x - p.x) + Math.abs((at.top + at.bottom) / 2 - p.y) : Infinity;
  const down = distance(pointers.down);
  const up = distance(pointers.up);
  if (down === Infinity && up === Infinity) return null;
  return down <= up ? pointers.down : pointers.up;
}

const WORD_CHAR_RE = /[\p{L}\p{N}'’]/u;

function isWordChar(char) {
  return !!char && WORD_CHAR_RE.test(char.ch);
}

/* Whether a boundary falls strictly inside a word, with a word character on
   both sides of it and both on the same line. A boundary already in the
   whitespace between two words is left alone: widening it would reach into the
   word next door, so starting a drag in the gap before a word would silently
   take the word before that as well. */
function insideWord(chars, index) {
  if (index <= 0 || index >= chars.length) return false;
  const before = chars[index - 1];
  const after = chars[index];
  return isWordChar(before) && isWordChar(after) && sameLine(before, after);
}

/* Widens a boundary so it does not sit in the middle of a word. */
function snapStart(chars, index) {
  let i = index;
  if (!insideWord(chars, i)) return i;
  while (i > 0 && isWordChar(chars[i - 1]) && sameLine(chars[i - 1], chars[i])) i--;
  return i;
}

function snapEnd(chars, index) {
  let i = index;
  if (!insideWord(chars, i)) return i;
  while (i < chars.length && isWordChar(chars[i]) && sameLine(chars[i - 1], chars[i])) i++;
  return i;
}

/* The slice of `chars` this page contributes to the highlight. */
function selectedSlice(chars, range, pointers, snap) {
  const bounds = touchedBounds(chars);
  if (!bounds) return null;

  let from = bounds.from;
  let to = bounds.to;

  const startIndex = indexOfBoundary(chars, range.startContainer, range.startOffset);
  if (startIndex !== -1) from = refineBoundary(chars, startIndex, nearestPointer(chars, startIndex, pointers));
  const endIndex = indexOfBoundary(chars, range.endContainer, range.endOffset);
  if (endIndex !== -1) to = refineBoundary(chars, endIndex, nearestPointer(chars, endIndex, pointers));

  if (to < from) {
    const swap = from;
    from = to;
    to = swap;
  }
  if (snap) {
    from = snapStart(chars, from);
    to = snapEnd(chars, to);
  }
  from = Math.max(0, from);
  to = Math.min(chars.length, to);
  return to > from ? { from, to } : null;
}

/* The selected characters grouped into lines, each with the rectangle covering
   it and the text it reads as. A character the viewer gives no position to
   contributes its text to whichever line is being built; if it sits between
   two that do have positions, the line's rectangle covers it anyway. */
function linesFromChars(chars, from, to) {
  const lines = [];
  let current = null;

  for (let i = from; i < to; i++) {
    const char = chars[i];
    if (!char.box) {
      if (!current) lines.push((current = { box: null, chars: [] }));
      current.chars.push(char);
      continue;
    }

    const centre = (char.box.top + char.box.bottom) / 2;
    const height = char.box.bottom - char.box.top;
    const fits =
      current &&
      current.box &&
      Math.abs(centre - (current.box.top + current.box.bottom) / 2) <=
        Math.max(3, Math.min(current.box.bottom - current.box.top, height) * 0.6);

    if (!fits) {
      lines.push((current = { box: Object.assign({}, char.box), chars: [char] }));
      continue;
    }
    current.box.left = Math.min(current.box.left, char.box.left);
    current.box.right = Math.max(current.box.right, char.box.right);
    current.box.top = Math.min(current.box.top, char.box.top);
    current.box.bottom = Math.max(current.box.bottom, char.box.bottom);
    current.chars.push(char);
  }

  return lines.map((line) => ({
    text: textOfChars(line.chars),
    left: line.box ? line.box.left : null,
    top: line.box ? line.box.top : null,
    width: line.box ? line.box.right - line.box.left : null,
    height: line.box ? line.box.bottom - line.box.top : null,
  }));
}

/* A PDF's text layer carries no spaces between its spans, so where two spans
   sit apart on the page the gap between them was a space on the page too.
   Reading the text without putting those back ran words together: "in
   theexperience of loneliness". Characters within one span are taken as they
   come, since the viewer stretches a span's letters apart and the gaps inside
   it say nothing. */
function textOfChars(chars) {
  let out = '';
  let previous = null;
  for (const char of chars) {
    if (previous && previous.node !== char.node && previous.box && char.box) {
      const gap = char.box.left - previous.box.right;
      const height = Math.min(
        previous.box.bottom - previous.box.top,
        char.box.bottom - char.box.top
      );
      const spaced = /\s$/.test(out) || /^\s/.test(char.ch);
      if (!spaced && gap > Math.max(1, height * 0.2)) out += ' ';
    }
    out += char.ch;
    previous = char;
  }
  return out;
}

/* Whether a text node's position on the page means anything.

   Obsidian's stylesheet gives a tagged PDF's structural spans `height: 0`, and
   pins the viewer's selection helper to the top of the page while a drag is in
   progress. Text inside either one measures as a box in the page's top-left
   corner, and those boxes were being drawn: two of them, one per page, on a
   selection that crossed a page break. The text in such a span still counts.
   Its position does not. */
function measurable(node) {
  const el = node.parentElement;
  if (!el) return { ok: false, where: 'no parent element' };

  const tag = el.tagName.toLowerCase();
  const cls = el.className ? `.${String(el.className).trim().split(/\s+/).join('.')}` : '';
  const where = tag + cls;

  if (el.classList.contains('markedContent')) return { ok: false, where: `${where} (zero height)` };
  if (el.closest('.endOfContent')) return { ok: false, where: `${where} (selection helper)` };
  const style = getComputedStyle(el);
  if (style.userSelect === 'none' || style.webkitUserSelect === 'none') {
    return { ok: false, where: `${where} (not selectable)` };
  }
  if (parseFloat(style.height) === 0) return { ok: false, where: `${where} (zero height)` };
  return { ok: true, where };
}

function unionRect(rectList) {
  let out = null;
  for (const r of rectList) {
    if (r.width < 0.5 || r.height < 0.5) continue;
    if (!out) out = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    else {
      out.left = Math.min(out.left, r.left);
      out.top = Math.min(out.top, r.top);
      out.right = Math.max(out.right, r.right);
      out.bottom = Math.max(out.bottom, r.bottom);
    }
  }
  return out;
}

/* Running headers, page numbers and footers are set off from the body text by
   whitespace. A line that sits on its own, far above or far below everything
   else selected on the page, is one of those rather than part of the sentence
   being highlighted.

   The test is vertical, but the lines keep their reading order: a PDF may draw
   its header at any point in the content stream, so the stray line is not
   necessarily first or last in the selection. That is why the sort below is on
   a copy.

   Deliberately timid: at most two lines from either extreme, and only for a
   gap of more than two and a half line heights, which is wider than any
   paragraph break. Dropping real text would be much worse than leaving a page
   number in, so a two-column page, where the next column begins far above the
   end of the previous one, has to survive this untouched. It does, because
   those lines are contiguous with each other. */
function dropRunningHeads(lines) {
  const measured = lines.filter((line) => line.top !== null);
  if (measured.length < 3) return lines;

  const sorted = measured.slice().sort((a, b) => a.top - b.top);
  const heights = sorted.map((line) => line.height).sort((a, b) => a - b);
  const limit = Math.max(heights[heights.length >> 1] * 2.5, 8);
  const detached = (above, below) => below.top - (above.top + above.height) > limit;

  const drop = new Set();
  let lo = 0;
  let hi = sorted.length - 1;
  for (let n = 0; n < 2 && hi - lo >= 2; n++) {
    if (!detached(sorted[lo], sorted[lo + 1])) break;
    drop.add(sorted[lo++]);
  }
  for (let n = 0; n < 2 && hi - lo >= 2; n++) {
    if (!detached(sorted[hi - 1], sorted[hi])) break;
    drop.add(sorted[hi--]);
  }

  return drop.size ? lines.filter((line) => !drop.has(line)) : lines;
}

/* Highlights used to carry one page number for the whole annotation, which
   meant a selection crossing a page break had to be stored as two separate
   highlights and removed twice. Each rectangle now names its own page, so the
   annotation is one thing again. Older files are brought forward on read. */
function migrateHighlight(highlight) {
  const rects = highlight.rects || [];
  if (!rects.length || rects[0].page !== undefined) return highlight;
  const page = typeof highlight.page === 'number' ? highlight.page : 1;
  const migrated = Object.assign({}, highlight, {
    rects: rects.map((rect) => Object.assign({ page }, rect)),
  });
  delete migrated.page;
  return migrated;
}

/* Every annotation on a document as a flat, ordered list, which is what the
   sidebar shows and an exported note follows. 'position' is reading order: page,
   then down the page. 'date' is the order they were made in, oldest first. */
function annotationItems(data, sort) {
  const items = [];
  for (const h of (data && data.highlights) || []) {
    const first = firstRect(h);
    items.push({
      id: h.id,
      kind: 'highlight',
      obj: h,
      order: first ? [first.page, first.y, first.x] : [0, 0, 0],
      createdAt: h.createdAt || '',
    });
  }
  for (const n of (data && data.notes) || []) {
    const p = n.position || {};
    items.push({
      id: n.id,
      kind: 'note',
      obj: n,
      order: [n.page || 0, p.y || 0, p.x || 0],
      createdAt: n.createdAt || '',
    });
  }
  const byPosition = (a, b) => compareOrder(a.order, b.order);
  const byDate = (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : byPosition(a, b));
  return items.sort(sort === 'date' ? byDate : byPosition);
}

/* Searching annotations. Fuzzy, but word by word: every word typed has to
   be found in some word of the annotation, as part of it or with a slip or
   two (a letter missed, added, changed or swapped; one for words of four to
   six letters, two for longer ones; none for three letters or fewer).
   Matching letters scattered anywhere across a long passage, as fuzzy
   finders for file names do, would let almost any short search match every
   highlight. Accents and case are ignored. */
function searchWords(text) {
  return (
    String(text || '')
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) || []
  );
}

function wordMatches(typed, word) {
  if (word.includes(typed)) return true;
  const slips = typed.length <= 3 ? 0 : typed.length <= 6 ? 1 : 2;
  if (!slips) return false;
  /* Against the start of the word, so a word typed partway still matches. */
  for (let len = typed.length - slips; len <= typed.length + slips; len++) {
    if (len < 1 || len > word.length) continue;
    if (editDistance(typed, word.slice(0, len), slips) <= slips) return true;
  }
  return false;
}

/* Edits between two words, counting a swap of neighbouring letters as one.
   Gives up, returning more than `limit`, as soon as that is certain. */
function editDistance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      row.push(d);
      if (d < best) best = d;
    }
    if (best > limit) return limit + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

function matchesQuery(text, query) {
  const typed = searchWords(query);
  if (!typed.length) return true;
  const words = searchWords(text);
  return typed.every((t) => words.some((w) => wordMatches(t, w)));
}

function compareOrder(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

function findAnnotation(data, id) {
  const h = ((data && data.highlights) || []).find((x) => x.id === id);
  if (h) return { kind: 'highlight', obj: h };
  const n = ((data && data.notes) || []).find((x) => x.id === id);
  return n ? { kind: 'note', obj: n } : null;
}

/* Where to take the reader for an annotation: its page, and how far down. */
function annotationTarget(data, id) {
  const found = findAnnotation(data, id);
  if (!found) return null;
  if (found.kind === 'highlight') {
    const first = firstRect(found.obj);
    return first ? { page: first.page, y: first.y } : null;
  }
  const p = found.obj.position || {};
  return { page: found.obj.page || 1, y: p.y || 0 };
}

/* How long an annotation is pointed out for after navigating to it, which is
   also the length of the animation in styles.css. */
const FLASH_MS = 1200;

/* Whether an annotation is being pointed out after navigating to it. */
function flashing(state, id) {
  return !!(state.flash && state.flash.id === id && Date.now() < state.flash.until);
}

/* How far into its animation a pointed-out annotation is. The page redraws
   several times while it scrolls into place, replacing these elements, and a
   fresh element would otherwise start its animation again from the top. */
function flashElapsed(state, id) {
  if (!flashing(state, id)) return null;
  return Math.max(0, Date.now() - (state.flash.since || Date.now()));
}

function markFlash(el, state, id) {
  const elapsed = flashElapsed(state, id);
  if (elapsed === null) return;
  el.style.setProperty('--mpa-flash-delay', `-${elapsed}ms`);
  el.addClass('mpa-flash');
}

/* The PDF.js viewer behind a PDF view, without the zoom check pdfViewerOf
   makes: navigation needs the viewer even before a zoom has been set. */
function pdfInnerOf(view) {
  const child = view && view.viewer && view.viewer.child;
  const wrapper = child && child.pdfViewer;
  return (wrapper && wrapper.pdfViewer) || null;
}

/* Where a highlight starts: the earliest page it touches, and the topmost
   rectangle on that page. Used for ordering it and for
   placing its note marker. */
function firstRect(highlight) {
  let best = null;
  for (const rect of highlight.rects || []) {
    if (!best || rect.page < best.page || (rect.page === best.page && rect.y < best.y)) best = rect;
  }
  return best;
}

/* The note made by the sidebar's export button: every annotation in reading
   order, laid out as the settings say. Pure, so it can be checked without a
   vault.

   Built as a list of blocks, each a bullet, a line or a paragraph, and then
   joined: bullets follow bullets and lines follow lines directly; anything
   else gets a blank line between, since a line straight after a bullet would
   be read as part of that bullet. */
function renderExport(data, settings) {
  const opts = Object.assign({}, EXPORT_DEFAULTS, settings);
  const marks = QUOTE_MARKS[opts.quoteMarks] || QUOTE_MARKS.double;
  const blocks = [];

  for (const { kind, obj } of annotationItems(data, 'position')) {
    if (kind === 'highlight') {
      const quote = collapseWhitespace(obj.text || '');
      if (!quote) continue;
      const shape = LAYOUT_SHAPES[opts.highlightLayout] || 'bullet';
      const words = marks[0] + quote + marks[1];
      const note = (obj.note || '').trim();
      if (!note) {
        blocks.push({ shape, text: words });
      } else if (opts.noteLayout === 'same-line') {
        blocks.push({ shape, text: `${words} ${note}` });
      } else if (opts.noteLayout === 'line') {
        blocks.push({ shape, text: `${words}\n${note}` });
      } else if (opts.noteLayout === 'paragraph') {
        blocks.push({ shape, text: words });
        blocks.push({ shape: 'paragraph', text: note });
      } else if (shape === 'bullet') {
        /* Indented under the highlight's own bullet. */
        blocks.push({ shape, text: words, children: [note] });
      } else {
        /* Nothing to indent under: a bullet of its own straight beneath. */
        blocks.push({ shape, text: words });
        blocks.push({ shape: 'bullet', text: note });
      }
    } else {
      const text = (obj.text || '').trim();
      if (!text) continue;
      blocks.push({ shape: LAYOUT_SHAPES[opts.looseNoteLayout] || 'bullet', text });
    }
  }

  let md = '';
  let previous = null;
  for (const block of blocks) {
    if (previous) md += previous.shape === block.shape && block.shape !== 'paragraph' ? '\n' : '\n\n';
    md += formatBlock(block);
    previous = block;
  }
  return md ? md + '\n' : '';
}

const EXPORT_DEFAULTS = {
  quoteMarks: 'double',
  highlightLayout: 'bullets',
  noteLayout: 'indented-bullet',
  looseNoteLayout: 'bullets',
};

const QUOTE_MARKS = {
  single: ["'", "'"],
  double: ['"', '"'],
  none: ['', ''],
};

const LAYOUT_SHAPES = { bullets: 'bullet', lines: 'line', paragraphs: 'paragraph' };

/* Every line is escaped: one starting with a quotation mark never needs it,
   and any other could be someone's text that happens to look like markdown. */
function formatBlock(block) {
  const lines = block.text.split(/\r?\n/).map(escapeLineStart);
  if (block.shape !== 'bullet') return lines.join('\n');
  let out = `- ${lines[0]}`;
  for (const line of lines.slice(1)) out += line ? `\n\t${line}` : '\n';
  for (const child of block.children || []) {
    const childLines = child.split(/\r?\n/).map(escapeLineStart);
    out += `\n\t- ${childLines[0]}`;
    for (const line of childLines.slice(1)) out += line ? `\n\t\t${line}` : '\n';
  }
  return out;
}

/* A line of someone's text that happens to start like markdown, "# 1" or
   "- 5" or "1. Introduction" or "> said", would otherwise become a heading,
   a list or a quote. A backslash only escapes punctuation, so a number keeps
   its digits and has the full stop after it escaped instead. */
function escapeLineStart(line) {
  const numbered = /^(\d+)([.)])(\s|$)/.exec(line);
  if (numbered) return `${numbered[1]}\\${line.slice(numbered[1].length)}`;
  return /^(#{1,6}(\s|$)|[-+*](\s|$)|>)/.test(line) ? `\\${line}` : line;
}

/* A highlight's text arrives with the PDF's own line breaks in it, which are
   an artefact of the layout rather than the sentence. */
function collapseWhitespace(s) {
  return s.replace(/\s+/g, ' ').trim();
}

module.exports = MinimalPdfAnnotatorPlugin;

/**
 * @typedef {Object} DocState
 * @property {TFile} file                      the PDF
 * @property {{highlights: any[], notes: any[]}} data
 * @property {boolean} readOnly                the sidecar would not parse
 * @property {Promise<void>} saveChain         serialises writes to the sidecar
 * @property {string | null} sidecarStamp      what we last wrote, to tell our
 *                                             own saves from someone else's
 * @property {{highlights: any[], notes: any[]}} baseline
 * @property {{state: object, label: string}[]} undoStack
 * @property {{state: object, label: string}[]} redoStack
 *
 * @typedef {Object} ViewState
 * @property {object} view
 * @property {HTMLElement} container
 * @property {DocState | null} doc
 * @property {MutationObserver | null} observer
 * @property {number} frame                   pending animation-frame redraw
 * @property {string | null} pendingZoom       a remembered zoom not yet applied
 * @property {{id: string, until: number}} [flash] an annotation being pointed out
 *
 * @typedef {Object} Card
 * @property {string} id
 * @property {'highlight' | 'note'} kind
 * @property {HTMLElement} el
 * @property {HTMLElement} [quote]
 * @property {HTMLTextAreaElement} note
 * @property {DocState | null} doc  the document the card was built for
 */
