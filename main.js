'use strict';

/*
 * Finally, A Reader.
 *
 * Select text in a PDF with highlight mode on and it is highlighted. The
 * annotations sidebar lists every highlight and note on the document in front
 * of you: click a card's words to go to them, type in its
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
  Notice,
  TFile,
  Platform,
  debounce,
  setIcon,
  normalizePath,
  ItemView,
  FileView,
} = require('obsidian');

const DEFAULT_SETTINGS = {
  /* The colour highlight mode uses: always the first colour in the menu. */
  highlightColor: '#ffeb3b',
  /* Highlight colours. Those in the menu are offered, in this order, when
     text is selected or right-clicked; the spares wait in the settings until
     moved into it. */
  menuColours: ['#ffeb3b'],
  spareColours: ['#a8e6a1', '#9fd3ff'],
  snapToWords: true,
  rememberZoom: true,
  /* 'position' or 'date'. */
  sidebarSort: 'position',
  /* How the note made from the annotations is laid out. See renderExport. */
  quoteMarks: 'double',
  highlightLayout: 'bullets',
  noteLayout: 'indented-bullet',
  looseNoteLayout: 'bullets',
  /* macOS only: Look Up in the right-click menu. */
  lookUp: false,
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

/* The plugin's own EPUB reader. */
const EPUB_VIEW_TYPE = 'mpa-epub';

/* An EPUB's text size, per book and per device like a PDF's zoom, as a
   percentage of the normal size. */
const TEXT_SIZE_STORE_KEY = 'epub-text-size';
const TEXT_SIZES = [70, 80, 90, 100, 110, 120, 135, 150, 175, 200, 250, 300];

/* A book page's line length at 100%, in ems, when the tab is wide enough. */
const EPUB_LINE_EMS = 44;

/* Where each book was left, per device, as [chapter, offset]. */
const PLACE_STORE_KEY = 'epub-place';

class FinallyAReaderPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    /* Per PDF: the annotations, and the lock that serialises writes to them.
       Keyed by path, because two leaves can show the same PDF and must not
       each keep their own copy of the data. */
    /** @type {Map<string, DocState>} */
    this.docs = new Map();
    /* Annotations files on their way to a renamed document's new name. */
    this.renaming = new Map();
    /* Documents whose annotations could not follow a rename: their old file. */
    this.leftBehind = new Map();
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
    this.textSizes = this.readTextSizes();
    this.places = this.readPlaces();
    this.savePlaces = debounce(() => this.writePlaces(), 1000, false);
    this.registerView(EPUB_VIEW_TYPE, (leaf) => new EpubView(leaf, this));
    try {
      this.registerExtensions(['epub'], EPUB_VIEW_TYPE);
    } catch (e) {
      /* Another plugin already opens EPUBs. */
      this.report('could not take on .epub files; another plugin may already open them', e);
    }
    this.registerEvent(
      this.app.workspace.on('css-change', () => {
        for (const state of this.views.values()) if (state.kind === 'epub') state.view.applyTheme();
      })
    );

    this.ribbonEl = this.addRibbonIcon('highlighter', 'Toggle highlight mode', () =>
      this.toggleHighlightMode()
    );

    /* A status bar toggle as well, so the feature is still reachable when the
       ribbon is hidden. */
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('mpa-status');
    this.statusEl.setAttribute('aria-label', 'Toggle highlight mode');
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

    this.addSettingTab(new FinallyAReaderSettingTab(this.app, this));
    this.removeOldHelpFile().catch((e) => this.report('could not tidy away the old help file', e));

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile) {
          this.reloadSidecar(file).catch((e) => this.report('could not reload annotations', e));
        }
      })
    );
    /* A document renamed or moved takes its annotations with it. */
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile) {
          this.followRename(file, oldPath).catch((e) => this.report('could not move the annotations of a renamed file', e));
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

    this.footnotes = new FootnotePreview(this);
    this.selectionBar = new SelectionBar(this);
    /* Every window: the main one, any pop-out already open, and each one
       opened from now on. */
    this.windows = new Set();
    this.listenTo(document);
    this.app.workspace.iterateAllLeaves((leaf) => {
      const doc = leaf.view && leaf.view.containerEl && leaf.view.containerEl.ownerDocument;
      if (doc) this.listenTo(doc);
    });
    this.registerEvent(this.app.workspace.on('window-open', (_workspaceWindow, win) => this.listenTo(win.document)));
    this.registerEvent(this.app.workspace.on('window-close', (_workspaceWindow, win) => this.windows.delete(win.document)));
  }

  /* Document-level handlers, so events are caught however Obsidian's PDF
     viewer wires its own listeners. Each one works out which view the event
     happened in, if any. mouseup bubbles, so the browser has settled the text
     selection by the time it is read; click and contextmenu are captured so
     nothing swallows them first. A pop-out window is a document of its own,
     so each one gets its own set. */
  listenTo(doc) {
    if (!doc || this.windows.has(doc)) return;
    this.windows.add(doc);
    this.registerDomEvent(doc, 'keydown', (e) => this.onKeyDown(e), true);
    this.registerDomEvent(doc, 'mousedown', (e) => this.onMouseDown(e));
    this.registerDomEvent(doc, 'mouseup', (e) => this.onMouseUp(e));
    this.registerDomEvent(doc, 'click', (e) => this.onClick(e), true);
    this.registerDomEvent(doc, 'contextmenu', (e) => this.onContextMenu(e), true);

    /* The selection bar and footnote previews: anything that moves the page,
       or any click outside them, puts them away. */
    this.registerDomEvent(doc, 'mousedown', (e) => {
      if (!this.selectionBar.contains(e.target)) this.selectionBar.hide();
      this.footnotes.pressed(e);
      for (const sidebar of this.sidebars()) sidebar.pressedElsewhere(e);
    }, true);
    this.registerDomEvent(doc, 'wheel', () => {
      this.selectionBar.hide();
      this.footnotes.hide();
    }, { capture: true, passive: true });
    this.registerDomEvent(doc, 'keydown', (e) => {
      this.selectionBar.hide();
      /* Not for a modifier on its own: Cmd is the start of Cmd+Z. */
      if (!['Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) this.footnotes.hide();
    }, true);
    this.registerDomEvent(doc, 'mouseover', (e) => this.footnotes.over(e));
    this.registerDomEvent(doc, 'mouseout', (e) => this.footnotes.out(e));
    this.applyModeColor();
    doc.body.toggleClass('mpa-mode-active', this.highlightMode);
  }

  onunload() {
    if (this.syncTimer) window.clearTimeout(this.syncTimer);
    /* A place in a book noted in the last second is kept. */
    if (this.places) this.writePlaces();
    if (this.footnotes) this.footnotes.hide();
    if (this.selectionBar) this.selectionBar.hide();
    for (const state of this.views.values()) this.syncZoom(state);
    /* Typing still waiting to be saved is saved now rather than dropped. */
    for (const doc of this.docs.values()) {
      if (!doc.saveTimer) continue;
      window.clearTimeout(doc.saveTimer);
      doc.saveTimer = null;
      this.queueSave(doc);
    }
    for (const doc of this.windows || [document]) {
      doc.body.removeClass('mpa-mode-active');
      doc.body.style.removeProperty('--mpa-mode-color');
    }
    for (const view of Array.from(this.views.keys())) this.teardownView(view);
    this.views.clear();
    this.docs.clear();
  }

  report(what, error) {
    const message = `Finally, A Reader: ${what}`;
    if (error === undefined) console.error(message);
    else console.error(message, error);
  }

  /* ----------------------------------------------------------------- modes */

  applyModeColor() {
    for (const doc of this.windows || [document]) doc.body.style.setProperty('--mpa-mode-color', this.settings.highlightColor);
  }

  toggleHighlightMode() {
    if (this.selectionBar) this.selectionBar.hide();
    this.highlightMode = !this.highlightMode;
    for (const doc of this.windows || [document]) doc.body.toggleClass('mpa-mode-active', this.highlightMode);
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

  readTextSizes() {
    const out = {};
    let stored = null;
    try {
      stored = this.app.loadLocalStorage(TEXT_SIZE_STORE_KEY);
    } catch (e) {
      return out;
    }
    if (!stored || typeof stored !== 'object') return out;
    for (const path of Object.keys(stored)) {
      if (validTextSize(stored[path])) out[path] = stored[path];
    }
    return out;
  }

  readPlaces() {
    const out = {};
    let stored = null;
    try {
      stored = this.app.loadLocalStorage(PLACE_STORE_KEY);
    } catch (e) {
      return out;
    }
    if (!stored || typeof stored !== 'object') return out;
    for (const path of Object.keys(stored)) {
      const at = stored[path];
      if (Array.isArray(at) && at.length === 2 && at.every((n) => Number.isInteger(n) && n >= 0)) out[path] = at;
    }
    return out;
  }

  notePlace(path, at) {
    delete this.places[path];
    this.places[path] = at;
    pruneZooms(this.places, ZOOM_LIMIT);
    this.savePlaces();
  }

  writePlaces() {
    try {
      this.app.saveLocalStorage(PLACE_STORE_KEY, this.places);
    } catch (e) {
      this.report('could not save the place in a book', e);
    }
  }

  noteTextSize(path, value) {
    if (!validTextSize(value)) return;
    delete this.textSizes[path];
    if (value !== 100) this.textSizes[path] = value;
    pruneZooms(this.textSizes, ZOOM_LIMIT);
    try {
      this.app.saveLocalStorage(TEXT_SIZE_STORE_KEY, this.textSizes);
    } catch (e) {
      this.report('could not save the text size', e);
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
    if (this.syncTimer) return;
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      this.syncViews();
    }, 100);
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
    /* EPUB views attach themselves once their book is ready. */
    for (const leaf of this.app.workspace.getLeavesOfType(EPUB_VIEW_TYPE)) if (leaf.view) live.add(leaf.view);
    for (const view of Array.from(this.views.keys())) {
      if (!live.has(view)) this.teardownView(view);
    }
    this.refreshFocus();
  }

  /* An EPUB view, once its book is laid out, joins the PDF views: undo, the
     sidebar and redrawing all work through the same map. */
  async attachEpub(view) {
    const state = { kind: 'epub', view, container: view.containerEl, doc: null, observer: null, frame: 0, pendingZoom: null };
    this.views.set(view, state);
    try {
      state.doc = await this.loadDoc(view.file);
    } catch (e) {
      this.views.delete(view);
      throw e;
    }
    if (this.views.get(view) !== state) return null;
    for (const other of this.views.values()) {
      if (other.doc === state.doc) this.render(other);
    }
    this.refreshFocus();
    this.maybeOpenSidebar();
    return state;
  }

  detachEpub(view) {
    if (this.views.has(view)) this.teardownView(view);
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

    /* The same three buttons a book has, in the tab's header, in place of
       the viewer's own toolbar, which the stylesheet hides. */
    state.actions = headerButtons(view, {
      mode: () => this.toggleHighlightMode(),
      zoomIn: () => this.zoomPdf(state, 1),
      zoomOut: () => this.zoomPdf(state, -1),
    });
    this.refreshToolbarButton(state);

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
    state.container.querySelectorAll('.mpa-layer').forEach((el) => el.remove());
    if (state.actions && state.kind !== 'epub') for (const el of Object.values(state.actions)) el.remove();
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

  getSidecarPath(file) {
    return sidecarPathFor(file.path);
  }

  /* After a document is renamed or moved: its annotations, and what is
     remembered about it on this device, follow it. A document not open this
     session has only its file to move; an open one moves it through its save
     queue, so no save in flight writes to either name halfway through. */
  async followRename(file, oldPath) {
    if (!/\.(pdf|epub)$/i.test(oldPath) && !/\.(pdf|epub)$/i.test(file.path)) return;
    for (const [store, save] of [
      [this.zooms, () => this.saveZooms()],
      [this.textSizes, () => this.app.saveLocalStorage(TEXT_SIZE_STORE_KEY, this.textSizes)],
      [this.places, () => this.savePlaces()],
    ]) {
      if (!store || !(oldPath in store)) continue;
      store[file.path] = store[oldPath];
      delete store[oldPath];
      try {
        save();
      } catch (e) {
        this.report('could not save what is remembered about a renamed file', e);
      }
    }
    const doc = this.docs.get(oldPath);
    if (doc) {
      this.docs.delete(oldPath);
      this.docs.set(file.path, doc);
      doc.saveChain = doc.saveChain.then(() => this.moveSidecar(doc)).catch((e) => this.report('could not move annotations', e));
      return doc.saveChain;
    }
    /* Opening the document under its new name waits for this, so it does
       not start afresh from a file that has not arrived yet. */
    const from = this.leftBehind.get(oldPath) || sidecarPathFor(oldPath);
    this.leftBehind.delete(oldPath);
    const moving = this.moveSidecarFile(from, sidecarPathFor(file.path));
    this.renaming.set(file.path, moving);
    try {
      /* Not moved: the annotations stay where they are, and are used from
         there, for the rest of the session. */
      if (!(await moving)) this.leftBehind.set(file.path, from);
    } finally {
      if (this.renaming.get(file.path) === moving) this.renaming.delete(file.path);
    }
  }

  /* Brings an open document's annotations file to where its name now says,
     if it is not there already. */
  async moveSidecar(doc) {
    const to = this.getSidecarPath(doc.file);
    /* Already moved, or already found blocked: asked once, not at every save. */
    if (doc.sidecarPath === to || doc.sidecarBlocked === to) return;
    if (await this.moveSidecarFile(doc.sidecarPath, to)) doc.sidecarPath = to;
    else doc.sidecarBlocked = to;
  }

  /* Moves an annotations file. A file already at the new name is someone's
     annotations too, so it is not written over: the old file stays where it
     is and is still used, and the reader is told. Returns whether the
     document's annotations now live at the new name. */
  async moveSidecarFile(from, to) {
    if (!from || from === to) return true;
    const vault = this.app.vault;
    const old = vault.getAbstractFileByPath(from);
    /* Nothing at the old name: nothing to move, perhaps because a whole
       folder was moved and it went along. */
    if (!(old instanceof TFile)) return true;
    /* A change of capitals only: on most Macs and PCs the disk sees one name,
       so the file "already there" is this one. */
    const sameName = from.toLowerCase() === to.toLowerCase();
    if (!sameName && (vault.getAbstractFileByPath(to) || (await vault.adapter.exists(to)))) {
      new Notice(
        `The annotations stay in ${from} for now, because ${to} already exists. ` +
          `To bring them along, move or delete ${to}, then rename the document once more.`,
        15000
      );
      return false;
    }
    await vault.rename(old, to);
    return true;
  }

  async loadDoc(file) {
    const existing = this.docs.get(file.path) || this.rekeyDoc(file);
    if (existing) return existing;
    /* Read again if the document was renamed while it was being read. */
    let path;
    let loaded;
    for (let tries = 0; tries < 3; tries++) {
      const moving = this.renaming.get(file.path);
      if (moving) await moving.catch(() => null);
      path = this.leftBehind.get(file.path) || this.getSidecarPath(file);
      loaded = await this.readSidecar(path);
      const now = this.leftBehind.get(file.path) || this.getSidecarPath(file);
      if (now === path && !this.renaming.has(file.path)) break;
    }
    /* A second caller may have finished first while this one was reading. */
    const raced = this.docs.get(file.path);
    if (raced) return raced;

    /** @type {DocState} */
    const doc = {
      file,
      /* Where the annotations file is, which a rename can leave behind
         the document's own name for a moment. */
      sidecarPath: path,
      /* Left behind by a rename that could not move it: not tried again. */
      sidecarBlocked: path === this.getSidecarPath(file) ? null : this.getSidecarPath(file),
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
      /* Counts changes, so a page whose annotations are already drawn as they
         stand is left alone when the viewer redraws around it. */
      revision: 0,
    };
    this.docs.set(file.path, doc);
    return doc;
  }

  /* A document already loaded under another name: a folder it was in was
     renamed, which can arrive without a rename of the file itself. */
  rekeyDoc(file) {
    for (const [path, doc] of this.docs) {
      if (doc.file !== file) continue;
      this.docs.delete(path);
      this.docs.set(file.path, doc);
      return doc;
    }
    return null;
  }

  async readSidecar(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    const empty = { highlights: [], notes: [] };
    if (!(file instanceof TFile)) return { data: empty, ok: true };
    let text;
    try {
      text = await this.app.vault.read(file);
    } catch (e) {
      /* Gone from the disk before Obsidian noticed, by a sync for instance:
         there are no annotations to protect, so this is a fresh start rather
         than a damaged file. */
      if (e && e.code === 'ENOENT') return { data: empty, ok: true };
      throw e;
    }
    try {
      const parsed = JSON.parse(text);
      return { ok: true, data: sanitiseAnnotations(parsed) };
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
    /* A move that fails leaves the annotations where they were; the change
       is still saved, there. */
    try {
      await this.moveSidecar(doc);
    } catch (e) {
      this.report('could not move annotations to follow a renamed file', e);
      doc.sidecarBlocked = this.getSidecarPath(doc.file);
    }
    const path = doc.sidecarPath;
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

  /* Earlier versions wrote their settings-tab help text to a file beside the
     plugin. The tab no longer shows it, so a copy nobody has edited is
     removed. An edited one is someone's own writing and is left alone. */
  async removeOldHelpFile() {
    const dir = this.manifest && this.manifest.dir;
    if (!dir) return;
    const file = normalizePath(dir + '/settings-help.md');
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(file))) return;
    if (OLD_HELP_STAMPS.includes(stamp(await adapter.read(file)))) await adapter.remove(file);
  }

  /* ----------------------------------------------------------- dispatching */

  /* The view an event landed in, plus whichever of our own elements it hit. */
  locate(e) {
    const target = e.target;
    if (!isElement(target)) return null;
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
    new Notice('This document’s annotations file could not be read, so its annotations cannot be edited.');
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
    if (isElement(target)) {
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
    /* Only a press in a PDF: pressing a button on the selection bar must not
       replace where the drag it is acting on began. */
    if (!this.locate(e)) return;
    this.pointers.down = { x: e.clientX, y: e.clientY };
    this.pointers.up = null;
  }

  onMouseUp(e) {
    if (e.button !== 0) return;
    const hit = this.locate(e);
    if (!hit) return;
    this.pointers.up = { x: e.clientX, y: e.clientY };
    if (this.highlightMode) {
      if (!this.canEdit(hit.state.doc)) return;
      const id = this.addHighlightsFromSelection(hit.state);
      if (id) this.showInSidebar(hit.state.doc, id);
      return;
    }
    /* Highlight mode off: a selection gets the small bar. After the browser
       has settled the selection, which a double-click finishes later. */
    const state = hit.state;
    window.setTimeout(() => {
      const selection = windowOf(state.container).getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!state.container.contains(range.commonAncestorContainer)) return;
      this.selectionBar.show(
        selectionEnd(range),
        this.selectionActions(state.doc, (c) => this.addHighlightsFromSelection(state, c), () => selection.toString()),
        state.container.ownerDocument
      );
    }, 0);
  }

  /* macOS's Look Up, which shows a word's dictionary entry, as a button for a
     right-click: on the selection if the click was on it, otherwise on the
     word under the pointer. Off where the setting is off, or not a Mac. */
  lookUpButton(win, e, onSelection) {
    if (!Platform.isMacOS || !this.settings || !this.settings.lookUp) return null;
    const range = onSelection ? null : wordRangeAt(win.document, e.clientX, e.clientY);
    if (!onSelection && !range) return null;
    return {
      icon: 'book-a',
      label: 'Look up',
      run: () => {
        if (range) {
          const selection = win.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
        this.lookUp(win);
      },
    };
  }

  lookUp(win) {
    try {
      win.focus();
    } catch (err) {
      /* A frame that cannot take the focus still has its selection. */
    }
    /* After the focus has moved, so it is the window with the word that
       shows the dictionary. */
    window.setTimeout(() => {
      try {
        const remote = window.require('@electron/remote');
        const contents = remote.webContents.getFocusedWebContents() || (win === window ? remote.getCurrentWebContents() : null);
        if (contents) contents.showDefinitionForSelection();
      } catch (err) {
        this.report('could not look the word up', err);
      }
    }, 0);
  }

  /* The colours offered for highlighting, first first. */
  menuColours() {
    return (this.settings && this.settings.menuColours) || [];
  }

  /* What the selection bar and the right-click menu do with a selection, for
     either kind of document: `make` turns the selection into a highlight and
     returns its id. */
  selectionActions(doc, make, text) {
    const editable = !doc.readOnly;
    const highlight = (colour) => {
      if (!this.canEdit(doc)) return null;
      const id = make(colour);
      if (id) this.showInSidebar(doc, id);
      return id;
    };
    return {
      highlight: editable ? highlight : null,
      note: editable
        ? () => {
            const id = highlight(this.menuColours()[0]);
            if (id) this.revealAnnotation(doc, id, true).catch((err) => this.report('could not show the note', err));
          }
        : null,
      copy: () => {
        navigator.clipboard.writeText(text()).catch((err) => this.report('could not copy', err));
      },
    };
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

    const { state, pageEl, noteIconEl } = hit;
    const iconKind = noteIconEl ? noteIconEl.dataset.noteKind : null;
    const iconId = noteIconEl ? noteIconEl.dataset.noteId : null;

    /* Right-clicking the icon of a highlight's note counts as right-clicking
       that highlight. */
    let highlightId = hit.highlightEl ? hit.highlightEl.dataset.highlightId : null;
    if (!highlightId && iconKind === 'highlight') highlightId = iconId;

    const doc = state.doc;
    this.selectionBar.hide();
    const buttons = [];
    const add = (icon, label, run) => buttons.push({ icon, label, run });

    /* Right-clicking the selection: what the selection bar offers. */
    const win = windowOf(state.container);
    const selection = win.getSelection();
    const onSelection =
      !!selection &&
      !selection.isCollapsed &&
      !!selection.rangeCount &&
      state.container.contains(selection.getRangeAt(0).commonAncestorContainer) &&
      pointInRange(selection.getRangeAt(0), e.clientX, e.clientY);
    if (onSelection) {
      buttons.push(...selectionButtons(this.selectionActions(doc, (c) => this.addHighlightsFromSelection(state, c), () => selection.toString()), this.menuColours()));
    } else if (iconKind === 'note') {
      /* A note of its own, by its marker. */
      if (!doc.readOnly) {
        add('sticky-note', 'Edit note', () => this.revealAnnotation(doc, iconId, true));
        add('eraser', 'Remove note', () => this.deleteAnnotation(doc, iconId));
      }
    } else if (highlightId) {
      /* A note asked for on top of a highlight belongs to that highlight, not
         to the point on the page: a note of its own there would have nothing
         to sit under in an exported note. */
      const highlight = doc.data.highlights.find((h) => h.id === highlightId);
      if (!doc.readOnly) {
        add('sticky-note', highlight && highlight.note ? 'Edit note' : 'Add note', () => this.revealAnnotation(doc, highlightId, true));
      }
      if (highlight) add('copy', 'Copy', () => this.copyText(highlight.text || ''));
      if (!doc.readOnly) {
        if (highlight && highlight.note) {
          add('eraser', 'Remove note', () => {
            highlight.note = '';
            this.commit(doc, 'removing a note');
          });
        }
        add('trash-2', 'Remove highlight', () => this.deleteAnnotation(doc, highlightId));
      }
    } else if (!doc.readOnly) {
      add('sticky-note', 'Add note', () => this.addStandaloneNote(state, e, pageEl));
    }
    const look = this.lookUpButton(win, e, onSelection);
    if (look) buttons.push(look);

    /* Nothing of ours to offer: the viewer's own menu is left in place. */
    if (!buttons.length) return;
    e.preventDefault();
    this.selectionBar.show({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }, buttons, state.container && state.container.ownerDocument);
  }

  copyText(text) {
    navigator.clipboard.writeText(text).catch((err) => this.report('could not copy', err));
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
    doc.revision++;

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
    const focused = (typeof activeDocument !== 'undefined' ? activeDocument : document).activeElement;
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
    doc.revision++;

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
      if (file.path !== doc.sidecarPath) continue;
      let raw;
      try {
        raw = await this.app.vault.read(file);
      } catch (e) {
        return;
      }
      if (stamp(raw) === doc.sidecarStamp) return; // our own write coming back

      const loaded = await this.readSidecar(doc.sidecarPath);
      doc.data = loaded.data;
      doc.readOnly = !loaded.ok;
      doc.sidecarStamp = stamp(raw);
      doc.baseline = snapshot(doc.data);
      doc.undoStack.length = 0;
      doc.redoStack.length = 0;
      doc.revision++;
      for (const state of this.views.values()) {
        if (state.doc === doc) this.render(state);
      }
      this.notify(doc);
      return;
    }
  }

  /* ------------------------------------------------------------ highlights */

  addHighlightsFromSelection(state, colour) {
    const selection = windowOf(state.container).getSelection();
    if (!selection) return;
    /* A drag begun exactly on the seam between two runs of a PDF's text can
       leave the browser with no selection at all. The drag itself still says
       what was meant, so it is used instead. */
    if (selection.isCollapsed || selection.rangeCount === 0) {
      const dragged = dragRange(state.container.ownerDocument, this.pointers.down, this.pointers.up);
      if (!dragged || !state.container.contains(dragged.commonAncestorContainer)) return;
      selection.removeAllRanges();
      selection.addRange(dragged);
    }
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
      color: HEX_COLOR_RE.test(colour || '') ? colour : this.settings.highlightColor,
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
    const selection = (typeof activeWindow !== 'undefined' ? activeWindow : window).getSelection();
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

    const path = 'Finally, A Reader selection report.md';
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
     session, so it is there without being asked for.
     Only once: if it is closed after that, it stays closed until something
     needs it. */
  maybeOpenSidebar() {
    if (this.sidebarOffered) return;
    this.sidebarOffered = true;
    if (this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE).length) return;
    /* On a phone or tablet the sidebar is a drawer that covers the document,
       so it is made ready but left closed: it is a swipe away. */
    this.ensureSidebar(!Platform.isMobile).catch((e) => this.report('could not open the sidebar', e));
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
    /* On a phone or tablet the sidebar's drawer covers the document, so it
       closes to show where the card led. */
    if (Platform.isMobile && this.app.workspace.rightSplit && !this.app.workspace.rightSplit.collapsed) {
      this.app.workspace.rightSplit.collapse();
    }
    if (state.kind === 'epub') {
      if (!state.container.isShown()) this.app.workspace.revealLeaf(state.view.leaf);
      if (!state.view.goTo(id)) return false;
      return true;
    }
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
    return true;
  }

  /* Typing in a note box. Saved shortly after, and drawn at once so a note
     marker appears or goes as the note does. Not yet an undo step: that is
     filed once, when the box is left. */
  setNote(doc, id, text) {
    if (!doc || doc.readOnly) return;
    const found = findAnnotation(doc.data, id);
    if (!found) return;
    /* The page only changes when a highlight's note marker appears or goes;
       a note of its own is marked whatever it says. */
    const before = found.kind === 'highlight' ? found.obj.note || '' : null;
    if (found.kind === 'highlight') found.obj.note = text;
    else found.obj.text = text;
    doc.editing = true;
    this.saveSoon(doc);
    const marked = (note) => [!!note, !!note.trim()].join();
    if (before === null || marked(before) === marked(text)) return;
    doc.revision++;
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
     and the cursor goes to its box in the sidebar. An empty note is kept; it
     is removed from its card's trash can. */
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
    if (state.kind === 'epub') {
      state.view.redraw();
      return;
    }
    /* Outside withoutObserver, so that the page rebuild a zoom change causes
       is seen and the overlays are drawn again at the new scale. */
    this.syncZoom(state);
    this.withoutObserver(state, () => {
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

    /* Positions are fractions of the page, so a layer drawn for these
       annotations is right at any zoom, and only a page the viewer has
       rebuilt, which takes the layer with it, needs drawing again. */
    const key = `${state.doc.revision}:${this.drawRevision || 0}`;
    for (const pageEl of state.container.querySelectorAll('.page')) {
      const items = byPage.get(pageNumberOf(pageEl));
      let layer = pageEl.querySelector(':scope > .mpa-layer');

      if (!items || (!items.rects.length && !items.icons.length)) {
        if (layer) layer.remove();
        continue;
      }
      if (layer && layer.dataset.mpaKey === key) continue;
      if (!layer) layer = pageEl.createDiv({ cls: 'mpa-layer' });
      layer.empty();
      layer.dataset.mpaKey = key;

      for (const { highlight, rect, color } of items.rects) {
        const el = layer.createDiv({ cls: 'mpa-highlight' });
        el.dataset.highlightId = highlight.id;
        el.style.setProperty('--mpa-x', pct(rect.x));
        el.style.setProperty('--mpa-y', pct(rect.y));
        el.style.setProperty('--mpa-w', pct(rect.w));
        el.style.setProperty('--mpa-h', pct(rect.h));
        el.style.setProperty('--mpa-color', color);
      }

      for (const item of items.icons) {
        /* Only the vertical position comes from script. The margin placement
           is in the stylesheet, so there is one rule for every marker. */
        const icon = this.createNoteIcon(layer, item.id, item.kind, item.color);
        icon.style.setProperty('--mpa-y', pct(item.y));
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

  refreshToolbarButton(state) {
    if (state.kind === 'epub') {
      state.view.refreshModeButton();
      return;
    }
    if (state.actions) this.styleModeButton(state.actions.mode);
  }

  styleModeButton(btn) {
    btn.toggleClass('is-active', this.highlightMode);
    btn.style.setProperty('--mpa-color', this.settings.highlightColor);
  }

  /* A zoom step, as the viewer's own buttons made one. */
  zoomPdf(state, direction) {
    const inner = pdfInnerOf(state.view);
    if (!inner) return;
    if (direction > 0 && typeof inner.increaseScale === 'function') inner.increaseScale();
    else if (direction < 0 && typeof inner.decreaseScale === 'function') inner.decreaseScale();
    else inner.currentScale = inner.currentScale * (direction > 0 ? 1.1 : 1 / 1.1);
  }

  /* ------------------------------------------------------------- settings */

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!HEX_COLOR_RE.test(this.settings.highlightColor)) {
      this.settings.highlightColor = DEFAULT_SETTINGS.highlightColor;
    }
    const palette = normalisePalette(this.settings, DEFAULT_SETTINGS);
    this.settings.menuColours = palette.menu;
    this.settings.spareColours = palette.spare;
    this.settings.highlightColor = palette.menu[0];
    this.settings.snapToWords = this.settings.snapToWords !== false;
    this.settings.rememberZoom = this.settings.rememberZoom !== false;
    this.settings.lookUp = this.settings.lookUp === true;
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
    /* Colours may have changed: every page is drawn again. */
    this.drawRevision = (this.drawRevision || 0) + 1;
    this.applyModeColor();
    this.updateStatusEl();
    for (const state of this.views.values()) this.render(state);
    for (const sidebar of this.sidebars()) sidebar.refresh();
  }
}

/* Stamps of the help text earlier versions wrote out, to recognise a copy
   nobody has edited. */
const OLD_HELP_STAMPS = ['41f1859b-3282', 'a69ad533-3360'];

class FinallyAReaderSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /* The highlight colours as a row of swatches with a line in it: the menu's
     colours to its left, the spares to its right. Swatches are dragged to
     reorder or to cross the line; a click changes a colour; the cross on a
     spare removes it; the plus adds one. */
  drawPalette(row) {
    const plugin = this.plugin;
    const settings = plugin.settings;
    row.empty();
    const commit = async (lists) => {
      settings.menuColours = lists.menu;
      settings.spareColours = lists.spare;
      settings.highlightColor = lists.menu[0];
      await plugin.saveSettings();
      this.drawPalette(row);
    };
    /* Where a drop at x lands: before the first swatch whose middle is
       right of x, counting the line as a place in the row. */
    const dropTarget = (x) => {
      const items = Array.from(row.querySelectorAll('.mpa-swatch, .mpa-palette-line'));
      let menuIndex = 0;
      let spareIndex = 0;
      let pastLine = false;
      for (const item of items) {
        const box = item.getBoundingClientRect();
        if (x < box.left + box.width / 2) break;
        if (item.hasClass('mpa-palette-line')) pastLine = true;
        else if (pastLine) spareIndex++;
        else menuIndex++;
      }
      return pastLine ? { list: 'spare', index: spareIndex } : { list: 'menu', index: menuIndex };
    };

    const swatch = (colour, list, index) => {
      const el = row.createDiv({ cls: 'mpa-swatch', attr: { draggable: 'true', 'aria-label': `${colourName(colour)}, ${colour}` } });
      el.style.setProperty('--mpa-color', colour);
      const input = el.createEl('input', { type: 'color', cls: 'mpa-swatch-input' });
      input.value = expandHex(colour);
      el.addEventListener('click', (e) => {
        if (e.target === input || (isElement(e.target) && e.target.closest('.mpa-swatch-remove'))) return;
        input.click();
      });
      input.addEventListener('change', () => {
        const value = input.value.toLowerCase();
        /* A colour already in the palette is not taken twice; the swatch
           goes back to what it was. */
        if (!HEX_COLOR_RE.test(value) || settings.menuColours.concat(settings.spareColours).includes(value)) {
          this.drawPalette(row);
          return;
        }
        const lists = { menu: settings.menuColours.slice(), spare: settings.spareColours.slice() };
        lists[list][index] = value;
        commit(lists);
      });
      if (list === 'spare') {
        const remove = el.createDiv({ cls: 'mpa-swatch-remove', attr: { 'aria-label': 'Remove this colour' } });
        setIcon(remove, 'x');
        remove.addEventListener('click', (e) => {
          e.stopPropagation();
          const spare = settings.spareColours.slice();
          spare.splice(index, 1);
          commit({ menu: settings.menuColours.slice(), spare });
        });
      }
      el.addEventListener('dragstart', (e) => {
        row.mpaDragging = { list, index };
        el.addClass('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', colour);
      });
      el.addEventListener('dragend', () => {
        row.mpaDragging = null;
        el.removeClass('is-dragging');
        row.removeClass('is-drop-target');
      });
    };

    settings.menuColours.forEach((c, i) => swatch(c, 'menu', i));
    row.createDiv({ cls: 'mpa-palette-line', attr: { 'aria-label': 'Left of the line: in the right-click menu' } });
    settings.spareColours.forEach((c, i) => swatch(c, 'spare', i));

    const add = row.createDiv({ cls: 'mpa-palette-add clickable-icon', attr: { 'aria-label': 'Add a colour' } });
    setIcon(add, 'plus');
    const picker = add.createEl('input', { type: 'color', cls: 'mpa-swatch-input' });
    picker.value = '#ffb3ba';
    add.addEventListener('click', (e) => {
      if (e.target !== picker) picker.click();
    });
    picker.addEventListener('change', () => {
      const value = picker.value.toLowerCase();
      if (!HEX_COLOR_RE.test(value) || settings.menuColours.concat(settings.spareColours).includes(value)) {
        this.drawPalette(row);
        return;
      }
      commit({ menu: settings.menuColours.slice(), spare: settings.spareColours.concat(value) });
    });

    /* The row's own listeners, added the first time only: drawing again
       empties the row but keeps the row. */
    row.mpaDrop = (e) => {
      const from = row.mpaDragging;
      row.mpaDragging = null;
      const lists = movePaletteColour(settings.menuColours, settings.spareColours, from, dropTarget(e.clientX));
      if (lists) commit(lists);
      else this.drawPalette(row);
    };
    if (!row.mpaWired) {
      row.mpaWired = true;
      row.addEventListener('dragover', (e) => {
        if (!row.mpaDragging) return;
        e.preventDefault();
        row.addClass('is-drop-target');
      });
      row.addEventListener('dragleave', () => row.removeClass('is-drop-target'));
      row.addEventListener('drop', (e) => {
        if (!row.mpaDragging) return;
        e.preventDefault();
        row.mpaDrop(e);
      });
    }
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

    const palette = new Setting(containerEl)
      .setName('Highlight colours')
      .setDesc(
        'Colours to the left of the line are in the right-click menu, in that order, and the first is the one ' +
          'highlight mode uses. Drag a colour across the line to add it to the menu or take it out, or along ' +
          'the row to reorder. Click a colour to change it. Existing highlights keep the colour they were made with.'
      );
    palette.settingEl.addClass('mpa-palette-setting');
    this.drawPalette(palette.controlEl.createDiv({ cls: 'mpa-palette' }));

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

    if (Platform.isMacOS) {
      new Setting(containerEl)
        .setName('Look up in the right-click menu')
        .setDesc('Adds dictionary lookup in right-click menu.')
        .addToggle((toggle) => toggle.setValue(settings.lookUp).onChange((v) => save('lookUp', v)));
    }

    new Setting(containerEl)
      .setName('Remember each PDF\u2019s zoom level')
      .addToggle((toggle) => toggle.setValue(settings.rememberZoom).onChange((v) => save('rememberZoom', v)));
  }
}

/* ------------------------------------------------------------------ sidebar

   The annotations sidebar. One card per highlight or note on
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

/* ------------------------------------------------------------------ EPUB

   An EPUB opens in a view of the plugin's own, as one continuous scroll of
   all its chapters, and is annotated the way a PDF is: the same highlight
   mode, sidebar, notes, undo and exported note, and the same footnote
   previews.

   The book is shown in an iframe sandboxed with scripts off, so nothing in a
   book can run, and everything from the book, footnote previews included,
   stays inside that frame. The plugin reaches in from outside to draw and to
   listen. Obsidian's own additions to the DOM (addClass, createDiv and so
   on) are not installed in the frame's window, so the code that works inside
   it uses the plain DOM.

   A highlight is anchored by character offsets into the text of its chapter,
   [chapter, offset], with its words kept as well: if the offsets no longer
   land on those words, the words are looked for instead. */

class EpubView extends FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.frame = null;
    this.book = null;
    /** @type {HTMLElement[]} the chapters, in order, inside the frame */
    this.sections = [];
    this.layer = null;
    this.loadToken = 0;
    this.drawn = new Map();
    this.ranges = new Map();
    this.preview = null;
  }

  getViewType() {
    return EPUB_VIEW_TYPE;
  }

  getDisplayText() {
    return this.file ? this.file.basename : 'EPUB';
  }

  getIcon() {
    return 'book-open';
  }

  canAcceptExtension(extension) {
    return extension === 'epub';
  }

  async onOpen() {
    this.modeButton = headerButtons(this, {
      mode: () => this.plugin.toggleHighlightMode(),
      zoomIn: () => this.stepTextSize(1),
      zoomOut: () => this.stepTextSize(-1),
    }).mode;
    this.refreshModeButton();
  }

  async onLoadFile(file) {
    const token = ++this.loadToken;
    this.releaseBook();
    this.contentEl.empty();
    this.contentEl.addClass('mpa-epub');
    let book;
    try {
      book = await loadEpub(await this.app.vault.readBinary(file));
    } catch (e) {
      this.plugin.report(`could not read ${file.path}`, e);
      if (token === this.loadToken) this.showMessage('This EPUB could not be read. It may be damaged.');
      return;
    }
    if (token !== this.loadToken) {
      revokeBook(book);
      return;
    }
    if (book.problem) {
      revokeBook(book);
      this.showMessage(book.problem);
      return;
    }
    this.book = book;
    await this.build(book);
    if (token !== this.loadToken) return;
    await this.plugin.attachEpub(this);
  }

  async onUnloadFile() {
    this.loadToken++;
    this.plugin.detachEpub(this);
    this.releaseBook();
  }

  async onClose() {
    this.loadToken++;
    this.plugin.detachEpub(this);
    this.releaseBook();
  }

  /* Lets go of the book shown. Not named close(): that is the view's own,
     which Obsidian calls to unload it when its tab is closed. */
  releaseBook() {
    this.hidePreview();
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.resizeObserver = null;
    if (this.frameObserver) this.frameObserver.disconnect();
    this.frameObserver = null;
    if (this.placeTimer) window.clearTimeout(this.placeTimer);
    this.place = null;
    if (this.book) revokeBook(this.book);
    this.book = null;
    this.frame = null;
    this.sections = [];
    this.layer = null;
    this.drawn.clear();
    this.ranges.clear();
  }

  showMessage(text) {
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: 'mpa-epub-message', text });
  }

  /* ------------------------------------------------------------ the frame */

  async build(book) {
    const frame = this.contentEl.createEl('iframe', {
      cls: 'mpa-epub-frame',
      attr: { sandbox: 'allow-same-origin', title: book.title || 'EPUB' },
    });
    /* Nothing loads from outside the book: pictures, fonts and media only
       from the blob URLs made for them, styles only from the text put in. */
    frame.srcdoc =
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src blob: data:; ' +
      'font-src blob: data:; media-src blob: data:; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'">' +
      '</head><body></body></html>';
    await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
    this.frame = frame;
    const d = frame.contentDocument;
    const head = d.head;

    const base = d.createElement('style');
    base.id = 'mpa-epub-base';
    head.appendChild(base);
    this.applyTheme();
    for (const text of [...book.styles, ...book.inlineStyles]) {
      const style = d.createElement('style');
      style.textContent = text;
      head.appendChild(style);
    }
    /* Last, so a book's own styles cannot hide the highlights. */
    const own = d.createElement('style');
    own.textContent = EPUB_FRAME_CSS;
    head.appendChild(own);

    const body = d.body;
    this.sections = book.sections.map((section, i) => {
      const el = d.createElement('section');
      el.className = 'mpa-section';
      el.id = `mpa${i}`;
      el.dataset.section = String(i);
      if (section.bodyClass) el.className += ` ${section.bodyClass}`;
      for (const node of Array.from(section.body.childNodes)) el.appendChild(d.importNode(node, true));
      body.appendChild(el);
      return el;
    });
    this.layer = d.createElement('div');
    this.layer.className = 'mpa-epub-layer';
    body.appendChild(this.layer);

    this.applyTextSize();
    this.listen(d);
    /* Text reflows when the pane is resized, the text size changes, or an
       image arrives, and the highlights must follow it. */
    this.resizeObserver = new ResizeObserver(() => {
      if (this.holding && Date.now() < this.holding.until) this.scrollToPosition(this.holding.at, 0);
      this.scheduleRedraw();
    });
    this.resizeObserver.observe(body);
    for (const type of ['wheel', 'keydown', 'mousedown', 'touchstart']) {
      d.addEventListener(type, () => (this.holding = null), { capture: true, passive: true });
    }
    /* The tab itself: a new width lays the page out again; being shown again
       after being hidden goes back to the place it was at. */
    this.wasVisible = this.visible();
    this.frameObserver = new ResizeObserver(() => {
      const shown = this.visible();
      if (shown) {
        const at = this.place;
        this.applyTextSize();
        if (at && !this.wasVisible) this.scrollToPosition(at, 0);
      }
      this.wasVisible = shown;
    });
    this.frameObserver.observe(frame);
    /* Back to where this book was left. */
    const saved = this.file && this.plugin.places[this.file.path];
    if (saved) {
      this.place = saved;
      this.scrollToPosition(saved, 0);
      /* Pictures and fonts arrive after this and move the text, so the place
         is held for a moment, until they have or the reader moves. */
      this.holding = { at: saved, until: Date.now() + 3000 };
    }
  }

  /* The frame uses Obsidian's colours and fonts as its defaults, which a
     book's own stylesheet may override. Read again when the theme changes. */
  applyTheme() {
    const d = this.frame && this.frame.contentDocument;
    if (!d) return;
    const css = getComputedStyle(this.containerEl.ownerDocument.body);
    const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    d.getElementById('mpa-epub-base').textContent = EPUB_BASE_CSS.replace(/\{\{([a-z-]+)\|([^}]*)\}\}/g, (_, name, fallback) =>
      v(`--${name}`, fallback)
    );
  }

  /* ---------------------------------------------------------- text size */

  textSize() {
    const stored = this.file && this.plugin.textSizes[this.file.path];
    return validTextSize(stored) ? stored : 100;
  }

  /* Zoom works as it does on a PDF: the page is laid out once, as wide as
     the tab allows up to a comfortable line length, and zooming magnifies
     that page rather than re-wrapping the text, so lines keep their length
     and a page wider than the tab scrolls sideways. */
  applyTextSize() {
    const d = this.frame && this.frame.contentDocument;
    if (!d || !d.body) return;
    const em = parseFloat(getComputedStyle(d.documentElement).fontSize) || 16;
    const room = d.documentElement.clientWidth;
    if (room > 0) d.body.style.width = `${Math.min(EPUB_LINE_EMS * em, room)}px`;
    d.body.style.zoom = String(this.textSize() / 100);
  }

  zoomFactor() {
    return this.textSize() / 100;
  }

  /* Keeps the words at the top of the window in place while the text grows
     or shrinks around them. */
  stepTextSize(direction) {
    if (!this.file || !this.frame) return;
    const at = this.topPosition();
    const sizes = TEXT_SIZES;
    const current = this.textSize();
    const next =
      direction > 0 ? sizes.find((s) => s > current) || sizes[sizes.length - 1] : [...sizes].reverse().find((s) => s < current) || sizes[0];
    this.plugin.noteTextSize(this.file.path, next);
    this.applyTextSize();
    if (at) this.scrollToPosition(at, 0);
    this.scheduleRedraw();
  }

  /* The place in the book at the top of the window. */
  topPosition() {
    const d = this.frame.contentDocument;
    const box = d.body.getBoundingClientRect();
    const across = Math.min(Math.max(box.left + box.width / 2, 1), d.documentElement.clientWidth - 1);
    for (const down of [4, 24, 48, 96]) {
      const range = caretRangeAt(d, across, down);
      const at = range && this.positionOf(range.startContainer, range.startOffset);
      if (at) return at;
    }
    return null;
  }

  /* Noted as you read, so the place survives the tab being hidden, which
     makes the browser forget the frame's scroll, and the book being closed. */
  notePlace() {
    if (!this.frame || !this.file || !this.visible()) return;
    if (this.holding && Date.now() < this.holding.until) return;
    const at = this.topPosition();
    if (!at) return;
    this.place = at;
    this.plugin.notePlace(this.file.path, at);
  }

  visible() {
    return !!this.frame && this.frame.clientWidth > 0 && this.frame.clientHeight > 0;
  }

  /* -------------------------------------------------- offsets and ranges */

  /* Where a point in the frame's DOM is, as [chapter, offset]. */
  positionOf(node, offset) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    const section = el && el.closest('.mpa-section');
    if (!section) return null;
    const range = section.ownerDocument.createRange();
    range.setStart(section, 0);
    try {
      range.setEnd(node, offset);
    } catch (e) {
      return null;
    }
    return [Number(section.dataset.section), range.toString().length];
  }

  /* And back again. */
  pointAt(position) {
    const section = this.sections[position[0]];
    if (!section) return null;
    const walker = section.ownerDocument.createTreeWalker(section, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_CDATA_SECTION);
    let left = position[1];
    let node;
    let last = null;
    while ((node = walker.nextNode())) {
      const length = node.nodeValue.length;
      if (left <= length) return { node, offset: left };
      left -= length;
      last = node;
    }
    return last ? { node: last, offset: last.nodeValue.length } : { node: section, offset: 0 };
  }

  sectionText(i) {
    return this.sections[i] ? this.sections[i].textContent : '';
  }

  /* The range a highlight covers, checked against its words. */
  rangeFor(highlight) {
    const anchor = highlight.epub;
    if (!anchor || !Array.isArray(anchor.start) || !Array.isArray(anchor.end)) return null;
    const key = `${highlight.id}:${anchor.start}:${anchor.end}:${highlight.text}`;
    if (this.ranges.has(key)) return this.ranges.get(key);
    let range = this.rangeBetween(anchor.start, anchor.end);
    if (!range || !sameWords(range.toString(), highlight.text)) {
      /* The offsets have drifted, from a changed book perhaps: the words are
         looked for in the same chapter, nearest where they were. */
      const texts = this.sections.map((_, i) => this.sectionText(i));
      const found = findQuoteAcross(texts, anchor.start[0], anchor.end[0], highlight.text || '', anchor.start[1]);
      range = found ? this.rangeBetween(found.start, found.end) : null;
    }
    this.ranges.set(key, range);
    return range;
  }

  rangeBetween(start, end) {
    const a = this.pointAt(start);
    const b = this.pointAt(end);
    if (!a || !b) return null;
    const range = this.frame.contentDocument.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
    } catch (e) {
      return null;
    }
    return range.collapsed ? null : range;
  }

  /* ------------------------------------------------------------- drawing */

  scheduleRedraw() {
    if (this.redrawFrame || !this.frame) return;
    /* Timers and frames go through Obsidian's window: the book's own, with
       scripts switched off, never runs them. */
    this.redrawFrame = window.requestAnimationFrame(() => {
      this.redrawFrame = 0;
      this.redraw();
    });
  }

  redraw() {
    const state = this.plugin.views.get(this);
    if (!state || !state.doc || !this.layer) return;
    this.refreshModeButton();
    const d = this.frame.contentDocument;
    const origin = d.body.getBoundingClientRect();
    const settings = this.plugin.settings;
    const layer = this.layer;
    /* Boxes come back magnified by the zoom, and positions set inside the
       page are magnified again, so they are divided back. What is kept for
       finding the highlight under a click stays as measured. */
    const z = this.zoomFactor();
    const px = (v) => `${v / z}px`;
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    this.drawn.clear();

    const icon = (id, kind, top, color) => {
      const el = d.createElement('div');
      el.className = 'mpa-note-icon';
      el.dataset.noteId = id;
      el.dataset.noteKind = kind;
      el.style.setProperty('--mpa-y', px(top));
      el.style.setProperty('--mpa-color', color);
      el.innerHTML = NOTE_ICON_SVG;
      layer.appendChild(el);
    };

    for (const h of state.doc.data.highlights) {
      const range = this.rangeFor(h);
      if (!range) continue;
      const color = HEX_COLOR_RE.test(h.color || '') ? h.color : settings.highlightColor;
      const rects = lineRects(range.getClientRects()).map((r) => ({
        left: r.left - origin.left,
        top: r.top - origin.top,
        width: r.width,
        height: r.height,
      }));
      if (!rects.length) continue;
      this.drawn.set(h.id, rects);
      for (const r of rects) {
        const el = d.createElement('div');
        el.className = 'mpa-highlight';
        el.dataset.highlightId = h.id;
        el.style.setProperty('--mpa-x', px(r.left));
        el.style.setProperty('--mpa-y', px(r.top));
        el.style.setProperty('--mpa-w', px(r.width));
        el.style.setProperty('--mpa-h', px(r.height));
        el.style.setProperty('--mpa-color', color);
        layer.appendChild(el);
      }
      if (h.note && h.note.trim()) icon(h.id, 'highlight', rects[0].top + rects[0].height / 2, color);
    }

    for (const n of state.doc.data.notes) {
      const at = n.epub && Array.isArray(n.epub.at) ? this.pointAt(n.epub.at) : null;
      if (!at) continue;
      /* Measured over a character beside the point: a collapsed range at
         the end of a text node can have no box at all. */
      const length = at.node.nodeValue ? at.node.nodeValue.length : 0;
      const from = at.offset < length ? at.offset : Math.max(0, length - 1);
      const range = d.createRange();
      range.setStart(at.node, from);
      range.setEnd(at.node, Math.min(from + 1, length));
      const r = range.getClientRects()[0] || range.getBoundingClientRect();
      icon(n.id, 'note', r.top - origin.top + r.height / 2, settings.highlightColor);
    }
  }

  refreshModeButton() {
    if (this.modeButton) this.plugin.styleModeButton(this.modeButton);
    const d = this.frame && this.frame.contentDocument;
    if (d) {
      d.documentElement.classList.toggle('mpa-mode-active', this.plugin.highlightMode);
      d.documentElement.style.setProperty('--mpa-mode-color', this.plugin.settings.highlightColor);
    }
  }

  /* Scrolls an annotation to a third of the way down the window. */
  goTo(id) {
    const state = this.plugin.views.get(this);
    if (!state || !state.doc) return false;
    const found = findAnnotation(state.doc.data, id);
    if (!found) return false;
    let position = null;
    if (found.kind === 'highlight') {
      const range = this.rangeFor(found.obj);
      if (range) {
        this.scrollToRect(range.getClientRects()[0] || range.getBoundingClientRect());
        return true;
      }
      position = found.obj.epub && found.obj.epub.start;
    } else {
      position = found.obj.epub && found.obj.epub.at;
    }
    if (!position) return false;
    this.scrollToPosition(position, 0.3);
    return true;
  }

  scrollToPosition(position, fraction) {
    const at = this.pointAt(position);
    if (!at) return;
    const range = this.frame.contentDocument.createRange();
    range.setStart(at.node, at.offset);
    range.collapse(true);
    const rect = range.getClientRects()[0] || (at.node.nodeType === 1 ? at.node.getBoundingClientRect() : at.node.parentElement.getBoundingClientRect());
    this.scrollToRect(rect, fraction);
  }

  scrollToRect(rect, fraction = 0.3) {
    const win = this.frame.contentWindow;
    win.scrollBy(0, rect.top - win.innerHeight * fraction);
  }

  /* ------------------------------------------------------------ the mouse */

  listen(d) {
    const win = d.defaultView;
    const plugin = this.plugin;
    const state = () => plugin.views.get(this);

    d.addEventListener('keydown', (e) => {
      this.hidePreview();
      plugin.selectionBar.hide();
      plugin.onKeyDown(e);
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey || e.altKey || e.key === 'Escape')) return;
      /* Copying, cutting, pasting and selecting all belong to the book's text. */
      if ((e.metaKey || e.ctrlKey) && !e.altKey && ['c', 'x', 'v', 'a'].includes((e.key || '').toLowerCase())) return;
      /* The keyboard moves from the book to its view first. A palette or
         dialog opened by the key gives the focus back afterwards to wherever
         it was, and Obsidian cannot give it back to an element inside the
         book, which lacks its additions to the DOM. */
      this.contentEl.tabIndex = -1;
      this.contentEl.focus({ preventScroll: true });
      /* Keys pressed in the book never reach Obsidian's own window, where its
         hotkeys listen, so a copy is passed on: Cmd+P and the rest work while
         reading, and Esc closes an open menu. */
      const copy = new KeyboardEvent('keydown', {
        key: e.key,
        code: e.code,
        location: e.location,
        repeat: e.repeat,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        bubbles: true,
        cancelable: true,
      });
      this.containerEl.ownerDocument.body.dispatchEvent(copy);
      if (copy.defaultPrevented) e.preventDefault();
    }, true);
    d.addEventListener('mousedown', (e) => {
      plugin.selectionBar.hide();
      /* A click in the book is a click away from the card in hand; it never
         reaches the window where that is otherwise noticed. */
      for (const sidebar of plugin.sidebars()) sidebar.pressedElsewhere(e);
      this.pressedAt = { x: e.clientX, y: e.clientY };
      plugin.recentView = this;
      /* Clicking into the book makes it the document in front, as clicking
         into a PDF does: the sidebar follows. */
      if (this.app.workspace.activeLeaf !== this.leaf) this.app.workspace.setActiveLeaf(this.leaf, { focus: false });
      plugin.refreshFocus();
      this.hidePreview(true);
    });
    d.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;
      if (!plugin.highlightMode) {
        const s = state();
        if (s && s.doc) window.setTimeout(() => this.offerSelection(s.doc), 0);
        return;
      }
      const s = state();
      if (!s || !s.doc || !plugin.canEdit(s.doc)) return;
      const id = this.highlightSelection(s.doc);
      if (id) plugin.showInSidebar(s.doc, id);
    });
    d.addEventListener('click', (e) => this.onClick(e, state()));
    d.addEventListener('contextmenu', (e) => this.onContextMenu(e, state()));
    d.addEventListener('mouseover', (e) => this.onOver(e));
    d.addEventListener('mouseout', (e) => this.onOut(e));
    win.addEventListener('scroll', () => {
      this.hidePreview();
      plugin.selectionBar.hide();
      if (this.placeTimer) window.clearTimeout(this.placeTimer);
      this.placeTimer = window.setTimeout(() => this.notePlace(), 300);
    }, { passive: true });
  }

  /* The highlight or note marker under a point, if any. */
  hitAt(x, y) {
    const d = this.frame.contentDocument;
    const el = d.elementFromPoint(x, y);
    const icon = el && el.closest('.mpa-note-icon');
    if (icon) return { kind: icon.dataset.noteKind, id: icon.dataset.noteId, icon: true };
    const origin = d.body.getBoundingClientRect();
    const px = x - origin.left;
    const py = y - origin.top;
    for (const [id, rects] of this.drawn) {
      if (rects.some((r) => px >= r.left && px <= r.left + r.width && py >= r.top && py <= r.top + r.height)) {
        return { kind: 'highlight', id, icon: false };
      }
    }
    return null;
  }

  onClick(e, state) {
    if (e.button !== 0 || !state || !state.doc) return;
    /* The end of a drag is not a click on whatever it ended over. */
    const from = this.pressedAt;
    if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 3) return;
    /* Every link is handled here, so the frame itself never navigates away
       from the book. */
    const link = isElement(e.target) ? e.target.closest('a, area') : null;
    if (link) {
      e.preventDefault();
      this.followLink(link);
      return;
    }
    const selection = this.frame.contentWindow.getSelection();
    if (selection && !selection.isCollapsed) return;
    const hit = this.hitAt(e.clientX, e.clientY);
    if (!hit) return;
    this.plugin.revealAnnotation(state.doc, hit.id, true).catch((err) => this.plugin.report('could not show the note', err));
  }

  followLink(link) {
    const href = link.getAttribute('href') || link.getAttributeNS(XLINK_NS, 'href') || '';
    if (href.startsWith('#')) {
      const target = this.linkTarget(link);
      if (target) this.scrollToRect(target.getBoundingClientRect(), 0.1);
      return;
    }
    if (/^(https?|mailto):/i.test(href)) window.open(href);
  }

  /* Where a link within the book leads. A book's own ids are kept as they
     are, so its stylesheets and pictures still find them, which means two
     chapters may share one; a link is therefore looked up within the chapter
     it names. Older books mark a place with <a name>, not an id. */
  linkTarget(link) {
    const m = /^#mpa(\d+)$/.exec(link.getAttribute('href') || '');
    const section = m && this.sections[Number(m[1])];
    if (!section) return null;
    const fragment = link.getAttribute('data-mpa-fragment');
    if (!fragment) return section;
    const esc = CSS.escape(fragment);
    return section.querySelector(`[id="${esc}"]`) || section.querySelector(`a[name="${esc}"]`) || null;
  }

  onContextMenu(e, state) {
    if (!state || !state.doc) return;
    /* Always ours inside a book: the browser's own menu has nothing to offer
       there, and on a Mac it holds up the whole window while it is open. */
    e.preventDefault();
    const plugin = this.plugin;
    const doc = state.doc;
    const buttons = [];
    const add = (icon, label, run) => buttons.push({ icon, label, run });
    const win = this.frame.contentWindow;
    const selection = win.getSelection();
    /* Only when the right-click is on the selection itself. */
    const onSelection =
      !!selection && !selection.isCollapsed && !!selection.rangeCount && pointInRange(selection.getRangeAt(0), e.clientX, e.clientY);
    plugin.selectionBar.hide();
    const hit = onSelection ? null : this.hitAt(e.clientX, e.clientY);
    if (onSelection) {
      const text = selection.toString();
      buttons.push(...selectionButtons(plugin.selectionActions(doc, (c) => this.highlightSelection(doc, c), () => text), plugin.menuColours()));
    } else if (hit && hit.kind === 'note') {
      if (!doc.readOnly) {
        add('sticky-note', 'Edit note', () => plugin.revealAnnotation(doc, hit.id, true));
        add('eraser', 'Remove note', () => plugin.deleteAnnotation(doc, hit.id));
      }
    } else if (hit) {
      const found = findAnnotation(doc.data, hit.id);
      const hasNote = !!(found && found.obj.note);
      if (!doc.readOnly) add('sticky-note', hasNote ? 'Edit note' : 'Add note', () => plugin.revealAnnotation(doc, hit.id, true));
      if (found) add('copy', 'Copy', () => plugin.copyText(found.obj.text || ''));
      if (!doc.readOnly) {
        if (hasNote) {
          add('eraser', 'Remove note', () => {
            const current = findAnnotation(doc.data, hit.id);
            if (!current) return;
            current.obj.note = '';
            plugin.commit(doc, 'removing a note');
          });
        }
        add('trash-2', 'Remove highlight', () => plugin.deleteAnnotation(doc, hit.id));
      }
    } else if (!doc.readOnly) {
      const caret = caretRangeAt(this.frame.contentDocument, e.clientX, e.clientY);
      const position = caret && this.positionOf(caret.startContainer, caret.startOffset);
      if (position) add('sticky-note', 'Add note', () => this.addNoteAt(doc, position));
    }
    const look = plugin.lookUpButton(win, e, onSelection);
    if (look) buttons.push(look);
    if (!buttons.length) return;
    const frameBox = this.frame.getBoundingClientRect();
    const x = frameBox.left + e.clientX;
    const y = frameBox.top + e.clientY;
    plugin.selectionBar.show({ left: x, right: x, top: y, bottom: y }, buttons, this.containerEl.ownerDocument);
  }

  /* Highlight mode off: a selection in the book gets the small bar. */
  offerSelection(doc) {
    if (!this.frame) return;
    const selection = this.frame.contentWindow.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const frameBox = this.frame.getBoundingClientRect();
    this.plugin.selectionBar.show(
      selectionEnd(selection.getRangeAt(0), frameBox),
      this.plugin.selectionActions(doc, (c) => this.highlightSelection(doc, c), () => selection.toString()),
      this.containerEl.ownerDocument
    );
  }

  addNoteAt(doc, position) {
    if (!this.plugin.canEdit(doc)) return;
    const note = { id: uuid(), text: '', createdAt: new Date().toISOString(), epub: { at: position } };
    doc.data.notes.push(note);
    this.plugin.commit(doc, 'adding a note');
    this.plugin.revealAnnotation(doc, note.id, true).catch((err) => this.plugin.report('could not show the note', err));
  }

  /* The selection as a highlight, snapped to whole words unless that is
     turned off. Returns its id. */
  highlightSelection(doc, colour) {
    const win = this.frame.contentWindow;
    const selection = win.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    let start = this.positionOf(range.startContainer, range.startOffset);
    let end = this.positionOf(range.endContainer, range.endOffset);
    /* A selection that starts or ends outside the chapters, in a margin say,
       is cut to the chapters it covers. */
    if (!start || !end) {
      const inside = this.sections.filter((s) => range.intersectsNode(s));
      if (!inside.length) return null;
      if (!start) start = [Number(inside[0].dataset.section), 0];
      if (!end) {
        const lastIndex = Number(inside[inside.length - 1].dataset.section);
        end = [lastIndex, this.sectionText(lastIndex).length];
      }
    }
    const snap = this.plugin.settings.snapToWords;
    start = [start[0], snapOffset(this.sectionText(start[0]), start[1], 'start', snap)];
    end = [end[0], snapOffset(this.sectionText(end[0]), end[1], 'end', snap)];
    if (compareOrder(start, end) >= 0) return null;
    const exact = this.rangeBetween(start, end);
    const text = exact ? collapseWhitespace(exact.toString()) : '';
    if (!text) return null;

    const highlight = {
      id: uuid(),
      text,
      note: '',
      color: HEX_COLOR_RE.test(colour || '') ? colour : this.plugin.settings.highlightColor,
      createdAt: new Date().toISOString(),
      epub: { start, end },
    };
    doc.data.highlights.push(highlight);
    selection.removeAllRanges();
    this.plugin.commit(doc, 'adding a highlight');
    return highlight.id;
  }

  /* ----------------------------------------------------- footnote preview */

  /* As in a PDF: resting on a link to another place in the book shows what
     is there, and clicking it goes there. Drawn inside the frame, so a
     book's markup never leaves the sandbox. */
  onOver(e) {
    const win = this.frame.contentWindow;
    const t = e.target;
    if (!isElement(t)) return;
    if (this.preview && this.preview.el && this.preview.el.contains(t)) {
      this.cancelHidePreview();
      return;
    }
    const link = t.closest('a[href^="#mpa"], area[href^="#mpa"]');
    if (!link || (this.preview && this.preview.link === link)) {
      if (link) this.cancelHidePreview();
      return;
    }
    this.hidePreview();
    const token = (this.previewToken = (this.previewToken || 0) + 1);
    this.preview = { link, el: null, timer: window.setTimeout(() => this.showPreview(link, token), FOOTNOTE_DELAY) };
  }

  onOut(e) {
    if (!this.preview) return;
    const win = this.frame.contentWindow;
    const inside = (node) =>
      isNode(node) && (this.preview.link.contains(node) || (!!this.preview.el && this.preview.el.contains(node)));
    if (!inside(e.target) || inside(e.relatedTarget)) return;
    this.cancelHidePreview();
    this.preview.hideTimer = window.setTimeout(() => this.hidePreview(), FOOTNOTE_GRACE);
  }

  cancelHidePreview() {
    if (this.preview && this.preview.hideTimer) {
      window.clearTimeout(this.preview.hideTimer);
      this.preview.hideTimer = null;
    }
  }

  hidePreview(keepIfInside) {
    const p = this.preview;
    if (!p) return;
    if (keepIfInside === true && p.el && p.el.matches(':hover')) return;
    window.clearTimeout(p.timer);
    window.clearTimeout(p.hideTimer);
    if (p.el) p.el.remove();
    this.preview = null;
    this.previewToken = (this.previewToken || 0) + 1;
  }

  showPreview(link, token) {
    if (token !== this.previewToken || !this.preview) return;
    const d = this.frame.contentDocument;
    const target = this.linkTarget(link);
    if (!target) return;
    const el = d.createElement('div');
    el.className = 'mpa-epub-footnote';
    const inner = d.createElement('div');
    inner.className = 'mpa-epub-footnote-text';
    el.appendChild(inner);
    for (const block of previewBlocks(target)) inner.appendChild(block.cloneNode(true));
    /* Ids in the copy would be found by the next link instead of the real
       place, and links in it would lead nowhere useful. */
    for (const node of inner.querySelectorAll('[id]')) node.removeAttribute('id');
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hidePreview();
      this.scrollToRect(target.getBoundingClientRect(), 0.1);
    });
    d.documentElement.appendChild(el);
    /* Faded at the foot only when there is more than fits. */
    if (inner.scrollHeight > inner.clientHeight + 1) inner.classList.add('is-long');
    const win = d.defaultView;
    const r = link.getBoundingClientRect();
    const at = placeBox(
      { left: r.left, top: r.top, bottom: r.bottom },
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: win.innerWidth, height: win.innerHeight }
    );
    el.style.left = `${at.left}px`;
    el.style.top = `${at.top}px`;
    this.preview.el = el;
  }
}

/* What a footnote preview shows for the place a link leads to: the element
   itself if it is a block, such as a list item or an aside, or the block it
   sits in; for a whole chapter or more, its first few blocks. */
function previewBlocks(target) {
  const BLOCKS = 'p, li, aside, dd, dt, blockquote, td, figure, div, section';
  let el = target;
  if (!el.matches(BLOCKS) || el.matches('.mpa-section')) {
    const block = el.closest(BLOCKS);
    if (block && !block.matches('.mpa-section')) el = block;
  }
  const big = el.matches('.mpa-section, section, body') || el.children.length > 6;
  if (!big) return [el];
  return Array.from(el.children).slice(0, 3);
}

function caretRangeAt(d, x, y) {
  if (d.caretRangeFromPoint) return d.caretRangeFromPoint(x, y);
  const pos = d.caretPositionFromPoint && d.caretPositionFromPoint(x, y);
  if (!pos) return null;
  const range = d.createRange();
  range.setStart(pos.offsetNode, pos.offset);
  return range;
}

/* The rectangles of a range, one per line: the browser reports one per text
   node, so a line with italics in it comes back in pieces. */
function lineRects(rectList) {
  const lines = [];
  for (const r of Array.from(rectList)) {
    if (r.width < 0.5 || r.height < 0.5) continue;
    const line = lines.find((l) => Math.abs(l.top - r.top) < r.height / 2 && Math.abs(l.bottom - r.bottom) < r.height / 2);
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else {
      lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
  }
  return lines.map((l) => ({ left: l.left, top: l.top, width: l.right - l.left, height: l.bottom - l.top }));
}

/* Moves an offset in a chapter's text to the edge of the word it falls in,
   and off any spaces, so a highlight starts and ends on words. With
   snapping off, only the spaces are trimmed. */
function snapOffset(text, offset, side, snap) {
  let i = Math.max(0, Math.min(offset, text.length));
  const word = (ch) => !!ch && WORD_CHAR_RE.test(ch);
  if (side === 'start') {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (snap) while (i > 0 && word(text[i - 1]) && word(text[i])) i--;
  } else {
    while (i > 0 && /\s/.test(text[i - 1])) i--;
    if (snap) while (i < text.length && word(text[i - 1]) && word(text[i])) i++;
  }
  return i;
}

/* Finds a book highlight's words when its place no longer holds them, across
   the chapters it ran over: the texts of those chapters are searched as one,
   as the highlight's own text was taken from them, and the place found is
   given back as [chapter, offset] at each end. */
function findQuoteAcross(texts, first, last, quote, near) {
  const from = Math.max(0, first);
  const to = Math.min(texts.length - 1, last);
  if (to < from) return null;
  const starts = [];
  let joined = '';
  for (let i = from; i <= to; i++) {
    starts.push(joined.length);
    joined += texts[i] || '';
  }
  const found = findQuote(joined, quote, starts[0] + near);
  if (!found) return null;
  const at = (index) => {
    for (let k = starts.length - 1; k >= 0; k--) {
      if (starts[k] <= index) return [from + k, index - starts[k]];
    }
    return [from, index];
  };
  /* An end exactly on a chapter's start belongs to the end of the one before. */
  const end = at(found.end);
  if (end[1] === 0 && end[0] > from) end.splice(0, 2, end[0] - 1, (texts[end[0] - 1] || '').length);
  return { start: at(found.start), end };
}

function sameWords(a, b) {
  return collapseWhitespace(a || '') === collapseWhitespace(b || '');
}

/* Finds a highlight's words in its chapter's text, whatever the spacing,
   taking the occurrence nearest where it used to be. */
function findQuote(text, quote, near) {
  const words = collapseWhitespace(quote);
  if (!words) return null;
  const pattern = new RegExp(words.split(' ').map(escapeRegExp).join('\\s+'), 'g');
  let best = null;
  let m;
  while ((m = pattern.exec(text))) {
    const candidate = { start: m.index, end: m.index + m[0].length };
    if (!best || Math.abs(candidate.start - near) < Math.abs(best.start - near)) best = candidate;
    if (m[0].length === 0) pattern.lastIndex++;
  }
  return best;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validTextSize(value) {
  return typeof value === 'number' && TEXT_SIZES.includes(value);
}

/* ------------------------------------------------------- reading the file */

/* The most one file inside a book, and the whole book, may unpack to. Far
   beyond any real book; a limit only for files built to be one. */
const ZIP_ENTRY_LIMIT = 64 * 1024 * 1024;
const ZIP_TOTAL_LIMIT = 512 * 1024 * 1024;

/* The files inside a zip, from its central directory. Only what an EPUB
   uses: stored or deflated entries, no encryption, no zip64. */
function readZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip file');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('damaged zip directory');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.set(name, { name, flags, method, packed, size, local });
    at += 46 + nameLength + extraLength + commentLength;
  }

  let unpacked = 0;
  async function read(name) {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.flags & 1) throw new Error(`${name} is encrypted`);
    const l = entry.local;
    if (view.getUint32(l, true) !== 0x04034b50) throw new Error(`damaged zip entry ${name}`);
    const start = l + 30 + view.getUint16(l + 26, true) + view.getUint16(l + 28, true);
    const data = bytes.subarray(start, start + entry.packed);
    if (entry.method === 0) return data.slice();
    if (entry.method !== 8) throw new Error(`${name} uses an unsupported compression`);
    /* Unpacked a piece at a time and stopped at a limit, so a file made to
       unpack to far more than it holds cannot use up the memory. */
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      unpacked += value.length;
      if (total > ZIP_ENTRY_LIMIT || unpacked > ZIP_TOTAL_LIMIT) {
        reader.cancel().catch(() => null);
        throw new Error(`${name} unpacks to more than a book can hold`);
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  return {
    names: () => Array.from(entries.keys()),
    has: (name) => entries.has(name),
    read,
    async text(name) {
      const data = await read(name);
      return data === null ? null : new TextDecoder().decode(data);
    },
  };
}

const XLINK_NS = 'http://www.w3.org/1999/xlink';

/* Percent-decoding that leaves a stray "%" alone rather than throwing. */
function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch (e) {
    return text;
  }
}

/* A path inside the book, from a link written relative to another file. */
function resolveBookPath(from, href) {
  const clean = safeDecode(String(href).split('#')[0].split('?')[0]);
  if (!clean) return from;
  const parts = clean.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const part of clean.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/* Font obfuscation is not DRM: it is how a book carries its fonts legally,
   and the text is untouched. Anything else that is encrypted is. */
const FONT_OBFUSCATION = ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'];

function drmProtected(encrypted) {
  return encrypted.some((entry) => !FONT_OBFUSCATION.includes(entry.algorithm));
}

const MEDIA_EXTENSIONS = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  css: 'text/css',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

async function loadEpub(buffer) {
  const blobs = [];
  try {
    return await readBook(buffer, blobs);
  } catch (e) {
    for (const url of blobs) URL.revokeObjectURL(url);
    throw e;
  }
}

async function readBook(buffer, blobs) {
  const zip = readZip(buffer);
  const parse = (text, type) => new DOMParser().parseFromString(text, type);
  const broken = (d) => !d || d.getElementsByTagName('parsererror').length > 0;

  if (zip.has('META-INF/rights.xml')) {
    return { problem: 'This book is protected by DRM, so it can’t be opened here.', blobs: [] };
  }
  const encryption = await zip.text('META-INF/encryption.xml');
  if (encryption) {
    const d = parse(encryption, 'application/xml');
    const encrypted = Array.from(d.getElementsByTagNameNS('*', 'EncryptedData')).map((el) => {
      const method = el.getElementsByTagNameNS('*', 'EncryptionMethod')[0];
      return { algorithm: method ? method.getAttribute('Algorithm') : '' };
    });
    if (drmProtected(encrypted)) {
      return { problem: 'This book is protected by DRM, so it can’t be opened here.', blobs: [] };
    }
  }

  const container = parse((await zip.text('META-INF/container.xml')) || '', 'application/xml');
  const rootfile = !broken(container) && container.getElementsByTagNameNS('*', 'rootfile')[0];
  const opfPath = rootfile && rootfile.getAttribute('full-path');
  const opfText = opfPath && (await zip.text(opfPath));
  if (!opfText) throw new Error('no package document');
  const opf = parse(opfText, 'application/xml');
  if (broken(opf)) throw new Error('the package document could not be read');

  const metas = Array.from(opf.getElementsByTagNameNS('*', 'meta'));
  const layout = metas.find((m) => m.getAttribute('property') === 'rendition:layout');
  if (layout && layout.textContent.trim() === 'pre-paginated') {
    return {
      problem: 'This is a fixed-layout book, made of pages like a picture book or a magazine. Only books whose text flows can be opened here.',
      blobs: [],
    };
  }
  const titleEl = opf.getElementsByTagNameNS('*', 'title')[0];

  const manifest = new Map();
  for (const item of Array.from(opf.getElementsByTagNameNS('*', 'item'))) {
    manifest.set(item.getAttribute('id'), {
      path: resolveBookPath(opfPath, item.getAttribute('href') || ''),
      type: item.getAttribute('media-type') || '',
    });
  }
  const spine = Array.from(opf.getElementsByTagNameNS('*', 'itemref'))
    .map((ref) => manifest.get(ref.getAttribute('idref')))
    .filter((item) => item && /html/.test(item.type));
  if (!spine.length) throw new Error('the book has no chapters');

  /* Every image and font as a blob URL the frame can load. */
  const urls = new Map();
  const typeOf = (p) => MEDIA_EXTENSIONS[(p.split('.').pop() || '').toLowerCase()] || '';
  const others = zip.names().filter((p) => typeOf(p) && typeOf(p) !== 'text/css');
  for (const p of others) {
    const data = await zip.read(p);
    const url = URL.createObjectURL(new Blob([data], { type: typeOf(p) }));
    blobs.push(url);
    urls.set(p, url);
  }
  const rewriteCss = (css, from) =>
    css
      .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, q, href) => {
        if (/^(data|https?|blob):/i.test(href)) return whole;
        const url = urls.get(resolveBookPath(from, href));
        return url ? `url("${url}")` : whole;
      })
      .replace(/@import\s+[^;]+;/g, '');
  /* Stylesheets go in as text: one loaded from a blob URL under Obsidian's
     app:// scheme is treated as foreign, and its rules are never applied. */
  const sheets = new Map();
  for (const p of zip.names().filter((n) => typeOf(n) === 'text/css')) {
    sheets.set(p, rewriteCss((await zip.text(p)) || '', p));
  }

  const sectionOf = new Map(spine.map((item, i) => [item.path, i]));
  /* Which chapters use each stylesheet. A book is shown as one document, so
     a stylesheet only some chapters link to, and the styles written inside a
     chapter, are kept to those chapters: a title page's
     "body { text-align: center }" would otherwise centre the whole book. */
  const linked = new Map();
  const inline = new Map();
  const sections = [];
  for (const [i, item] of spine.entries()) {
    const text = (await zip.text(item.path)) || '';
    let d = parse(text, 'application/xhtml+xml');
    if (broken(d)) d = parse(text, 'text/html');
    for (const link of Array.from(d.querySelectorAll('link[rel~="stylesheet"][href]'))) {
      const css = sheets.get(resolveBookPath(item.path, link.getAttribute('href')));
      if (css === undefined) continue;
      if (!linked.has(css)) linked.set(css, new Set());
      linked.get(css).add(i);
    }
    for (const style of Array.from(d.querySelectorAll('style'))) {
      const css = rewriteCss(style.textContent || '', item.path);
      if (!inline.has(css)) inline.set(css, new Set());
      inline.get(css).add(i);
    }
    const body = d.body || d.getElementsByTagName('body')[0] || d.documentElement;
    prepareChapter(body, i, item.path, urls, sectionOf);
    sections.push({ body, bodyClass: body.getAttribute && body.getAttribute('class') });
  }

  dropHeadingBackLinks(sections.map((section) => section.body));
  const roots = (users) => Array.from(users, (i) => `#mpa${i}`).join(', ');
  const inlineStyles = Array.from(inline, ([css, users]) => scopeCss(css, roots(users)));
  const styles = [];
  for (const [css, users] of linked) {
    styles.push(users.size === spine.length ? css : scopeCss(css, roots(users)));
  }
  return { title: titleEl ? titleEl.textContent.trim() : '', sections, styles, inlineStyles, blobs };
}

/* Readies a chapter for the frame: no scripts, no styles of its own (they
   have been collected already), links within the book pointed at the
   chapter they lead to, and pictures pointed at their blob URLs. */
function prepareChapter(body, index, path, urls, sectionOf) {
  for (const el of Array.from(body.querySelectorAll('script, noscript, iframe, object, embed, base, meta, link, style'))) el.remove();
  const XLINK = XLINK_NS;
  for (const el of Array.from(body.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
    const tag = el.localName;
    if ((tag === 'a' || tag === 'area') && (el.hasAttribute('href') || el.hasAttributeNS(XLINK, 'href'))) {
      const href = el.getAttribute('href') || el.getAttributeNS(XLINK, 'href');
      el.removeAttributeNS(XLINK, 'href');
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        el.setAttribute('href', href);
        continue;
      }
      const at = href.indexOf('#');
      const file = at < 0 ? href : href.slice(0, at);
      const fragment = at < 0 ? '' : safeDecode(href.slice(at + 1));
      const section = sectionOf.get(file ? resolveBookPath(path, file) : path);
      if (section === undefined) {
        el.removeAttribute('href');
        continue;
      }
      el.setAttribute('href', `#mpa${section}`);
      if (fragment) el.setAttribute('data-mpa-fragment', fragment);
      continue;
    }
    for (const name of ['src', 'href', 'poster']) {
      const value = name === 'href' && !el.hasAttribute('href') ? el.getAttributeNS(XLINK, 'href') : el.getAttribute(name);
      if (!value || /^(data|https?|blob):/i.test(value)) continue;
      const url = urls.get(resolveBookPath(path, value));
      if (!url) continue;
      if (name === 'href' && !el.hasAttribute('href')) el.setAttributeNS(XLINK, 'xlink:href', url);
      else el.setAttribute(name, url);
    }
  }
}

/* A stylesheet kept to some chapters, given as a selector for their
   sections. Its rules go inside @scope, where "body" and "html" stand for the
   chapter itself. Fonts, imports and page boxes cannot be scoped and are
   harmless to share, so they stay as they are. */
function scopeCss(css, roots) {
  const shared = [];
  const scoped = [];
  for (const rule of cssRules(css)) {
    if (/^@(font-face|import|charset|namespace|page)\b/i.test(rule) || (/^@layer\b/i.test(rule) && !rule.includes('{'))) shared.push(rule);
    else scoped.push(rootSelectorsToScope(rule));
  }
  if (!scoped.length) return shared.join('\n');
  return `${shared.join('\n')}\n@scope (${roots}) {\n${scoped.join('\n')}\n}`;
}

/* A stylesheet's top-level rules, as text. Comments and quoted strings are
   stepped over, so a brace inside either does not count. */
function cssRules(css) {
  const rules = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < css.length && css[k] !== c) k += css[k] === '\\' ? 2 : 1;
      i = k;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        rules.push(css.slice(start, i + 1));
        start = i + 1;
      }
    } else if (c === ';' && depth === 0) {
      rules.push(css.slice(start, i + 1));
      start = i + 1;
    }
  }
  /* An unfinished last rule is left out, and so is anything that is neither
     a block nor a statement, such as a stray closing brace, which would
     otherwise close the @scope it is put in and let what follows out. */
  return rules
    .map((r) => r.replace(/^(\s|\/\*[\s\S]*?\*\/)+/, '').trim())
    .filter((r) => r && (r.endsWith('}') ? r.includes('{') : r.endsWith(';') && r.startsWith('@')));
}

/* "body", "html" and "html body" in a rule's selectors become ":scope",
   inside @media and @supports too. */
function rootSelectorsToScope(rule) {
  const open = rule.indexOf('{');
  if (open < 0) return rule;
  const prelude = rule.slice(0, open);
  const inner = rule.slice(open + 1, rule.lastIndexOf('}'));
  if (prelude.trim().startsWith('@')) {
    return `${prelude}{\n${cssRules(inner).map(rootSelectorsToScope).join('\n')}\n}`;
  }
  return `${scopeSelectorList(prelude)}{${inner}}`;
}

/* Each selector in a list, with html and body standing for the chapter: a
   leading html is dropped when a body follows it, and the rest of html or
   body becomes :scope, keeping any class, id or attribute on it. Quoted
   values and brackets are stepped over, so ".html" or [title=" body"] are
   left as they are. */
function scopeSelectorList(list) {
  return splitTopLevel(list, (c) => c === ',')
    .map((selector) => {
      const parts = splitTopLevel(selector, (c) => /[\s>+~]/.test(c), true);
      const compounds = parts.filter((p) => !/^[\s>+~]+$/.test(p));
      const root = (p) => /^(html|body)(?![\w-])/i.test(p);
      if (compounds.length > 1 && /^html(?![\w-])/i.test(compounds[0]) && /^body(?![\w-])/i.test(compounds[1])) {
        const first = parts.indexOf(compounds[0]);
        const second = parts.indexOf(compounds[1]);
        parts.splice(first, second - first);
      }
      return parts.map((p) => (root(p) ? p.replace(/^(html|body)/i, ':scope') : p)).join('');
    })
    .join(',');
}

/* Splits a selector at characters `at` accepts, outside quotes, brackets
   and parentheses. With `keep`, the separators are kept as pieces of their
   own. */
function splitTopLevel(text, at, keep) {
  const out = [];
  let piece = '';
  let separator = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      piece += c;
      if (c === '\\' && i + 1 < text.length) piece += text[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && !quote && at(c)) {
      if (piece) out.push(piece);
      piece = '';
      if (keep) separator += c;
      continue;
    }
    if (separator) {
      out.push(separator);
      separator = '';
    }
    piece += c;
  }
  if (separator && keep) out.push(separator);
  if (piece) out.push(piece);
  return keep ? out : out.map((p) => p);
}

/* A chapter heading made into a link back to its table-of-contents entry,
   as Calibre and others make them, would take the reader away from the
   chapter they have just arrived at. Such a link is dropped and its words
   kept: a link in a heading whose target links straight back to that
   heading. Other links in headings are left alone. */
function dropHeadingBackLinks(bodies) {
  const HEADINGS = 'h1, h2, h3, h4, h5, h6';
  for (const [i, body] of bodies.entries()) {
    if (!body || !body.querySelectorAll) continue;
    for (const link of Array.from(body.querySelectorAll('h1 a[href], h2 a[href], h3 a[href], h4 a[href], h5 a[href], h6 a[href]'))) {
      const m = /^#mpa(\d+)$/.exec(link.getAttribute('href') || '');
      const fragment = link.getAttribute('data-mpa-fragment');
      const other = m && bodies[Number(m[1])];
      if (!other || !fragment) continue;
      const esc = CSS.escape(fragment);
      const target = other.querySelector(`[id="${esc}"]`) || other.querySelector(`a[name="${esc}"]`);
      if (!target) continue;
      const heading = link.closest(HEADINGS);
      /* The link is the heading's title, all of it: a footnote marker in a
         heading is a link too, and its note links back to it. */
      if (collapseWhitespace(link.textContent) !== collapseWhitespace(heading.textContent)) continue;
      /* The heading's own name, not that of anything inside the link. */
      const ids = new Set(
        [heading, ...heading.querySelectorAll('[id], a[name]')]
          .filter((el) => el === heading || !link.contains(el) || el === link)
          .filter((el) => !(el.matches('a[href]') && el !== link))
          .map((el) => el.getAttribute('id') || el.getAttribute('name'))
          .filter(Boolean)
      );
      const area = target.matches('a[href]') ? target : target.closest('li, p') || target;
      const links = [...(area.matches('a[href]') ? [area] : []), ...area.querySelectorAll('a[href]')];
      const back = links.some(
        (a) => a.getAttribute('href') === `#mpa${i}` && ids.has(a.getAttribute('data-mpa-fragment') || '')
      );
      if (!back) continue;
      while (link.firstChild) link.parentNode.insertBefore(link.firstChild, link);
      link.remove();
    }
  }
}

function revokeBook(book) {
  for (const url of (book && book.blobs) || []) URL.revokeObjectURL(url);
}

const NOTE_ICON_SVG =
  '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/></svg>';

/* The frame's defaults, filled in from Obsidian's theme: {{name|fallback}}
   is the value of --name. A book's own stylesheet comes after, and wins. */
const EPUB_BASE_CSS = `
html { background: {{background-primary|#fff}}; }
body {
  box-sizing: border-box;
  position: relative;
  margin: 0 auto;
  padding: 2.5em 3.5em 50vh;
  color: {{text-normal|#222}};
  font-family: {{font-text|serif}};
  line-height: 1.6;
  overflow-wrap: break-word;
}
img, svg, video { max-width: 100%; height: auto; }
a { color: {{text-accent|#2878c8}}; }
::selection { background: {{text-selection|rgba(40,120,200,0.25)}}; }
.mpa-section + .mpa-section { margin-top: 3em; }
.mpa-epub-footnote {
  background: {{background-primary|#fff}};
  color: {{text-normal|#222}};
  font-family: {{font-text|serif}};
  line-height: 1.5;
  border: 1px solid {{background-modifier-border|#ddd}};
}
`;

/* Ours, after the book's. */
const EPUB_FRAME_CSS = `
.mpa-epub-layer { position: absolute; inset: 0; pointer-events: none; z-index: 3; }
.mpa-highlight {
  position: absolute;
  left: var(--mpa-x); top: var(--mpa-y); width: var(--mpa-w); height: var(--mpa-h);
  background-color: var(--mpa-color, #ffeb3b);
  opacity: 0.4;
  mix-blend-mode: multiply;
  pointer-events: none;
}
.mpa-note-icon {
  position: absolute;
  left: 1em;
  top: var(--mpa-y);
  transform: translateY(-50%);
  width: 14px; height: 14px;
  pointer-events: auto;
  cursor: pointer;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.25));
}
.mpa-note-icon svg { width: 14px; height: 14px; fill: var(--mpa-color, #ffeb3b); stroke: #333; stroke-width: 1.4; }
html.mpa-mode-active ::selection { background: color-mix(in srgb, var(--mpa-mode-color, #ffeb3b) 55%, transparent); }
.mpa-epub-footnote {
  position: fixed;
  z-index: 10;
  box-sizing: border-box;
  max-width: min(30em, calc(100vw - 16px));
  padding: 0.6em 0.9em;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  font-size: 0.9em;
  cursor: pointer;
}
.mpa-epub-footnote-text { max-height: 12em; overflow: hidden; }
.mpa-epub-footnote-text.is-long {
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 1.5em), transparent);
  mask-image: linear-gradient(to bottom, #000 calc(100% - 1.5em), transparent);
}
.mpa-epub-footnote-text :first-child { margin-top: 0; padding-top: 0; }
.mpa-epub-footnote-text :last-child { margin-bottom: 0; padding-bottom: 0; }
`;

/* Hovering a link to another place in the same PDF, which is what a footnote
   or endnote marker is, shows a picture of the place it leads to. A picture
   rather than extracted text: it shows the note as printed,
   formulas and italics included, and there is no guessing where one note
   ends and the next begins. Clicking the preview, or the marker itself, goes
   there. Only links inside the document; a web link is left to the viewer. */
class FootnotePreview {
  constructor(plugin) {
    this.plugin = plugin;
    /** The marker being hovered, or whose preview is showing. */
    this.link = null;
    this.el = null;
    this.showTimer = null;
    this.hideTimer = null;
    /* Changes whenever a preview is put away or another is asked for, so a
       picture that finishes rendering after that is dropped, not shown. */
    this.token = 0;
    /* Resolved destinations, per document, so hovering again is instant. */
    this.targets = new WeakMap();
  }

  over(e) {
    const t = e.target;
    if (!isElement(t)) return;
    if (this.el && this.el.contains(t)) {
      this.cancelHide();
      return;
    }
    const link = t.closest('.annotationLayer .linkAnnotation a');
    if (!link) return;
    if (link === this.link) {
      this.cancelHide();
      return;
    }
    if (!(link.getAttribute('href') || '').startsWith('#')) return;
    const hit = this.plugin.locate(e);
    if (!hit) return;
    this.hide();
    this.link = link;
    const token = this.token;
    this.showTimer = window.setTimeout(() => {
      this.showTimer = null;
      this.show(hit.state, link, token).catch((err) => {
        this.plugin.report('could not preview the link', err);
        if (this.link === link) this.hide();
      });
    }, FOOTNOTE_DELAY);
  }

  /* Leaving the marker or the preview for anywhere but the other one. A
     moment's grace lets the pointer cross the gap between them. */
  out(e) {
    if (!this.link) return;
    const inside = (node) =>
      isNode(node) && (this.link.contains(node) || (!!this.el && this.el.contains(node)));
    if (!inside(e.target) || inside(e.relatedTarget)) return;
    this.cancelHide();
    this.hideTimer = window.setTimeout(() => this.hide(), FOOTNOTE_GRACE);
  }

  pressed(e) {
    if (this.el && isNode(e.target) && this.el.contains(e.target)) return;
    this.hide();
  }

  cancelHide() {
    if (this.hideTimer) window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  hide() {
    if (this.showTimer) window.clearTimeout(this.showTimer);
    this.showTimer = null;
    this.cancelHide();
    if (this.el) this.el.remove();
    this.el = null;
    this.link = null;
    this.token++;
  }

  async show(state, link, token) {
    const inner = pdfInnerOf(state.view);
    const pdf = inner && inner.pdfDocument;
    const pageEl = link.closest('.page');
    const section = link.closest('[data-annotation-id]');
    if (!pdf || !pageEl || !section) return;
    const target = await this.resolve(pdf, pageNumberOf(pageEl), section.dataset.annotationId);
    /* Moved on while that was being worked out. */
    if (!target || this.token !== token) return;
    const win = link.ownerDocument.defaultView || window;
    const width = Math.min(FOOTNOTE_WIDTH, win.innerWidth - 2 * BOX_MARGIN);
    const picture = await this.render(pdf, target, width, win.devicePixelRatio || 1);
    if (!picture || this.token !== token) return;
    if (this.el) this.el.remove();

    const el = link.ownerDocument.body.createDiv({ cls: 'mpa-footnote' });
    el.appendChild(picture);
    el.addEventListener('click', () => {
      if (inner.linkService) inner.linkService.goToDestination(target.dest);
      this.hide();
    });
    const r = link.getBoundingClientRect();
    const at = placeBox(
      { left: r.left, top: r.top, bottom: r.bottom },
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: win.innerWidth, height: win.innerHeight }
    );
    el.style.left = `${at.left}px`;
    el.style.top = `${at.top}px`;
    this.el = el;
  }

  /* The page and point a link leads to. */
  resolve(pdf, pageNumber, annotationId) {
    let cache = this.targets.get(pdf);
    if (!cache) this.targets.set(pdf, (cache = new Map()));
    const key = `${pageNumber}:${annotationId}`;
    if (!cache.has(key)) {
      const found = (async () => {
        const page = await pdf.getPage(pageNumber);
        const link = (await page.getAnnotations()).find((a) => a.id === annotationId);
        if (!link || !link.dest) return null;
        const explicit = typeof link.dest === 'string' ? await pdf.getDestination(link.dest) : link.dest;
        if (!Array.isArray(explicit) || !explicit.length) return null;
        const ref = explicit[0];
        const pageIndex = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref);
        return { dest: link.dest, pageIndex, point: destPoint(explicit) };
      })();
      /* A failure is not remembered: the next hover tries again. */
      found.catch(() => cache.delete(key));
      cache.set(key, found);
    }
    return cache.get(key);
  }

  /* A picture of the region the link leads to, across the text column, as
     wide as the preview. */
  async render(pdf, target, width, ratio) {
    const page = await pdf.getPage(target.pageIndex + 1);
    const text = await page.getTextContent();
    /* Worked out on the page as it appears on screen, so a page turned on
       its side is cut the same way as any other. */
    const base = page.getViewport({ scale: 1 });
    const upright = uprightPage(base, text.items, target.point, page.view);
    const region = footnoteRegion(upright.items, upright.view, upright.point, width / FOOTNOTE_MAX_SCALE);
    const scale = (width / (region.right - region.left)) * ratio;
    const viewport = page.getViewport({ scale });
    const left = region.left * scale;
    const top = (base.height - region.top) * scale;
    const canvas = createEl('canvas', { cls: 'mpa-footnote-picture' });
    canvas.width = Math.max(1, Math.ceil((region.right - region.left) * scale));
    canvas.height = Math.max(1, Math.ceil((region.top - region.bottom) * scale));
    canvas.style.width = `${canvas.width / ratio}px`;
    canvas.style.height = `${canvas.height / ratio}px`;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, transform: [1, 0, 0, 1, -left, -top] }).promise;
    /* For screen readers, and for anyone checking what is shown. */
    canvas.setAttr('role', 'img');
    canvas.setAttr('aria-label', region.text);
    return canvas;
  }
}

/* The small bar that appears by a selection when highlight mode is off:
   Highlight, Add note, Copy. Not a menu: it holds nothing up,
   and goes away by itself on a click elsewhere, a scroll or a key. Pressing
   one of its buttons does not take the selection away, since the press is
   kept from moving the focus. */
class SelectionBar {
  constructor(plugin) {
    this.plugin = plugin;
    this.el = null;
  }

  /* anchor: where the bar belongs, in the window's coordinates: a
     selection's last line, or the point right-clicked. buttons: a list of
     { icon, label, run }, or the actions of a selection. */
  show(anchor, buttons, doc) {
    const list = Array.isArray(buttons) ? buttons : selectionButtons(buttons, this.plugin.menuColours());
    this.hide();
    const home = doc || document;
    const win = home.defaultView || window;
    const el = home.body.createDiv({ cls: 'mpa-selection-bar' });
    const button = (icon, label, run, colour) => {
      const b = el.createEl('button', { cls: 'mpa-selection-button', attr: { 'aria-label': label } });
      setIcon(b.createSpan({ cls: 'mpa-selection-icon' }), icon);
      /* A highlighter shows the colour it highlights in. */
      if (colour) {
        b.addClass('mpa-colour');
        b.style.setProperty('--mpa-color', colour);
      }
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        this.hide();
        try {
          run();
        } catch (err) {
          this.plugin.report(`could not ${label.toLowerCase()}`, err);
        }
      });
    };
    for (const b of list) button(b.icon, b.label, b.run, b.colour);
    const at = placeBox(
      { left: anchor.right - el.offsetWidth / 2, top: anchor.top, bottom: anchor.bottom },
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: win.innerWidth, height: win.innerHeight }
    );
    el.style.left = `${at.left}px`;
    el.style.top = `${at.top}px`;
    this.el = el;
  }

  hide() {
    if (this.el) this.el.remove();
    this.el = null;
  }

  contains(node) {
    return !!this.el && isNode(node) && this.el.contains(node);
  }
}

/* The highlight colours, made sound: hex colours only, none twice, and at
   least one in the menu. Settings from before there was a palette carry
   their one colour into the menu. */
function normalisePalette(settings, defaults) {
  const hex = (list) =>
    Array.isArray(list) ? list.filter((c) => typeof c === 'string' && HEX_COLOR_RE.test(c)).map((c) => expandHex(c).toLowerCase()) : null;
  let menu = hex(settings.menuColours);
  let spare = hex(settings.spareColours);
  if (!menu) {
    menu = [HEX_COLOR_RE.test(settings.highlightColor || '') ? expandHex(settings.highlightColor).toLowerCase() : defaults.menuColours[0]];
    spare = defaults.spareColours.filter((c) => !menu.includes(c));
  }
  const seen = new Set();
  const once = (c) => !seen.has(c) && seen.add(c);
  menu = menu.filter(once);
  spare = (spare || []).filter(once);
  if (!menu.length) menu = spare.length ? [spare.shift()] : [defaults.menuColours[0]];
  return { menu, spare };
}

/* Moves a colour within or between the menu and the spares, as dragging it
   does: `from` and `to` are { list: 'menu' | 'spare', index }, where a
   `to` index counts the colours already there. Returns the new lists, or
   null if the menu would be left empty. */
function movePaletteColour(menu, spare, from, to) {
  const lists = { menu: menu.slice(), spare: spare.slice() };
  const source = lists[from.list];
  if (!source || from.index < 0 || from.index >= source.length) return null;
  const [colour] = source.splice(from.index, 1);
  const target = lists[to.list];
  if (!target) return null;
  let index = to.index;
  if (from.list === to.list && from.index < to.index) index--;
  target.splice(Math.max(0, Math.min(index, target.length)), 0, colour);
  if (!lists.menu.length) return null;
  return lists;
}

/* A plain name for a colour, for a tooltip. */
function colourName(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(expandHex(hex));
  if (!m) return 'colour';
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.08) return max > 0.85 ? 'white' : max < 0.2 ? 'black' : 'grey';
  let h;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 345) return 'red';
  if (h < 40) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 170) return 'green';
  if (h < 200) return 'turquoise';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

function expandHex(hex) {
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex || '');
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : hex || '';
}

/* Element and node checks that hold in every window. Each window, pop-outs
   and a book's frame included, has its own Element and Node, so an element
   made in one fails `instanceof` against another's. */
function isElement(x) {
  return !!x && typeof x.closest === 'function';
}

function isNode(x) {
  return !!x && typeof x.nodeType === 'number';
}

/* The window an element is in: the main one, or a pop-out. */
function windowOf(el) {
  return (el && el.ownerDocument && el.ownerDocument.defaultView) || window;
}

/* Whether a point, in the coordinates of the range's own window, lies on the
   range: within a few pixels of one of its boxes. */
function pointInRange(range, x, y) {
  const slack = 3;
  return Array.from(range.getClientRects()).some(
    (r) => r.width > 0 && x >= r.left - slack && x <= r.right + slack && y >= r.top - slack && y <= r.bottom + slack
  );
}

/* The buttons for a selection: a highlighter for each colour in the menu,
   then Add note and Copy. One colour is just "Highlight"; with more, each
   is named, "Highlight green". */
function selectionButtons(actions, colours) {
  const out = [];
  const list = colours && colours.length ? colours : [null];
  if (actions.highlight) {
    for (const colour of list) {
      out.push({
        icon: 'highlighter',
        label: list.length > 1 && colour ? `Highlight ${colourName(colour)}` : 'Highlight',
        run: () => actions.highlight(colour),
        colour,
      });
    }
  }
  if (actions.note) out.push({ icon: 'sticky-note', label: 'Add note', run: actions.note });
  out.push({ icon: 'copy', label: 'Copy', run: actions.copy });
  return out;
}

/* The word under a point, as a range, or null where there is none. Our own
   highlight boxes are let through, so the word beneath one is found. */
function wordRangeAt(doc, x, y) {
  doc.body.classList.add('mpa-hit-through');
  let caret;
  try {
    caret = caretRangeAt(doc, x, y);
  } finally {
    doc.body.classList.remove('mpa-hit-through');
  }
  const node = caret && caret.startContainer;
  if (!node || node.nodeType !== 3) return null;
  const isWord = (ch) => !!ch && WORD_CHAR_RE.test(ch);
  let offset = caret.startOffset;
  if (!isWord(node.nodeValue[offset]) && isWord(node.nodeValue[offset - 1])) offset--;
  if (!isWord(node.nodeValue[offset])) return null;
  /* The text nodes of the block the word is in, so a word a PDF has split
     across two runs of text is found whole. */
  const block = (node.parentElement && node.parentElement.closest('.textLayer, p, li, h1, h2, h3, h4, h5, h6, div')) || doc.body;
  const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  let k = nodes.indexOf(node);
  if (k < 0) return null;
  let startNode = node;
  let start = offset;
  for (;;) {
    while (start > 0 && isWord(startNode.nodeValue[start - 1])) start--;
    const before = start === 0 && k > 0 ? nodes[k - 1] : null;
    if (!before || !isWord(before.nodeValue[before.nodeValue.length - 1])) break;
    startNode = before;
    start = before.nodeValue.length;
    k--;
  }
  k = nodes.indexOf(node);
  let endNode = node;
  let end = offset;
  for (;;) {
    while (end < endNode.nodeValue.length && isWord(endNode.nodeValue[end])) end++;
    const after = end === endNode.nodeValue.length && k < nodes.length - 1 ? nodes[k + 1] : null;
    if (!after || !isWord(after.nodeValue[0])) break;
    endNode = after;
    end = 0;
    k++;
  }
  const range = doc.createRange();
  range.setStart(startNode, start);
  range.setEnd(endNode, end);
  return range;
}

/* The text between where a drag began and where it ended, for a drag that
   left no selection. Our own highlight boxes are let through, so the text
   beneath one is found. Null for a click, or where either end is not text. */
function dragRange(doc, down, up) {
  if (!down || !up || Math.hypot(up.x - down.x, up.y - down.y) < 4) return null;
  doc.body.classList.add('mpa-hit-through');
  let a;
  let b;
  try {
    a = caretRangeAt(doc, down.x, down.y);
    b = caretRangeAt(doc, up.x, up.y);
  } finally {
    doc.body.classList.remove('mpa-hit-through');
  }
  if (!a || !b || a.startContainer.nodeType !== 3 || b.startContainer.nodeType !== 3) return null;
  /* Both ends on text, or within a few pixels of it: a drag begun out in a
     margin or between paragraphs still makes nothing. */
  const onText = (caret, point) => {
    const el = caret.startContainer.parentElement;
    const box = el && el.closest('.textLayer') ? el.getBoundingClientRect() : null;
    const slack = 4;
    return !!box && point.x >= box.left - slack && point.x <= box.right + slack && point.y >= box.top - slack && point.y <= box.bottom + slack;
  };
  if (!onText(a, down) || !onText(b, up)) return null;
  const forward = a.compareBoundaryPoints(a.START_TO_START, b) <= 0;
  const [first, last] = forward ? [a, b] : [b, a];
  const range = doc.createRange();
  range.setStart(first.startContainer, first.startOffset);
  range.setEnd(last.startContainer, last.startOffset);
  return range.collapsed ? null : range;
}

/* The last line of a selection, ignoring the zero-sized and page-sized boxes
   a PDF's text layer can report. */
function selectionEnd(range, offset) {
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5 && r.height < 200);
  const r = rects[rects.length - 1] || range.getBoundingClientRect();
  const dx = (offset && offset.left) || 0;
  const dy = (offset && offset.top) || 0;
  return { left: r.left + dx, right: r.right + dx, top: r.top + dy, bottom: r.bottom + dy };
}

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
        card.note.ownerDocument.activeElement === card.note ||
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
        ? 'Open a PDF or an EPUB to see its annotations here.'
        : !this.cards.size
          ? 'No annotations yet'
          : 'No annotations match.'
    );
  }

  /* Marks the quotes too long for five lines, which are cut there until
     clicked. Measured all at once, then marked, so the page is laid out once
     rather than once per card. A sidebar that is not on screen has nothing
     to measure; it is measured when it is shown. */
  /* A note longer than five lines is cut there, fading, while it is not
     being typed in, as a long quote is. */
  measureNote(field) {
    if (!field.isConnected || !field.clientWidth) return;
    const line = parseFloat(getComputedStyle(field).lineHeight) || 0;
    if (!line) return;
    const padding = parseFloat(getComputedStyle(field).paddingTop) + parseFloat(getComputedStyle(field).paddingBottom) || 0;
    field.toggleClass('is-long', field.scrollHeight - padding > line * QUOTE_LINES + 1);
  }

  measureQuotes(cards) {
    for (const card of cards) if (card.note) this.measureNote(card.note);
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

    /* Deleting is one click: Cmd+Z brings it back. */
    const remove = head.createDiv({
      cls: 'mpa-card-delete clickable-icon',
      attr: { 'aria-label': item.kind === 'highlight' ? 'Delete highlight' : 'Delete note' },
    });
    setIcon(remove, 'trash-2');
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      this.plugin.deleteAnnotation(card.doc, card.id);
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
    /* Right-clicking a card offers what its ··· button does. Not inside the
       note box, which keeps its own menu for pasting and spelling. */
    el.addEventListener('contextmenu', (e) => {
      if (isElement(e.target) && e.target.closest('textarea')) return;
      e.preventDefault();
      this.select(card.id);
      this.openMenu(card, e);
    });
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
    if (card.note.ownerDocument.activeElement !== card.note && card.note.value !== note) {
      card.note.value = note;
      this.fit(card.note);
    }
    card.note.readOnly = !!(this.doc && this.doc.readOnly);
    return quoteChanged;
  }

  /* A note box saves as it is typed in, with no button.
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
      this.measureNote(field);
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
    this.measureNote(field);
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
    const buttons = [
      { icon: 'trash-2', label: card.kind === 'highlight' ? 'Delete highlight' : 'Delete note', run: () => this.plugin.deleteAnnotation(card.doc, card.id) },
    ];
    this.plugin.selectionBar.show({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }, buttons, this.containerEl.ownerDocument);
  }

  /* A click anywhere but the card in hand lets it go. Told by the plugin,
     which listens in every window. */
  pressedElsewhere(e) {
    const card = this.cards.get(this.selectedId);
    if (card && !(isNode(e.target) && card.el.contains(e.target))) this.select(null);
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
/* The footnote preview: how long the pointer rests on a marker before it
   appears, how long it may be away before it goes, how wide it is, and how
   much of the page, in PDF points, it shows below the place linked to. */
const FOOTNOTE_DELAY = 250;
const FOOTNOTE_GRACE = 250;
const FOOTNOTE_WIDTH = 440;
const FOOTNOTE_DEPTH = 110;
/* No more than this many screen pixels to a PDF point, so a narrow column
   of text is not blown up to fill the preview. */
const FOOTNOTE_MAX_SCALE = 1.5;

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
   highlight did not cover. Keeping the characters' own positions, and taking
   both answers from them, avoids that; here they are measured through the
   DOM rather than through the PDF's font metrics. */

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

/* How much nearer, in pixels, another boundary must be than the browser's own
   before it is preferred. */
const REFINE_MARGIN = 1.5;

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
  const onLine = (at) => !!at && point.y >= at.top - 2 && point.y <= at.bottom + 2;
  /* Where boundary i is on the pointer's line. Between two lines it is two
     places, the end of one line and the start of the next; the one on the
     pointer's line is the one that counts. */
  const position = (i) => {
    const at = boundaryPosition(chars, i);
    if (onLine(at)) return at;
    const next = i < chars.length ? chars[i] : null;
    if (next && next.box) {
      const start = { x: next.box.left, top: next.box.top, bottom: next.box.bottom };
      if (onLine(start)) return start;
    }
    return null;
  };

  /* The browser's own answer stands unless another boundary is clearly
     nearer the pointer, by more than REFINE_MARGIN: a pointer released a
     hair past a full stop no longer takes it. */
  const own = position(index);
  let best = index;
  let bestDistance = onLine(own) ? Math.abs(own.x - point.x) - REFINE_MARGIN : Infinity;
  for (let i = lo; i <= hi; i++) {
    if (i === index) continue;
    const at = position(i);
    /* Only boundaries on the pointer's own line are candidates. */
    if (!at) continue;
    /* Never across a gap between words: a drag begun in the space before a
       word must not reach back into the word before it. */
    if (wordGapBetween(chars, index, i)) continue;
    const distance = Math.abs(at.x - point.x);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/* Whether moving a boundary from a to b would cross a gap between words:
   a space character, or the visible gap between two spans that a PDF leaves
   in place of one (the same test textOfChars uses to put a space back). */
function wordGapBetween(chars, a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  for (let i = lo; i < hi; i++) {
    const char = chars[i];
    if (char && /\s/.test(char.ch)) return true;
    if (i > lo && spanGap(chars[i - 1], char)) return true;
  }
  return false;
}

function spanGap(previous, char) {
  if (!previous || !char || previous.node === char.node || !previous.box || !char.box) return false;
  const height = Math.min(previous.box.bottom - previous.box.top, char.box.bottom - char.box.top);
  return char.box.left - previous.box.right > Math.max(1, height * 0.2);
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
   theexperience of". Characters within one span are taken as they
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

  /* A small group at either extreme that stands apart from the rest and is
     plainly not body text: every line in it far smaller than the body's, or
     lying wholly outside the body's span across the page. This is a
     publisher's stamp in a corner, which comes as two lines close together,
     so the single-line rule above lets it through. The top of a second
     column is neither small nor outside the body, so it stays. */
  const rest = sorted.slice(lo, hi + 1);
  const median = heights[heights.length >> 1];
  /* Tiny, or lying wholly out in the margin. Footnotes set in smaller type,
     often about 60% of the body's size, sit within the body's span, so a
     selection that reaches them keeps them. */
  const marginal = (line, body) => {
    if (line.height < median * 0.4) return true;
    if (line.left === null || line.width === null || !body.length) return false;
    const left = Math.min(...body.map((l) => l.left));
    const right = Math.max(...body.map((l) => l.left + l.width));
    return line.left + line.width <= left + 1 || line.left >= right - 1;
  };
  for (const fromTop of [true, false]) {
    for (let size = 2; size >= 1; size--) {
      if (rest.length - size < 3) continue;
      const group = fromTop ? rest.slice(0, size) : rest.slice(rest.length - size);
      const body = fromTop ? rest.slice(size) : rest.slice(0, rest.length - size);
      const edge = fromTop ? detached(group[group.length - 1], body[0]) : detached(body[body.length - 1], group[0]);
      if (!edge || !group.every((line) => marginal(line, body))) continue;
      for (const line of group) drop.add(line);
      rest.splice(fromTop ? 0 : rest.length - size, size);
      break;
    }
  }

  return drop.size ? lines.filter((line) => !drop.has(line)) : lines;
}

/* "paper.pdf" keeps its annotations in "paper.annotations.json"; a book
   keeps its own in "book.epub.annotations.json", so that a PDF and an EPUB
   of the same name in the same folder cannot share one. */
function sidecarPathFor(path) {
  if (/\.epub$/i.test(path)) return `${path}.annotations.json`;
  return path.replace(/\.pdf$/i, '') + '.annotations.json';
}

/* An annotations file as read, made safe to work with: entries that are not
   annotations at all are left out, every annotation has an id of its own, and
   its words are text. A file edited by hand, or by another program, cannot
   then stop the sidebar or the page from drawing. Anything else an entry
   carries is kept as it is. */
function sanitiseAnnotations(parsed) {
  const seen = new Set();
  const clean = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((x) => x && typeof x === 'object' && !Array.isArray(x))
      .map((x) => {
        const out = Object.assign({}, x);
        if (typeof out.id !== 'string' || !out.id || seen.has(out.id)) out.id = uuid();
        seen.add(out.id);
        for (const key of ['text', 'note']) {
          if (out[key] !== undefined && typeof out[key] !== 'string') out[key] = out[key] === null ? '' : String(out[key]);
        }
        if (out.rects !== undefined && !Array.isArray(out.rects)) out.rects = [];
        if (Array.isArray(out.rects)) out.rects = out.rects.filter((r) => r && typeof r === 'object');
        return out;
      });
  const data = parsed && typeof parsed === 'object' ? parsed : {};
  return { highlights: clean(data.highlights).map(migrateHighlight), notes: clean(data.notes) };
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
    const start = h.epub && Array.isArray(h.epub.start) ? h.epub.start : null;
    items.push({
      id: h.id,
      kind: 'highlight',
      obj: h,
      order: start ? [start[0], start[1], 0] : first ? [first.page, first.y, first.x] : [0, 0, 0],
      createdAt: h.createdAt || '',
    });
  }
  for (const n of (data && data.notes) || []) {
    const p = n.position || {};
    const at = n.epub && Array.isArray(n.epub.at) ? n.epub.at : null;
    items.push({
      id: n.id,
      kind: 'note',
      obj: n,
      order: at ? [at[0], at[1], 0] : [n.page || 0, p.y || 0, p.x || 0],
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

/* The PDF.js viewer behind a PDF view, without the zoom check pdfViewerOf
   makes: navigation needs the viewer even before a zoom has been set. */
/* Where an explicit destination points, in PDF units, y measured up from the
   bottom of the page. Either can be missing: "the top of the page" or "the
   left edge as it is". */
function destPoint(explicit) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const kind = explicit && explicit[1] && explicit[1].name;
  switch (kind) {
    case 'XYZ':
      return { x: num(explicit[2]), y: num(explicit[3]) };
    case 'FitH':
    case 'FitBH':
      return { x: null, y: num(explicit[2]) };
    case 'FitV':
    case 'FitBV':
      return { x: num(explicit[2]), y: null };
    case 'FitR':
      return { x: num(explicit[2]), y: num(explicit[5]) };
    default:
      return { x: null, y: null };
  }
}

/* The part of a page a footnote preview shows: the text column's width,
   from the top of the line the link points at down FOOTNOTE_DEPTH points,
   or to the last line of text before that.

   Some PDFs point at the top of the note's first line and some at its
   baseline, so the line is found from the page's text rather than trusted:
   a line whose baseline is at the point, or just under it, is that line.
   Also returns the words in the region, for a screen reader. */
function footnoteRegion(items, view, point, minWidth) {
  const [vx0, vy0, vx1, vy1] = view;
  const lines = (items || []).filter(
    (it) =>
      typeof it.str === 'string' &&
      it.str.trim() &&
      Array.isArray(it.transform) &&
      Number.isFinite(it.transform[4]) &&
      Number.isFinite(it.transform[5])
  );

  let left = vx0;
  let right = vx1;
  if (lines.length) {
    left = Math.max(vx0, Math.min(...lines.map((it) => it.transform[4])) - 4);
    right = Math.min(vx1, Math.max(...lines.map((it) => it.transform[4] + (it.width || 0))) + 4);
    if (right - left < 20) [left, right] = [vx0, vx1];
  }
  /* A narrow column is widened rather than magnified. */
  const narrowest = Math.min(minWidth || 0, vx1 - vx0);
  if (right - left < narrowest) {
    right = Math.min(vx1, left + narrowest);
    left = Math.max(vx0, right - narrowest);
  }

  const y = point && point.y !== null && point.y !== undefined ? point.y : vy1;
  const at = lines.filter((it) => it.transform[5] <= y + 2 && it.transform[5] >= y - 14);
  let top = at.length ? Math.max(...at.map((it) => it.transform[5] + (it.height || 10))) + 2 : y + 2;
  top = Math.min(Math.max(top, vy0 + 1), vy1);
  let bottom = Math.max(top - FOOTNOTE_DEPTH, vy0);
  /* No further down than the last line in reach, so a short note gets a
     short preview. Its descenders are kept. */
  const shown = lines.filter((it) => it.transform[5] <= top && it.transform[5] >= bottom);
  if (shown.length) bottom = Math.max(bottom, Math.min(...shown.map((it) => it.transform[5])) - 4);

  const text = shown
    .sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])
    .map((it) => it.str)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { left, right, top, bottom, text };
}

/* The buttons in the header of a PDF's or a book's tab: highlight mode, zoom
   in and zoom out, the same for both. In a book, zooming is the text size.
   Each new button goes to the left of those before it, so they are added
   last first, to read: highlight mode, zoom out, zoom in. */
function headerButtons(view, act) {
  const zoomIn = view.addAction('zoom-in', 'Zoom in', act.zoomIn);
  const zoomOut = view.addAction('zoom-out', 'Zoom out', act.zoomOut);
  const mode = view.addAction('highlighter', 'Toggle highlight mode', act.mode);
  mode.addClass('mpa-mode-action');
  return { mode, zoomIn, zoomOut };
}

/* A page's text and a link's target, moved into the page as it appears on
   screen at scale 1, measured up from its bottom-left corner as a PDF is. On
   an upright page this changes nothing that matters; on a page turned on its
   side, it is what lets footnoteRegion find the text column, which then runs
   across the screen as it does on any other page. */
function uprightPage(viewport, items, point, view) {
  const toScreen = (x, y) => viewport.convertToViewportPoint(x, y);
  const height = viewport.height;
  const moved = [];
  for (const it of items || []) {
    if (!Array.isArray(it.transform)) continue;
    const [sx, sy] = toScreen(it.transform[4], it.transform[5]);
    moved.push(Object.assign({}, it, { transform: [it.transform[0], it.transform[1], it.transform[2], it.transform[3], sx, height - sy] }));
  }
  /* A coordinate the link leaves open stays open on screen too: if the
     screen's height depends on it, the preview starts at the top. */
  const screen = (x, y) => {
    const [sx, sy] = toScreen(x, y);
    return { x: sx, y: height - sy };
  };
  const px = point && point.x !== null && point.x !== undefined ? point.x : null;
  const py = point && point.y !== null && point.y !== undefined ? point.y : null;
  const at = screen(px !== null ? px : view[0], py !== null ? py : view[3]);
  const heightFromX = Math.abs(screen(view[0], view[1]).y - screen(view[2], view[1]).y) > 1;
  const decidesHeight = heightFromX ? px : py;
  const decidesWidth = heightFromX ? py : px;
  const target = { x: decidesWidth !== null ? at.x : null, y: decidesHeight !== null ? at.y : null };
  return { items: moved, point: target, view: [0, 0, viewport.width, height] };
}

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

module.exports = FinallyAReaderPlugin;

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
 *
 * @typedef {Object} Card
 * @property {string} id
 * @property {'highlight' | 'note'} kind
 * @property {HTMLElement} el
 * @property {HTMLElement} [quote]
 * @property {HTMLTextAreaElement} note
 * @property {DocState | null} doc  the document the card was built for
 */
