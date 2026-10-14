// Renders the persona catalog for one finding (spec 5.7, OUT-06). Pure; never calls the LLM.
import type { Finding } from "../../contracts/finding.ts";
import { PERSONAS, resolveEntry } from "./catalog.ts";
import type { CatalogEntry, Persona } from "./catalog.ts";

export type PersonaImpact = { persona: Persona; severity: 0 | 1 | 2 | 3; text: string };

const base = (path: string): string => path.split("/").pop() ?? path;

const TAG_NAMES: Record<string, string> = { a: "link", img: "image", p: "paragraph", div: "element", span: "element", html: "page", h1: "main heading" };

/** A noun phrase with its article: "the search field" for a search input, else a friendly tag name. */
function elementOf(f: Finding): string {
  const type = f.node.attrs["type"];
  if (f.node.tag === "input" && type === "search") return "the search field";
  if (f.node.tag === "input") return type && type !== "text" ? `the ${type} field` : "the text field";
  if (f.node.tag === "unknown") return "the element";
  return `the ${TAG_NAMES[f.node.tag] ?? f.node.tag}`;
}

/** The node text, or the image file name, cut to 40 characters. */
function textOf(f: Finding): string {
  const src = f.node.attrs["src"];
  const raw = f.node.tag === "img" && src ? base(src.split(/[?#]/)[0] ?? src) : f.node.text.trim();
  if (raw === "") return "no text";
  return raw.length > 40 ? `${raw.slice(0, 39)}…` : raw;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Data-specific value: contrast ratio, target size, trap repeats or covered points. */
function valueOf(f: Finding): string {
  switch (f.ruleId) {
    case "color-contrast": {
      const ratio = num(f.data["contrastRatio"]);
      return ratio === null ? "an unknown" : String(ratio);
    }
    case "target-size": {
      const w = num(f.data["width"]);
      const h = num(f.data["height"]);
      return w !== null && h !== null ? `${w} by ${h}` : "an unknown size";
    }
    case "keyboard-trap":
      return String(num(f.data["repeats"]) ?? 3);
    case "focus-obscured": {
      const covered = num(f.data["coveredPoints"]);
      return covered === null ? "covered" : `${covered} of 5 points covered`;
    }
    default:
      return "";
  }
}

const plural = (count: number, singular: string, plurals: string): string => (count === 1 ? singular : plurals);

function render(template: string, f: Finding, count: number): string {
  // "image(s)" style placeholders become singular or plural from the count.
  const text = template
    .replace(/\b(image|button|link)\(s\)/g, (_m, word: string) => plural(count, word, `${word}s`))
    .replace(/\{count\}/g, String(count))
    .replace(/\{element\}/g, elementOf(f))
    .replace(/\{text\}/g, textOf(f))
    .replace(/\{value\}/g, valueOf(f));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * One entry per persona for a finding. ruleTags are the axe tags of the finding's rule (used for the cat.*
 * fallback; keyboard checks have specific entries). count describes a group of findings (default 1).
 */
export function impactFor(finding: Finding, ruleTags: readonly string[], opts: { count?: number } = {}): PersonaImpact[] {
  const { entry } = resolveEntry(finding.ruleId, ruleTags);
  const count = opts.count ?? 1;
  return PERSONAS.map((persona) => {
    const e = entry.personas[persona];
    return { persona, severity: e.severity, text: render(e.template, finding, count) };
  });
}

/** The entry that impactFor used, for the basis link of a report card. */
export function entryFor(finding: Finding, ruleTags: readonly string[]): CatalogEntry {
  return resolveEntry(finding.ruleId, ruleTags).entry;
}

/** The most severe personas first (ties keep persona order), only those above 0. */
export function topImpacts(impacts: PersonaImpact[], n = 2): PersonaImpact[] {
  return impacts
    .map((impact, order) => ({ impact, order }))
    .filter(({ impact }) => impact.severity > 0)
    .sort((a, b) => b.impact.severity - a.impact.severity || a.order - b.order)
    .slice(0, n)
    .map(({ impact }) => impact);
}

/** Findings whose catalog entry rates the persona 3 (a blocker), per persona. tagsByRule feeds the cat.* fallback. */
export function blockedTable(findings: Finding[], tagsByRule: Record<string, readonly string[]> = {}): Record<Persona, number> {
  const table: Record<Persona, number> = { "screen-reader": 0, "keyboard-only": 0, "low-vision": 0, cognitive: 0 };
  for (const f of findings) {
    const { entry } = resolveEntry(f.ruleId, tagsByRule[f.ruleId] ?? []);
    for (const persona of PERSONAS) if (entry.personas[persona].severity === 3) table[persona] += 1;
  }
  return table;
}
