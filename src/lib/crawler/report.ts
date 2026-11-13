import fs from "node:fs";
import path from "node:path";
import type { AssetRecord } from "./assets";
import type { ApiRecord } from "./api-discovery";
import type { CrawlOptions, CrawlStats, FailureRecord } from "./types";
import type { VisualRow } from "./visual";

export interface PageRow {
  url: string;
  finalUrl: string;
  localPath: string;
  status: string;
  httpStatus?: number;
  depth: number;
  title: string;
  bytes: number;
  renderedWith: string;
  aliasOf?: string;
}

export interface DiscoveredRow {
  url: string;
  status: string;
  reason?: string;
  depth: number;
  referrer?: string;
}

export interface ReportData {
  startUrl: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: string;
  stopReason?: string;
  options: CrawlOptions;
  requestedRenderMode: string;
  effectiveRenderMode: string;
  stats: CrawlStats;
  pages: PageRow[];
  discovered: DiscoveredRow[];
  failures: FailureRecord[];
  skipped: Array<{ url: string; reason: string }>;
  externalLinks: string[];
  assets: AssetRecord[];
  unsupported: {
    forms: Array<{ page: string; action: string; method: string }>;
    apiCalls: string[];
    externalEmbeds: string[];
    renderFailures: string[];
    notes: string[];
  };
  contentBytes: number;
  /** Controlled fetch/XHR discovery results. */
  api?: { mode: string; graphqlEndpoints: string[]; followPagination: boolean; records: ApiRecord[] };
  /** Present for authenticated crawls. Contains no credential material. */
  authentication?: { profileId: string; profileName: string; status: string };
  visual?: VisualRow[];
  visualNote?: string;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function buildSummary(d: ReportData) {
  const missingAssets = d.assets.filter((a) => a.status === "failed" || (a.status === "skipped" && a.error && !/disabled/.test(a.error)));
  return {
    startUrl: d.startUrl,
    status: d.status,
    stopReason: d.stopReason ?? null,
    startedAt: d.startedAt,
    finishedAt: d.finishedAt,
    durationMs: d.durationMs,
    renderMode: { requested: d.requestedRenderMode, effective: d.effectiveRenderMode },
    totals: {
      pagesDiscovered: d.discovered.length,
      pagesDownloaded: d.pages.filter((p) => p.status === "ok").length,
      pagesAliased: d.pages.filter((p) => p.status !== "ok").length,
      pagesFailed: d.failures.filter((f) => f.kind === "page").length,
      pagesSkipped: d.skipped.length,
      assetsDiscovered: d.assets.length,
      assetsDownloaded: d.assets.filter((a) => a.status === "ok").length,
      assetsDuplicate: d.assets.filter((a) => a.status === "duplicate").length,
      assetsMissing: missingAssets.length,
      externalLinks: d.externalLinks.length,
      contentBytes: d.contentBytes,
    },
    unsupportedDynamicFunctionality: d.unsupported,
    authentication: d.authentication ?? null,
    apiDiscovery: {
      mode: d.api?.mode ?? "off",
      endpoints: d.api?.records.length ?? 0,
      archivedResponses: d.api?.records.filter((r) => r.archived).length ?? 0,
      blockedStateChangingRequests: d.api?.records.filter((r) => r.blocked).length ?? 0,
      paginationFollowUps: d.api?.records.filter((r) => r.type === "pagination").length ?? 0,
      graphqlEndpointsAuthorised: d.api?.graphqlEndpoints ?? [],
    },
    missingAssets: missingAssets.map((a) => ({ url: a.url, error: a.error, referrer: a.referrers[0] })),
    visualComparison: d.visual ? { rows: d.visual.length, note: d.visualNote } : { note: d.visualNote ?? "not requested" },
  };
}

export async function writeReports(dir: string, d: ReportData): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  const summary = buildSummary(d);
  const json = { ...summary, options: d.options, stats: d.stats, pages: d.pages, failures: d.failures, skipped: d.skipped, externalLinks: d.externalLinks, visual: d.visual };
  const w = (name: string, content: string) => fs.promises.writeFile(path.join(dir, name), content);
  await w("crawl-report.json", JSON.stringify(json, null, 2));
  await w(
    "failed-urls.txt",
    d.failures.map((f) => `${f.url}\t${f.kind}\t${f.status ?? "-"}\t${f.error.replace(/\s+/g, " ")}\treferrer=${f.referrer ?? "-"}`).join("\n") + (d.failures.length ? "\n" : ""),
  );
  await w("discovered-urls.txt", d.discovered.map((x) => `${x.status}\t${x.url}`).join("\n") + "\n");
  await w(
    "assets-manifest.json",
    JSON.stringify(
      d.assets.map((a) => ({
        url: a.url,
        localPath: a.localPath || null,
        status: a.status,
        size: a.size,
        contentType: a.contentType,
        sha256: a.sha256 ?? null,
        duplicateOf: a.duplicateOf ?? null,
        error: a.error ?? null,
        external: a.external,
        fetchedWith: a.fetchedWith ?? null,
        referrers: a.referrers,
      })),
      null,
      2,
    ),
  );
  await w(
    "api-discovery.json",
    JSON.stringify(
      {
        mode: d.api?.mode ?? "off",
        note: "Only requests issued by the crawled pages themselves are listed. Request headers, cookies and tokens are never recorded; state-changing requests are blocked, not replayed; stored JSON bodies are redacted.",
        graphqlEndpointsAuthorised: d.api?.graphqlEndpoints ?? [],
        followPagination: d.api?.followPagination ?? false,
        endpoints: d.api?.records ?? [],
      },
      null,
      2,
    ),
  );
  await w("crawl-report.html", renderHtml(d, summary));
}

function renderHtml(d: ReportData, s: ReturnType<typeof buildSummary>): string {
  const t = s.totals;
  const rows = (items: string[][], head: string[]) =>
    `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${items
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
      .join("")}</tbody></table>`;
  const visual = d.visual?.length
    ? rows(
        d.visual.map((v) => [
          esc(v.page),
          esc(v.viewport),
          v.error ? esc(v.error) : `${v.sourceSize.w}×${v.sourceSize.h} vs ${v.localSize.w}×${v.localSize.h}`,
          v.mismatchPercent === null ? "n/a" : v.mismatchPercent.toFixed(2) + "%",
          esc(v.verdict),
          String(v.missingResources.length),
        ]),
        ["Page", "Viewport", "Size (source vs offline)", "Pixel mismatch", "Verdict", "Resources still needing network"],
      )
    : `<p>${esc(d.visualNote ?? "Visual comparison was not requested.")}</p>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Crawl report — ${esc(d.startUrl)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:1100px;padding:0 1rem;color:#0f172a}h1{margin-bottom:0}h2{margin-top:2rem;border-bottom:1px solid #e2e8f0;padding-bottom:.25rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.75rem}.card{background:#f1f5f9;border-radius:.5rem;padding:.75rem}.card b{display:block;font-size:1.5rem}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #e2e8f0;padding:.3rem .5rem;text-align:left;word-break:break-all}th{background:#f8fafc}.warn{background:#fef9c3;padding:.5rem .75rem;border-radius:.5rem}</style></head><body>
<h1>Crawl report</h1><p>${esc(d.startUrl)} — <b>${esc(d.status)}</b>${d.stopReason ? ` (${esc(d.stopReason)})` : ""}<br>${esc(d.startedAt)} → ${esc(d.finishedAt)} (${(d.durationMs / 1000).toFixed(1)} s) · render mode: ${esc(s.renderMode.effective)}${s.renderMode.requested !== s.renderMode.effective ? ` (requested ${esc(s.renderMode.requested)})` : ""}</p>
<div class="grid">
<div class="card"><b>${t.pagesDiscovered}</b>pages discovered</div><div class="card"><b>${t.pagesDownloaded}</b>pages downloaded</div>
<div class="card"><b>${t.pagesFailed}</b>pages failed</div><div class="card"><b>${t.pagesSkipped}</b>URLs skipped</div>
<div class="card"><b>${t.assetsDownloaded}</b>assets downloaded</div><div class="card"><b>${t.assetsDuplicate}</b>duplicate assets</div>
<div class="card"><b>${t.assetsMissing}</b>missing assets</div><div class="card"><b>${t.externalLinks}</b>external links</div>
<div class="card"><b>${fmtBytes(t.contentBytes)}</b>content size</div></div>
<h2>Pages</h2>${rows(
    d.pages.map((p) => [esc(p.url), esc(p.status + (p.aliasOf ? " → " + p.aliasOf : "")), esc(p.localPath), String(p.depth), esc(p.renderedWith), fmtBytes(p.bytes)]),
    ["URL", "Status", "Local file", "Depth", "Rendered with", "Size"],
  )}
<h2>Failed URLs (${d.failures.length})</h2>${rows(
    d.failures.map((f) => [esc(f.url), esc(f.kind), esc(f.status ?? "-"), esc(f.error), esc(f.referrer ?? "-")]),
    ["URL", "Type", "HTTP", "Error", "Referrer"],
  )}
<h2>Skipped URLs (${d.skipped.length})</h2>${rows(d.skipped.slice(0, 500).map((x) => [esc(x.url), esc(x.reason)]), ["URL", "Reason"])}
<h2>Unsupported dynamic functionality</h2><ul>${d.unsupported.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
${d.unsupported.forms.length ? `<p>${d.unsupported.forms.length} form(s) were found; forms are not submitted and will not work offline.</p>` : ""}
${
    d.api?.records.length
      ? `<h2>API / XHR discovery (${esc(d.api.mode)})</h2><p>Requests issued by the crawled pages. State-changing requests are blocked and never replayed; stored bodies are redacted (see api-discovery.json).</p>${rows(
          d.api.records.slice(0, 300).map((r) => [esc(r.method), esc(r.url), esc(r.blocked ? "blocked" : String(r.status)), esc(r.kind + (r.graphql ? ` (${r.graphql.operationType})` : "")), esc(r.archived ? (r.localPath ?? "yes") : (r.notArchived ?? "no"))]),
          ["Method", "Endpoint", "HTTP", "Kind", "Archived"],
        )}`
      : d.unsupported.apiCalls.length
        ? `<p>XHR/fetch endpoints observed during rendering (not archived):</p><ul>${d.unsupported.apiCalls.slice(0, 50).map((u) => `<li>${esc(u)}</li>`).join("")}</ul>`
        : ""
  }
<h2>Visual comparison</h2>${visual}
<p class="warn">Fidelity is only claimed where measured above. Pages that depend on server-side logic, authentication, third-party widgets or live APIs cannot be fully reproduced offline.</p>
</body></html>`;
}
