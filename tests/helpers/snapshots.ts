// Builders for snapshots and raw axe results used by unit tests. Later chunks extend this file.
import type { NodeDescriptor } from "../../src/contracts/finding.ts";
import type { AuditSnapshot, AxeRawResult } from "../../src/contracts/snapshot.ts";

export function axeResult(overrides: Partial<AxeRawResult> & { id: string }): AxeRawResult {
  return {
    impact: "serious",
    tags: ["wcag2a"],
    help: `help for ${overrides.id}`,
    helpUrl: `https://dequeuniversity.com/rules/axe/4.14/${overrides.id}`,
    nodes: [{ target: ["img"], html: "<img>", failureSummary: "Fix any of the following", any: [], all: [], none: [] }],
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<AuditSnapshot> = {}): AuditSnapshot {
  return {
    schemaVersion: 1,
    axeVersion: "4.14.0",
    treeSha256: "0".repeat(64),
    url: "http://127.0.0.1:1/",
    pagePath: "/",
    title: "Test page",
    lang: "en",
    axe: { violations: [], incomplete: [], passesCount: 0, inapplicableCount: 0, toolOptions: {} },
    nodes: {},
    domIds: [],
    traversal: { steps: [], stoppedBecause: "body", interactiveCandidates: [] },
    ariaSnapshot: "",
    ariaByNode: {},
    screenshots: { fullPage: "" },
    timings: { loadMs: 0, axeMs: 0, keyboardMs: 0 },
    ...overrides,
  };
}

/** A node descriptor as describeNode would return it; selector defaults to the tag and the DOM key fields to 0 of 1. */
export function makeNode(overrides: Partial<NodeDescriptor> & { tag: string }): NodeDescriptor {
  return {
    selector: overrides.tag,
    attrs: {},
    text: "",
    domTagIndex: 0,
    domTagCount: 1,
    htmlSnippet: `<${overrides.tag}>`,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    dataSource: null,
    ...overrides,
  };
}

/** One rule with its nodes, as a scripted snapshot needs it: the raw axe result plus the descriptors for snapshot.nodes. */
export type ScriptedRule = { result: AxeRawResult; nodes: Record<string, NodeDescriptor> };

/**
 * An axe result whose node targets are [node.selector], with the matching descriptors (plan Task 19's
 * axeResult(ruleId, nodes, impact), renamed because axeResult(overrides) already exists).
 */
export function axeRule(ruleId: string, nodes: Array<{ node: NodeDescriptor; data?: unknown; html?: string }>, impact: string = "serious", tags: string[] = ["wcag2a"]): ScriptedRule {
  const descriptors: Record<string, NodeDescriptor> = {};
  const result = axeResult({
    id: ruleId,
    impact,
    tags,
    nodes: nodes.map(({ node, data, html }) => {
      descriptors[JSON.stringify([node.selector])] = node;
      return { target: [node.selector], html: html ?? node.htmlSnippet, failureSummary: `Fix ${ruleId}`, any: data === undefined ? [] : [{ id: ruleId, data }], all: [], none: [] };
    }),
  });
  return { result, nodes: descriptors };
}

/** A snapshot built from scripted rules: violations and incomplete fill axe and snapshot.nodes. */
export function scriptedSnapshot(spec: { violations?: ScriptedRule[]; incomplete?: ScriptedRule[] } & Partial<AuditSnapshot> = {}): AuditSnapshot {
  const { violations = [], incomplete = [], ...rest } = spec;
  const nodes: Record<string, NodeDescriptor> = {};
  for (const r of [...violations, ...incomplete]) Object.assign(nodes, r.nodes);
  return makeSnapshot({
    ...rest,
    axe: { violations: violations.map((r) => r.result), incomplete: incomplete.map((r) => r.result), passesCount: 0, inapplicableCount: 0, toolOptions: {} },
    nodes: { ...nodes, ...(rest.nodes ?? {}) },
  });
}
