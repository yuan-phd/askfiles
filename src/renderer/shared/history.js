// Page history of the main window: one entry per place the user went (Ask, a Browse page, a
// document at a section), each with what it needs to come back as it was left: the scroll
// position, the heading selected, the words found. Back (the control on the Document page, or
// Cmd+[ anywhere) returns to the entry before. Views keep their own content when hidden, so an
// entry only says where to go and what to restore; the Ask results stay as they were.

/** Most entries kept; older ones are dropped first. */
export const HISTORY_LIMIT = 50;

/** Cmd+[ on the Mac, Ctrl+[ elsewhere; not while typing in an input method. */
export function isBackKey(e) {
  return (
    (e.metaKey || e.ctrlKey) &&
    !e.altKey &&
    !e.shiftKey &&
    (e.key === '[' || e.code === 'BracketLeft') &&
    !e.isComposing
  );
}

/**
 * initial is the entry shown first. apply(entry) goes to an entry without recording it.
 * capture(entry) returns fields to store on the entry being left (its scroll position), read just
 * before the view changes.
 */
export function createHistory({ initial, apply, capture = () => ({}) }) {
  const entries = [initial];
  const listeners = [];
  const top = () => entries[entries.length - 1];
  const changed = () => listeners.forEach((l) => l());

  return {
    current: top,
    canGoBack: () => entries.length > 1,
    /**
     * Records a move: stores the leaving entry's state, runs go() which shows the new place and
     * returns its entry, and pushes it. A move to the same place only updates the entry.
     */
    navigate(go) {
      Object.assign(top(), capture(top()));
      const next = go();
      if (!next) return;
      if (samePlace(top(), next)) Object.assign(top(), next);
      else {
        entries.push(next);
        if (entries.length > HISTORY_LIMIT) entries.shift();
      }
      changed();
    },
    /** Updates the current entry with state that changed in place (a heading chosen, a search run). */
    replace(patch) {
      Object.assign(top(), patch);
    },
    /** Goes to the entry before; false when there is none. */
    back() {
      if (entries.length < 2) return false;
      entries.pop();
      changed();
      void apply(top());
      return true;
    },
    onChange(cb) {
      listeners.push(cb);
    },
  };
}

/** Two entries are the same place when view and page match and, for a document, the document. */
function samePlace(a, b) {
  if (a.view !== b.view || a.page !== b.page) return false;
  if (a.page !== 'document') return true;
  const id = (e) => e.ref?.id ?? e.ref?.url ?? e.ref?.title;
  return id(a) === id(b) && a.target?.sectionIndex === b.target?.sectionIndex;
}
