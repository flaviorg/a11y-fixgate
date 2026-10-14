// Fingerprints (spec 5.6, VER-01): the only identity of a finding across audits. Pure.
import { isUnmapped } from "../../contracts/finding.ts";
import type { Fingerprint, NodeDescriptor, SourceLocation, Unmapped } from "../../contracts/finding.ts";
import { fnv1a64 } from "../hash.ts";
import { startTagSignature } from "../map/html-index.ts";

/**
 * "src:<file>#<tag>[<tagOrdinal>]" when mapped, else "dom:" plus the start-tag signature (start tag only, so
 * descendants never change it). Selectors are never part of it: they drift when a fix adds an attribute.
 */
export function anchorOf(location: SourceLocation | Unmapped, node: NodeDescriptor): string {
  if (isUnmapped(location)) return `dom:${startTagSignature(node.tag, node.attrs)}`;
  return `src:${location.file}#${node.tag}[${location.tagOrdinal}]`;
}

/** fnv1a64("v1|" + ruleId + "|" + anchor). The status is never hashed; it only picks the FindingSet bucket. */
export function fingerprintOf(ruleId: string, anchor: string): Fingerprint {
  return fnv1a64(`v1|${ruleId}|${anchor}`) as Fingerprint;
}

/** DOM node key "<tag>[<domTagIndex>]" (spec 5.1): stable under v1 fixers, used for watched aria snapshots. */
export function domKey(node: NodeDescriptor): string {
  return `${node.tag}[${node.domTagIndex}]`;
}
