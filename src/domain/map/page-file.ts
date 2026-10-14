// Page path to source file (spec 5.4 step 2, MAP-04). Pure over strings: exists() is injected by the app.
import type { Unmapped } from "../../contracts/finding.ts";

const NO_PAGE_FILE: Unmapped = { reason: "no-page-file" };
const PAGE_EXT = /\.html?$/i;

/**
 * "/" and "/index.html" give "index.html"; "/x" gives "x.html" when it exists, else "x/index.html";
 * "/x.html" gives "x.html"; "/x/" gives "x/index.html". A "..", "." or empty segment, an absolute path,
 * a drive letter, a backslash or a missing file gives no-page-file. Only .html and .htm are page files.
 */
export function pageFileFor(pagePath: string, exists: (rel: string) => boolean): string | Unmapped {
  if (!pagePath.startsWith("/") || pagePath.includes("\\")) return NO_PAGE_FILE;
  const rest = pagePath.slice(1);
  if (rest.startsWith("/") || /^[A-Za-z]:/.test(rest)) return NO_PAGE_FILE;
  const segments = rest.split("/");
  const dirStyle = rest === "" || rest.endsWith("/");
  const named = dirStyle ? segments.slice(0, -1) : segments;
  if (named.some((s) => s === "" || s === "." || s === "..")) return NO_PAGE_FILE;
  const base = named.join("/");

  const candidates = dirStyle
    ? [base === "" ? "index.html" : `${base}/index.html`]
    : PAGE_EXT.test(base)
      ? [base]
      : [`${base}.html`, `${base}/index.html`];
  for (const rel of candidates) if (exists(rel)) return rel;
  return NO_PAGE_FILE;
}
