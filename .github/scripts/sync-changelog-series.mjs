import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EMPTY_UNRELEASED_NOTICE = "> 暂无已记录的变更。";
const REPOSITORY_URL = "https://github.com/icebear0828/codex-proxy";

export function resolveSeries(version) {
  const match = /^(\d+)\.(\d+)\.\d+(?:[-+].*)?$/.exec(version);
  if (!match) {
    throw new Error(`Expected a semantic version, received ${version}`);
  }
  return `${match[1]}.${match[2]}`;
}

function trimBlankLines(lines) {
  let first = 0;
  let last = lines.length;
  while (first < last && lines[first].trim() === "") first += 1;
  while (last > first && lines[last - 1].trim() === "") last -= 1;
  return lines.slice(first, last);
}

function findSectionEnd(lines, start) {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) return index;
  }
  return lines.length;
}

function splitCategorySections(lines) {
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith("### ")) {
      if (current) sections.push(current);
      current = { heading: line, body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) sections.push(current);
  return sections;
}

function mergeCategorySections(pendingLines, targetLines) {
  const pending = splitCategorySections(pendingLines);
  const target = splitCategorySections(targetLines);
  if (pending.length === 0 || target.length === 0) {
    return trimBlankLines([...pendingLines, "", ...targetLines]);
  }

  const targetByHeading = new Map(target.map((section) => [section.heading, section]));
  const merged = pending.map((section) => {
    const existing = targetByHeading.get(section.heading);
    if (!existing) return section;
    targetByHeading.delete(section.heading);
    return {
      heading: section.heading,
      body: trimBlankLines([
        ...trimBlankLines(section.body),
        "",
        ...trimBlankLines(existing.body),
      ]),
    };
  });
  for (const section of target) {
    if (targetByHeading.has(section.heading)) merged.push(section);
  }

  return trimBlankLines(merged.flatMap((section, index) => [
    ...(index > 0 ? [""] : []),
    section.heading,
    "",
    ...trimBlankLines(section.body),
  ]));
}

function seriesHeading(series) {
  return `## [v${series}.x](${REPOSITORY_URL}/releases?q=${series}) - Unreleased`;
}

export function syncChangelogSeries(markdown, series) {
  if (!/^\d+\.\d+$/.test(series)) {
    throw new Error(`Expected a major.minor series, received ${series}`);
  }

  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = markdown.endsWith("\n");
  const lines = markdown.split(/\r?\n/);
  if (hasTrailingNewline) lines.pop();

  const unreleasedIndex = lines.indexOf("## [Unreleased]");
  if (unreleasedIndex === -1) {
    throw new Error("CHANGELOG.md is missing its ## [Unreleased] section");
  }

  const unreleasedEnd = findSectionEnd(lines, unreleasedIndex);
  const pendingLines = trimBlankLines(
    lines.slice(unreleasedIndex + 1, unreleasedEnd).filter((line) => line !== EMPTY_UNRELEASED_NOTICE),
  );
  const targetPrefix = `## [v${series}.x]`;
  const targetIndex = lines.findIndex((line) => line.startsWith(targetPrefix));

  if (pendingLines.length === 0 && targetIndex !== -1) {
    return markdown;
  }

  const normalizedUnreleased = ["", EMPTY_UNRELEASED_NOTICE, ""];
  if (targetIndex === -1) {
    const remaining = lines.slice(unreleasedEnd);
    const result = [
      ...lines.slice(0, unreleasedIndex + 1),
      ...normalizedUnreleased,
      seriesHeading(series),
      ...(pendingLines.length > 0 ? ["", ...pendingLines] : []),
      ...(remaining.length > 0 ? [""] : []),
      ...remaining,
    ];
    return `${trimBlankLines(result).join(eol)}${hasTrailingNewline ? eol : ""}`;
  }

  const targetEnd = findSectionEnd(lines, targetIndex);
  const targetBody = trimBlankLines(lines.slice(targetIndex + 1, targetEnd));
  const mergedTargetBody = mergeCategorySections(pendingLines, targetBody);
  const afterTarget = lines.slice(targetEnd);
  const result = [
    ...lines.slice(0, unreleasedIndex + 1),
    ...normalizedUnreleased,
    ...lines.slice(unreleasedEnd, targetIndex + 1),
    ...(mergedTargetBody.length > 0 ? ["", ...mergedTargetBody] : []),
    ...(mergedTargetBody.length > 0 && afterTarget.length > 0 ? [""] : []),
    ...afterTarget,
  ];
  return `${trimBlankLines(result).join(eol)}${hasTrailingNewline ? eol : ""}`;
}

function parseArguments(argv) {
  const options = { check: false, series: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      options.check = true;
      continue;
    }
    if (argument === "--series") {
      options.series = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const changelogPath = resolve(root, "CHANGELOG.md");
  const packagePath = resolve(root, "package.json");
  const packageVersion = JSON.parse(readFileSync(packagePath, "utf8")).version;
  const series = options.series ?? resolveSeries(packageVersion);
  const current = readFileSync(changelogPath, "utf8");
  const updated = syncChangelogSeries(current, series);

  if (options.check) {
    if (updated !== current) {
      console.error(`CHANGELOG.md must be synchronized into v${series}.x before release`);
      process.exitCode = 1;
    }
    return;
  }

  if (updated !== current) {
    writeFileSync(changelogPath, updated);
    console.log(`Synchronized CHANGELOG.md into v${series}.x`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
