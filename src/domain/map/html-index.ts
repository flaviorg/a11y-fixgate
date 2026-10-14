// Parsed index of the page's source files (spec 5.4, MAP-05). Pure: parse5 only, no node:* imports.
import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import type { SourceLocation } from "../../contracts/finding.ts";

type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

export type IndexedElement = {
  tag: string;
  attrs: Record<string, string>;
  location: Omit<SourceLocation, "method">;
  /** Index of the nearest indexed ancestor in IndexedFile.elements, or null. */
  parent: number | null;
  /** Collapsed textContent from the parse tree (template content excluded, as in the DOM). */
  text: string;
};

export type IndexedFile = {
  /** The original text, byte for byte (a BOM, if any, kept). */
  text: string;
  /** Explicit elements in document order. */
  elements: IndexedElement[];
  /** Element indexes per lower-case tag, in document order (the order of document.querySelectorAll). */
  byTag: Record<string, number[]>;
  /** Every id attribute value in the file, in document order, duplicates kept. */
  ids: string[];
};

export type HtmlIndex = { files: Record<string, IndexedFile> };

const BOM = "﻿";
const SIGNATURE_MAX = 200;

/** The same collapse as the page scripts (src/browser/page-scripts.ts): any whitespace run to one space, trimmed. */
export function collapseText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Tag plus the sorted name="value" pairs, without data-a11y-source, values trimmed, class whitespace collapsed (spec 5.4). */
export function signatureOf(tag: string, attrs: Record<string, string>): string {
  const pairs = Object.keys(attrs)
    .filter((name) => name !== "data-a11y-source")
    .sort()
    .map((name) => {
      const raw = attrs[name]!.trim();
      const value = name === "class" ? collapseText(raw) : raw;
      return `${name}="${value.replaceAll('"', "&quot;")}"`;
    });
  return [tag, ...pairs].join(" ");
}

/** signatureOf truncated to 200 chars: the start-tag-only anchor of unmapped findings (spec 5.6). */
export function startTagSignature(tag: string, attrs: Record<string, string>): string {
  return signatureOf(tag, attrs).slice(0, SIGNATURE_MAX);
}

function isElement(node: ChildNode): node is Element {
  return "tagName" in node;
}

function hasChildren(node: ChildNode): node is ChildNode & ParentNode {
  return "childNodes" in node;
}

/**
 * Builds the index of every file. A leading BOM is removed before parsing (parse5 would treat it as text
 * and make html, head and body implicit, unlike a browser) and every offset and line-1 column is shifted
 * back, so offsets always refer to the original text. Offsets are UTF-16 code units.
 */
export function buildHtmlIndex(files: Record<string, string>): HtmlIndex {
  const out: Record<string, IndexedFile> = {};
  for (const name of Object.keys(files).sort()) out[name] = indexFile(name, files[name]!);
  return { files: out };
}

function indexFile(file: string, text: string): IndexedFile {
  const shift = text.startsWith(BOM) ? 1 : 0;
  const doc = parse(shift ? text.slice(1) : text, { sourceCodeLocationInfo: true });
  const elements: IndexedElement[] = [];
  const byTag: Record<string, number[]> = {};
  const ids: string[] = [];
  const off = (n: number) => n + shift;
  const col = (line: number, c: number) => (line === 1 ? c + shift : c);

  /** Returns the raw (uncollapsed) text content of the node. */
  const visit = (node: ChildNode, parent: number | null): string => {
    if (node.nodeName === "#text" && "value" in node) return node.value;
    if (!hasChildren(node)) return "";
    let self = parent;
    let entry: IndexedElement | null = null;
    if (isElement(node)) {
      const loc = node.sourceCodeLocation;
      if (loc && loc.startTag) {
        const tag = node.tagName.toLowerCase();
        const attrs: Record<string, string> = {};
        for (const a of node.attrs) if (!(a.name in attrs)) attrs[a.name] = a.value;
        const attrOffsets: Record<string, { startOffset: number; endOffset: number }> = {};
        for (const [name, l] of Object.entries(loc.attrs ?? {})) attrOffsets[name] = { startOffset: off(l.startOffset), endOffset: off(l.endOffset) };
        const end = loc.endTag ?? loc;
        const ordinals = (byTag[tag] ??= []);
        entry = {
          tag,
          attrs,
          location: {
            file,
            startOffset: off(loc.startOffset),
            endOffset: off(loc.endOffset),
            startTag: { startOffset: off(loc.startTag.startOffset), endOffset: off(loc.startTag.endOffset) },
            attrs: attrOffsets,
            startLine: loc.startLine,
            startCol: col(loc.startLine, loc.startCol),
            endLine: end.endLine,
            endCol: col(end.endLine, end.endCol),
            tagOrdinal: ordinals.length,
          },
          parent,
          text: "",
        };
        ordinals.push(elements.length);
        self = elements.length;
        elements.push(entry);
        if (attrs["id"] !== undefined) ids.push(attrs["id"]);
      }
    }
    // Template content lives in node.content, outside childNodes, exactly as the DOM keeps it out of textContent.
    let raw = "";
    for (const child of node.childNodes) raw += visit(child, self);
    if (entry) entry.text = collapseText(raw);
    return raw;
  };

  for (const child of doc.childNodes) visit(child, null);
  return { text, elements, byTag, ids };
}
