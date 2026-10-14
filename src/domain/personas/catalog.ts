// Persona impact catalog (spec 5.7, OUT-06, D-08): who a failure hurts, in templates. Deterministic data, no LLM.
// The 0 to 3 severity (none, friction, major, blocker) is the project's own rating, labelled so in the report;
// every entry cites the WCAG 2.2 "Understanding" page of its criterion, whose "Benefits" section names the people affected.
// Pure: no imports.

export type Persona = "screen-reader" | "keyboard-only" | "low-vision" | "cognitive";
export const PERSONAS: readonly Persona[] = ["screen-reader", "keyboard-only", "low-vision", "cognitive"];

/** Template placeholders: {count}, {element}, {text} and {value}, filled by impactFor. */
export type ImpactEntry = { severity: 0 | 1 | 2 | 3; template: string };
export type CatalogEntry = { rule: string; wcag: string[]; basis: string; personas: Record<Persona, ImpactEntry> };

const U = "https://www.w3.org/WAI/WCAG22/Understanding/";

function entry(rule: string, wcag: string[], page: string, sr: [ImpactEntry["severity"], string], kb: [ImpactEntry["severity"], string], lv: [ImpactEntry["severity"], string], cog: [ImpactEntry["severity"], string]): CatalogEntry {
  const at = ([severity, template]: [ImpactEntry["severity"], string]): ImpactEntry => ({ severity, template });
  return { rule, wcag, basis: `${U}${page}.html`, personas: { "screen-reader": at(sr), "keyboard-only": at(kb), "low-vision": at(lv), cognitive: at(cog) } };
}

/** One entry per rule of spec 5.5 and per keyboard check. Keys are axe rule ids or keyboard check ids. */
export const CATALOG: Record<string, CatalogEntry> = {
  "image-alt": entry(
    "image-alt",
    ["1.1.1"],
    "non-text-content",
    [3, "A screen reader announces {count} image(s) only as 'image' or by file name ({text}); the product cannot be told apart"],
    [0, "Keyboard use is not affected by a missing text alternative"],
    [1, "Text-only and high-zoom views drop {count} image(s) ({text}) and leave nothing in their place"],
    [1, "Without a text alternative the purpose of {count} image(s) ({text}) has to be guessed from layout alone"],
  ),
  label: entry(
    "label",
    ["1.3.1", "3.3.2", "4.1.2"],
    "labels-or-instructions",
    [3, "A screen reader announces {element} with no name, so the person cannot tell what to type into it"],
    [1, "Voice control and switch users cannot target {element} by name"],
    [1, "A magnified view may scroll the visible hint away from {element}, leaving no name at all"],
    [2, "Without a programmatic label the purpose of {element} has to be guessed"],
  ),
  "button-name": entry(
    "button-name",
    ["4.1.2"],
    "name-role-value",
    [3, "A screen reader announces {count} button(s) as just 'button'; the action ({element}) is unknown"],
    [2, "Voice control users cannot say the name of {element}"],
    [0, "Sighted low-vision users see the icon and are not affected"],
    [1, "An icon-only button with no name offers no text to confirm what it does"],
  ),
  "link-name": entry(
    "link-name",
    ["2.4.4", "4.1.2"],
    "name-role-value",
    [3, "A screen reader announces {count} link(s) as just 'link' or reads the URL; the destination ({element}) is unknown"],
    [2, "Voice control users cannot say the name of {element}"],
    [1, "An icon-only link is easy to miss at high zoom"],
    [1, "A link with no text gives no hint where it leads"],
  ),
  "html-has-lang": entry(
    "html-has-lang",
    ["3.1.1"],
    "language-of-page",
    [2, "A screen reader falls back to the system voice, so the text may be pronounced with the wrong accent"],
    [0, "Keyboard use is not affected by a missing page language"],
    [1, "Translation and reading tools cannot tell which language to use"],
    [1, "Text-to-speech and translation tools used for reading support guess the language"],
  ),
  "document-title": entry(
    "document-title",
    ["2.4.2"],
    "page-titled",
    [2, "A screen reader announces the page with no title; the tab and the history show a bare address"],
    [1, "Switching between windows and tabs by keyboard shows no title to choose by"],
    [1, "A zoomed view that hides the page header leaves the title as the only place to see where you are"],
    [2, "Without a page title it is hard to confirm which page is open or to find it again"],
  ),
  "color-contrast": entry(
    "color-contrast",
    ["1.4.3"],
    "contrast-minimum",
    [0, "A screen reader reads the text regardless of its colour"],
    [0, "Keyboard use is not affected by text colour"],
    [2, "The text ({text}) has a contrast ratio of {value}:1, below the required minimum, so it fades out for low-vision readers"],
    [1, "Faint text ({text}) is harder to read for people with dyslexia or attention difficulties"],
  ),
  "target-size": entry(
    "target-size",
    ["2.5.8"],
    "target-size-minimum",
    [0, "A screen reader is not affected by the size of a target"],
    [1, "Switch and assistive pointer users have to aim at {element} ({value} px)"],
    [2, "At {value} px {element} is hard to hit for people who magnify the page or have a tremor"],
    [1, "Tiny neighbouring targets make accidental activation more likely"],
  ),
  "label-content-name-mismatch": entry(
    "label-content-name-mismatch",
    ["2.5.3"],
    "label-in-name",
    [2, "The accessible name of {element} does not contain its visible text ({text}), so what is seen and what is announced differ"],
    [2, "Voice control users say the visible text ({text}) and nothing happens"],
    [0, "Sighted low-vision users see the visible text and are not affected"],
    [1, "The announced name does not match the visible text ({text}), which is confusing"],
  ),
  "duplicate-id-aria": entry(
    "duplicate-id-aria",
    ["4.1.2"],
    "name-role-value",
    [2, "A duplicate id can attach the wrong name or description to {element}"],
    [0, "Keyboard use is not affected unless the duplicate breaks a label"],
    [0, "Sighted low-vision users are not affected"],
    [1, "A wrong label or description is misleading"],
  ),
  "keyboard-trap": entry(
    "keyboard-trap",
    ["2.1.2"],
    "no-keyboard-trap",
    [3, "Once focus enters {element} a screen reader user cannot leave it with the keyboard"],
    [3, "Tab stays on {element} (heuristic: focus did not move for {value} Tabs); the rest of the page cannot be reached"],
    [2, "A magnifier user who navigates by keyboard is stuck in {element}"],
    [1, "Being stuck without a visible exit is confusing"],
  ),
  "unreachable-control": entry(
    "unreachable-control",
    ["2.1.1"],
    "keyboard",
    [2, "A screen reader may not announce {element} ({text}) as a control, so it is easy to miss"],
    [3, "{element} ({text}) reacts to clicks but cannot be reached with Tab; a keyboard user cannot use it"],
    [1, "A keyboard-driven magnifier cannot move to {element} ({text})"],
    [1, "A control that cannot be reached by keyboard breaks the expected way of working"],
  ),
  "focus-obscured": entry(
    "focus-obscured",
    ["2.4.11"],
    "focus-not-obscured-minimum",
    [0, "A screen reader announces the focused {element} even when it is hidden on screen"],
    [2, "The focused {element} is hidden behind other content ({value}), so the keyboard user cannot see where they are"],
    [2, "A magnified view makes it likelier that a sticky header covers the focused {element}"],
    [1, "Losing sight of the focus makes the task hard to follow"],
  ),
};

/** Fallback by axe `cat.*` tag, used by every rule without an entry of its own. */
export const CATEGORY_FALLBACKS: Record<string, CatalogEntry> = {
  "cat.aria": entry("cat.aria", ["4.1.2"], "name-role-value", [2, "Invalid ARIA on {element} can make a screen reader announce the wrong role, state or name"], [1, "Keyboard behaviour may not match the announced role"], [0, "Sighted low-vision users are rarely affected"], [1, "An element that behaves differently from its announcement is confusing"]),
  "cat.color": entry("cat.color", ["1.4.3"], "contrast-minimum", [0, "A screen reader is not affected by colour"], [0, "Keyboard use is not affected by colour"], [2, "Colour choices on {element} reduce legibility for low-vision readers"], [1, "Poor colour contrast tires readers with attention or reading difficulties"]),
  "cat.forms": entry("cat.forms", ["3.3.2"], "labels-or-instructions", [2, "A form control ({element}) is announced without the information needed to fill it in"], [1, "Form controls without a clear name are harder to find and use by voice"], [1, "Instructions that depend on layout can scroll out of view at high zoom"], [2, "Unclear form controls make forms harder to complete"]),
  "cat.keyboard": entry("cat.keyboard", ["2.1.1"], "keyboard", [2, "{element} may not be operable from a screen reader's keyboard commands"], [3, "{element} may not be operable by keyboard"], [1, "A keyboard-driven magnifier cannot use {element}"], [1, "A control that does not follow keyboard conventions is confusing"]),
  "cat.language": entry("cat.language", ["3.1.1"], "language-of-page", [2, "Wrong or missing language information makes a screen reader use the wrong voice"], [0, "Keyboard use is not affected by language markup"], [1, "Translation tools depend on correct language markup"], [1, "Reading-support tools depend on correct language markup"]),
  "cat.name-role-value": entry("cat.name-role-value", ["4.1.2"], "name-role-value", [3, "{element} is announced without a usable name, role or value"], [2, "Voice control users cannot target {element} by name"], [0, "Sighted low-vision users see the visible label and are not affected"], [1, "Controls without a name give no clue to their purpose"]),
  "cat.parsing": entry("cat.parsing", ["4.1.2"], "name-role-value", [1, "Broken markup around {element} can confuse assistive technology"], [0, "Keyboard use is rarely affected by markup errors"], [0, "Sighted low-vision users are rarely affected"], [0, "Cognitive users are rarely affected"]),
  "cat.semantics": entry("cat.semantics", ["1.3.1"], "info-and-relationships", [2, "{element} lacks the structure a screen reader needs to announce it correctly"], [1, "Missing semantics can remove keyboard shortcuts such as jumping between headings"], [0, "Sighted low-vision users see the visual structure"], [1, "Missing structure makes the page harder to scan"]),
  "cat.sensory-and-visual-cues": entry("cat.sensory-and-visual-cues", ["1.4.1"], "use-of-color", [1, "Information carried only by colour or shape on {element} is lost"], [0, "Keyboard use is not affected"], [2, "Information carried only by colour or shape on {element} is hard to perceive"], [1, "Cues that rely on one sense only are easy to miss"]),
  "cat.structure": entry("cat.structure", ["1.3.1"], "info-and-relationships", [2, "Headings, landmarks or lists around {element} are missing or in the wrong order, so a screen reader user cannot jump around"], [1, "Missing structure removes the shortcuts keyboard users rely on"], [0, "Sighted low-vision users see the visual structure"], [2, "Missing structure makes the page harder to scan and understand"]),
  "cat.tables": entry("cat.tables", ["1.3.1"], "info-and-relationships", [2, "A screen reader cannot announce which header belongs to a cell of {element}"], [0, "Keyboard use is not affected"], [0, "Sighted low-vision users see the layout"], [1, "Data without clear headers is harder to follow"]),
  "cat.text-alternatives": entry("cat.text-alternatives", ["1.1.1"], "non-text-content", [3, "{element} has no text alternative, so a screen reader announces nothing useful"], [0, "Keyboard use is not affected"], [1, "Text-only views drop {element}"], [1, "The purpose of {element} has to be guessed"]),
  "cat.time-and-media": entry("cat.time-and-media", ["1.2.1"], "audio-only-and-video-only-prerecorded", [2, "Audio or video on {element} has no text alternative"], [1, "Media controls that do not follow keyboard conventions are hard to use"], [1, "Captions and transcripts are the only alternative to audio"], [1, "Moving or timed content is hard to follow"]),
};

/** Last resort for a rule with neither an entry nor a known category. Not used by any selected axe rule (OUT-06 test). */
export const GENERIC_ENTRY: CatalogEntry = entry("generic", [], "intro", [1, "{element} fails an accessibility check and may be harder to use with a screen reader"], [1, "{element} fails an accessibility check and may be harder to use by keyboard"], [1, "{element} fails an accessibility check and may be harder to read when magnified"], [1, "{element} fails an accessibility check and may be harder to understand"]);

export type ResolvedEntry = { source: "specific" | "category" | "generic"; entry: CatalogEntry };

/** The specific entry of a rule, else the entry of its first known cat.* tag, else the generic one. */
export function resolveEntry(ruleId: string, ruleTags: readonly string[]): ResolvedEntry {
  const specific = Object.hasOwn(CATALOG, ruleId) ? CATALOG[ruleId] : undefined;
  if (specific) return { source: "specific", entry: specific };
  for (const tag of ruleTags) {
    const category = Object.hasOwn(CATEGORY_FALLBACKS, tag) ? CATEGORY_FALLBACKS[tag] : undefined;
    if (category) return { source: "category", entry: category };
  }
  return { source: "generic", entry: GENERIC_ENTRY };
}
