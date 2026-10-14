// Functions evaluated inside the audited page with page.evaluate (spec 5.3).
// Each one must be self-contained: Playwright serializes the function source, so a function here may not
// reference anything outside its own body (no imports, no module-level helpers).
import type { NodeDescriptor } from "../contracts/finding.ts";

/**
 * Describes the element matched by a CSS selector (spec 5.1): lower-case tag, attributes, collapsed text
 * (200 chars), index and count among document.querySelectorAll(tag), collapsed outerHTML (400 chars), rect
 * and data-a11y-source. Returns null when nothing matches.
 */
export function describeNode(selector: string): NodeDescriptor | null {
  const el = document.querySelector(selector);
  if (el === null) return null;
  const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
  const tag = el.tagName.toLowerCase();
  const all = Array.from(document.querySelectorAll(CSS.escape(tag)));
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
  const r = el.getBoundingClientRect();
  return {
    selector,
    tag,
    attrs,
    text: collapse(el.textContent ?? "").slice(0, 200),
    domTagIndex: all.indexOf(el),
    domTagCount: all.length,
    htmlSnippet: collapse(el.outerHTML).slice(0, 400),
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    dataSource: el.getAttribute("data-a11y-source"),
  };
}

/** The id of every element with an id attribute, in document order, duplicates kept (cap 10,000). */
export function collectIds(): string[] {
  return Array.from(document.querySelectorAll("[id]"), (el) => el.id).slice(0, 10_000);
}

/** One step of the keyboard walk, without its index; null when nothing (or the body) has focus. */
export type StepCapture = {
  selector: string;
  tag: string;
  id: string | null;
  coveredPoints: number;
  coveredBy: string | null;
  tabindex: number | null;
  hostKind: "plain" | "shadow-host" | "iframe" | "native-composite";
};

/**
 * Captures the active element after a Tab (spec 5.3, KBD-01, KBD-04): a generated selector, the host kind,
 * and elementFromPoint at the centre and the 4 corners inset by 2 px. A point counts as covered when the
 * element there is neither the active element, a descendant nor an ancestor. Never calls focus() or blur().
 */
export function traversalStep(): StepCapture | null {
  const el = document.activeElement;
  if (el === null || el === document.body || el === document.documentElement) return null;
  const cssPath = (node: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = node;
    while (cur !== null && cur !== document.documentElement) {
      if (cur.id !== "" && document.querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const tagName: string = cur.tagName;
      let part = tagName.toLowerCase();
      for (const c of Array.from(cur.classList)) part += `.${CSS.escape(c)}`;
      const parent: Element | null = cur.parentElement;
      if (parent !== null) {
        const same = Array.from(parent.children).filter((c) => c.tagName === tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(" > ");
  };
  const tag = el.tagName.toLowerCase();
  const composite = (tag === "input" && ["date", "time", "datetime-local", "month", "week", "color", "file"].includes((el as HTMLInputElement).type)) || ((tag === "video" || tag === "audio") && el.hasAttribute("controls"));
  const hostKind = el.shadowRoot !== null ? "shadow-host" : tag === "iframe" || tag === "frame" ? "iframe" : composite ? "native-composite" : "plain";
  const r = el.getBoundingClientRect();
  const points: Array<[number, number]> = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + 2, r.top + 2],
    [r.right - 2, r.top + 2],
    [r.left + 2, r.bottom - 2],
    [r.right - 2, r.bottom - 2],
  ];
  let coveredPoints = 0;
  let coveredBy: string | null = null;
  for (const [x, y] of points) {
    const hit = document.elementFromPoint(x, y);
    if (hit !== null && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      coveredPoints++;
      coveredBy ??= cssPath(hit);
    }
  }
  const tabAttr = el.getAttribute("tabindex");
  const parsed = tabAttr === null ? Number.NaN : Number.parseInt(tabAttr, 10);
  return { selector: cssPath(el), tag, id: el.id === "" ? null : el.id, coveredPoints, coveredBy, tabindex: Number.isNaN(parsed) ? null : parsed, hostKind };
}

/**
 * Elements that look interactive (onclick, role=button, role=link; cap 500), whether each is focusable and
 * whether it contains a focusable descendant (spec 5.3). "reached" is decided by the runner against the walk.
 */
export function interactiveCandidates(): Array<{ selector: string; tag: string; reason: "onclick" | "role-button" | "role-link"; focusable: boolean; hasFocusableDescendant: boolean }> {
  const FOCUSABLE = "a[href], area[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), iframe, summary, audio[controls], video[controls], [contenteditable=''], [contenteditable='true'], [tabindex]";
  const isFocusable = (node: Element): boolean => node.matches(FOCUSABLE) && (node as HTMLElement).tabIndex >= 0;
  const cssPath = (node: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = node;
    while (cur !== null && cur !== document.documentElement) {
      if (cur.id !== "" && document.querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const tagName: string = cur.tagName;
      let part = tagName.toLowerCase();
      for (const c of Array.from(cur.classList)) part += `.${CSS.escape(c)}`;
      const parent: Element | null = cur.parentElement;
      if (parent !== null) {
        const same = Array.from(parent.children).filter((c) => c.tagName === tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(" > ");
  };
  return Array.from(document.querySelectorAll("[onclick], [role=button], [role=link]"))
    .slice(0, 500)
    .map((el) => ({
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      reason: el.hasAttribute("onclick") ? ("onclick" as const) : el.getAttribute("role") === "button" ? ("role-button" as const) : ("role-link" as const),
      focusable: isFocusable(el),
      hasFocusableDescendant: Array.from(el.querySelectorAll("*")).some(isFocusable),
    }));
}
