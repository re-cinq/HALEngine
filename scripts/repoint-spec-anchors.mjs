#!/usr/bin/env node
// Re-points specs' [validated by](../../src/X.test.ts#Lnn) anchors after
// edits to the cited file - any cited
// repository file, whatever its kind: each anchor's line number is
// resolved to the content it cited in the base ref's copy of that file,
// that content is found in the working copy (compared with quotes and
// whitespace dropped, so a formatter pass is not drift), and the anchor is
// rewritten to the match whose surrounding lines agree with the baseline's. When the cited
// content occurs on several working lines, each candidate is scored by how
// many of the baseline's neighbouring lines it reproduces at the same offsets;
// a candidate whose context uniquely wins is chosen, and a tie is reported as
// ambiguous for manual fix (exit 1 in both modes) instead of guessing. An
// anchor into a file built of repeated blocks - a workflow whose jobs share an
// identical setup - must therefore cite a line unique to its own step, because
// the resolver refuses to guess between indistinguishable candidates.
//
// Usage:
//   node scripts/repoint-spec-anchors.mjs [--check] [base-ref]
//
// base-ref defaults to origin/main and must be the baseline the anchors were
// last correct against. Baseline line numbers are read from the base ref's
// copy of each spec, never from the working copy, so re-running against the
// same baseline is a no-op instead of a second translation. A spec whose
// anchor set (the ordered list of test paths it cites) differs from the base
// ref is skipped whole: its anchors were authored against the working tree,
// and no baseline exists to repoint them from. An individual anchor whose
// line number differs from the base spec's at the same position was
// deliberately retargeted by a spec edit: it is accepted as authored, never
// rewritten, and reported as "retargeted (not checked)".
//
// Independent of any baseline, every anchor must land on a line that exists
// and carries content: an anchor whose target file is missing, whose line is
// beyond the end of the file, or whose line is blank or closing punctuation
// is reported as rotten and fails the run in both modes. An anchor
// into a test file must additionally land on the it/test/describe declaration
// itself, because a line inside a test body names no case a reader can check.
// Non-test targets - a workflow, a config, package.json - are exempt from that
// last check: they have no declaration to land on.
//
// Also independent of any baseline, a short-form [Lnnn](...#Lmmm) label must
// name the line its own href points at. Labels are re-synced to their href
// after the anchor rewrite, so a repointed href carries its label with it;
// --check reports label/href disagreement as mislabelled and fails.
// --check rewrites nothing, so it judges each label against its current
// (un-repointed) href: a stale href is reported as stale, and once a plain run
// repoints it the label follows, so the two runs still converge in one pass.
//
// --check rewrites nothing and exits 1 when any anchor is stale (its baseline
// content now lives on a different line), unresolved (that content no
// longer exists), rotten, or mislabelled. Without --check, stale anchors are
// rewritten in place, labels are synced, and unresolved or rotten ones are
// reported for manual fix with exit 1; a rotten anchor the rewrite itself
// repoints needs no manual fix and is not reported.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import process from "node:process";
import { splitArgs } from "./lib/cli-args.mjs";

const TRACKED_PATH = String.raw`(?:\.\.\/)+(?:scripts\/[\w./-]+|[\w./-]+\.[A-Za-z]+)`;
const ANCHOR = new RegExp(String.raw`(${TRACKED_PATH})#L(\d+)`, "g");

// A short-form [Lnnn](../../src/X.test.ts#Lmmm) link: its visible label is a
// bare line number that must equal the href's #L number. The label has no
// meaning apart from the href, so it is force-synced to the href even when the
// href was manually retargeted; descriptive labels ([validated by], ...) never
// match and are never touched.
const LABEL_LINK = new RegExp(String.raw`\[L(\d+)\]\((${TRACKED_PATH})#L(\d+)\)`, "g");

const { flags, positional } = splitArgs(process.argv.slice(2));

if (flags.some((flag) => flag !== "--check") || positional.length > 1) {
  process.stderr.write("usage: repoint-spec-anchors.mjs [--check] [base-ref]\n");
  process.exit(2);
}
const checkMode = flags.includes("--check");
const baseRef = positional[0] ?? "origin/main";

const root = process.cwd();

const refResolves = () => {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
      cwd: root,
      stdio: "ignore",
    });

    return true;
  } catch {
    return false;
  }
};

if (!refResolves()) {
  process.stderr.write(`base ref does not resolve to a commit: ${baseRef}\n`);
  process.exit(2);
}

const readBaseFile = (path) => {
  try {
    return execFileSync("git", ["show", `${baseRef}:${path}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
};

const baseFileCache = new Map();
const baseFile = (path) => {
  if (!baseFileCache.has(path)) {
    baseFileCache.set(path, readBaseFile(path));
  }

  return baseFileCache.get(path);
};

const workingFileCache = new Map();
const workingFile = (path) => {
  if (workingFileCache.has(path)) {
    return workingFileCache.get(path);
  }
  const fullPath = join(root, path);
  const content = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : null;

  workingFileCache.set(path, content);

  return content;
};

const extractAnchors = (source) =>
  [...source.matchAll(ANCHOR)].map((match) => ({ path: match[1], line: Number(match[2]) }));

const CONTENTLESS = /^[)\]}>,;]*$/;

// Only test files are held to the declaration check below; a citation into a
// workflow, a config or package.json is a supported target with no such shape.
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_DECL = /^\s*(?:[fx]?it|[fx]?describe|test)\s*[.(`]/;

const rottenReason = (anchor, specDir) => {
  const testPath = normalize(join(specDir, anchor.path));
  const working = workingFile(testPath);

  if (working === null) {
    return `${testPath} does not exist in the working tree`;
  }
  const target = working.split("\n")[anchor.line - 1];

  if (target === undefined) {
    return `#L${anchor.line} is beyond the end of ${testPath}`;
  }

  if (CONTENTLESS.test(target.trim())) {
    return `#L${anchor.line} lands on a blank or closing line`;
  }

  if (TEST_FILE.test(testPath) && !TEST_DECL.test(target)) {
    return `#L${anchor.line} is not an it/test/describe declaration in ${testPath}`;
  }

  return null;
};

const sameAnchorPaths = (a, b) =>
  a.length === b.length && a.every((anchor, index) => anchor.path === b[index].path);

const CONTEXT_RADIUS = 4;

const contextScore = (baseLines, workingLines, baselineLine, candidateLine) => {
  let score = 0;

  for (let offset = -CONTEXT_RADIUS; offset <= CONTEXT_RADIUS; offset += 1) {
    if (offset === 0) {
      continue;
    }

    if (shape(baseLines[baselineLine - 1 + offset]) === shape(workingLines[candidateLine - 1 + offset])) {
      score += 1;
    }
  }

  return score;
};

// Lines are compared by shape, not text: a formatter changes quotes and
// spacing without moving anything, and that must not read as drift. An
// out-of-range line stays undefined so it never matches a real one.
const shape = (line) =>
  line === undefined ? undefined : line.replace(/["`]/g, "'").replace(/\s+/g, "");

// Resolves one anchor: the content its baseline line held at the base ref,
// located in the working copy of the same test file. Duplicate matches are
// disambiguated by surrounding context; a context tie is a failure, never a
// guess. Returns { expectedLine } or { failure } with the reason a manual
// fix is needed.
const resolveAnchor = (anchor, baselineLine, specDir) => {
  const testPath = normalize(join(specDir, anchor.path));
  const base = baseFile(testPath);

  if (base === null) {
    return { failure: `${testPath} does not exist at ${baseRef}` };
  }
  const working = workingFile(testPath);

  if (working === null) {
    return { failure: `${testPath} does not exist in the working tree` };
  }
  const baseLines = base.split("\n");
  const workingLines = working.split("\n");
  const target = baseLines[baselineLine - 1];

  if (target === undefined) {
    return { failure: `#L${baselineLine} is beyond the end of ${testPath} at ${baseRef}` };
  }
  const wanted = shape(target);
  const candidates = workingLines.flatMap((line, index) => (shape(line) === wanted ? [index + 1] : []));

  if (candidates.length === 0) {
    return { failure: `"${target.trim().slice(0, 70)}" no longer exists in ${testPath}` };
  }

  if (candidates.length === 1) {
    return { expectedLine: candidates[0] };
  }
  const scores = candidates.map((candidate) =>
    contextScore(baseLines, workingLines, baselineLine, candidate)
  );
  const bestScore = Math.max(...scores);
  const best = candidates.filter((_, index) => scores[index] === bestScore);

  if (best.length > 1) {
    return {
      failure: `"${target.trim().slice(0, 70)}" matches ambiguously at lines ${best.join(", ")} of ${testPath}`,
    };
  }

  return { expectedLine: best[0] };
};

const specFiles = [
  ...readdirSync(join(root, "specs"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `specs/${entry.name}/spec.md`)
    .sort(),
  ".specify/spec.md",
].filter((spec) => existsSync(join(root, spec)));

let moved = 0;
let upToDate = 0;
let retargeted = 0;
const unresolved = [];
const staleDetails = [];
const rotten = [];
const specContent = new Map();

for (const spec of specFiles) {
  const source = readFileSync(join(root, spec), "utf8");

  specContent.set(spec, source);
  const anchors = extractAnchors(source);

  if (anchors.length === 0) {
    continue;
  }
  const specDir = dirname(spec);
  const rottenReasons = anchors.map((anchor) => rottenReason(anchor, specDir));
  const reportRotten = (index) => {
    const reason = rottenReasons[index];

    if (reason === null) {
      return;
    }
    const anchor = anchors[index];

    rotten.push(`${spec}: ${anchor.path}#L${anchor.line} -> ${reason}`);
  };
  const baseSpec = baseFile(spec);

  if (baseSpec === null) {
    process.stderr.write(`skipped ${spec}: not present at ${baseRef}\n`);
    anchors.forEach((_, index) => reportRotten(index));
    continue;
  }
  const baseAnchors = extractAnchors(baseSpec);

  if (!sameAnchorPaths(anchors, baseAnchors)) {
    process.stderr.write(
      `skipped ${spec}: anchor set differs from ${baseRef} (anchors are taken as authored against the working tree)\n`
    );
    anchors.forEach((_, index) => reportRotten(index));
    continue;
  }
  const resolutions = anchors.map((anchor, index) => {
    if (anchor.line !== baseAnchors[index].line) {
      return { retargeted: true };
    }

    return resolveAnchor(anchor, baseAnchors[index].line, specDir);
  });

  resolutions.forEach((resolution, index) => {
    const anchor = anchors[index];
    const staysPut =
      resolution.retargeted || resolution.failure || resolution.expectedLine === anchor.line;

    if (checkMode || staysPut) {
      reportRotten(index);
    }

    if (resolution.retargeted) {
      retargeted += 1;
      upToDate += 1;

      return;
    }

    if (resolution.failure) {
      unresolved.push(`${spec}: ${anchor.path}#L${anchor.line} -> ${resolution.failure}`);

      return;
    }

    if (resolution.expectedLine === anchor.line) {
      upToDate += 1;

      return;
    }
    moved += 1;
    staleDetails.push(`${spec}: ${anchor.path}#L${anchor.line} -> #L${resolution.expectedLine}`);
  });

  if (checkMode) {
    continue;
  }
  let occurrence = -1;
  const rewritten = source.replace(ANCHOR, (whole, relPath) => {
    occurrence += 1;
    const resolution = resolutions[occurrence];

    if (
      resolution.retargeted ||
      resolution.failure ||
      resolution.expectedLine === anchors[occurrence].line
    ) {
      return whole;
    }

    return `${relPath}#L${resolution.expectedLine}`;
  });

  specContent.set(spec, rewritten);

  if (rewritten !== source) {
    writeFileSync(join(root, spec), rewritten);
  }
}

// Short-form labels are synced independently of the baseline: a label must
// agree with its own href regardless of whether that href moved. This reads
// the in-memory content the href rewrite above produced, so a label follows a
// freshly repointed href without re-reading the file from disk.
let relabelled = 0;
const mislabelled = [];

for (const spec of specFiles) {
  const source = specContent.get(spec);
  const rewritten = source.replace(LABEL_LINK, (whole, labelLine, relPath, hrefLine) => {
    if (labelLine === hrefLine) {
      return whole;
    }

    if (checkMode) {
      mislabelled.push(`${spec}: ${relPath}#L${hrefLine} -> label reads L${labelLine}`);

      return whole;
    }
    relabelled += 1;

    return `[L${hrefLine}](${relPath}#L${hrefLine})`;
  });

  if (!checkMode && rewritten !== source) {
    writeFileSync(join(root, spec), rewritten);
  }
}

const movedLabel = checkMode ? "stale" : "repointed";
const relabelledLabel = checkMode ? "mislabelled" : "relabelled";
const labelCount = checkMode ? mislabelled.length : relabelled;

process.stdout.write(
  `${movedLabel}: ${moved}, up to date: ${upToDate}, unresolved: ${unresolved.length}, ${relabelledLabel}: ${labelCount}\n`
);

if (retargeted > 0) {
  process.stdout.write(`retargeted (not checked): ${retargeted}\n`);
}

if (checkMode) {
  for (const detail of staleDetails) {
    process.stderr.write(`stale ${detail}\n`);
  }
}

for (const detail of unresolved) {
  process.stderr.write(`unresolved ${detail}\n`);
}

for (const detail of rotten) {
  process.stderr.write(`rotten ${detail}\n`);
}

for (const detail of mislabelled) {
  process.stderr.write(`mislabelled ${detail}\n`);
}

const failed =
  rotten.length > 0 ||
  unresolved.length > 0 ||
  (checkMode && (moved > 0 || mislabelled.length > 0));

process.exit(failed ? 1 : 0);
