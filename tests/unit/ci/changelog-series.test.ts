import { describe, expect, it } from "vitest";

import { resolveSeries, syncChangelogSeries } from "../../../.github/scripts/sync-changelog-series.mjs";

describe("syncChangelogSeries", () => {
  it("moves unreleased entries into the active existing series", () => {
    const current = `# Changelog

## [Unreleased]

### Added

- Adds a release-safe changelog synchronizer.

## [v2.1.x](https://github.com/icebear0828/codex-proxy/releases?q=2.1) - 2026-09-01 至 2026-09-07

### Fixed

- Keeps prior release history.
`;

    expect(syncChangelogSeries(current, "2.1")).toBe(`# Changelog

## [Unreleased]

> 暂无已记录的变更。

## [v2.1.x](https://github.com/icebear0828/codex-proxy/releases?q=2.1) - 2026-09-01 至 2026-09-07

### Added

- Adds a release-safe changelog synchronizer.

### Fixed

- Keeps prior release history.
`);
  });

  it("creates the active series heading when a new major.minor series starts", () => {
    const current = `# Changelog

## [Unreleased]

### Fixed

- Restores release visibility.
`;

    expect(syncChangelogSeries(current, "3.0")).toBe(`# Changelog

## [Unreleased]

> 暂无已记录的变更。

## [v3.0.x](https://github.com/icebear0828/codex-proxy/releases?q=3.0) - Unreleased

### Fixed

- Restores release visibility.
`);
  });

  it("is idempotent after synchronization", () => {
    const current = `# Changelog

## [Unreleased]

> 暂无已记录的变更。

## [v2.1.x](https://github.com/icebear0828/codex-proxy/releases?q=2.1) - 2026-09-01 至 2026-09-07
`;

    expect(syncChangelogSeries(current, "2.1")).toBe(current);
  });

  it("merges matching categories instead of duplicating their headings", () => {
    const current = `# Changelog

## [Unreleased]

### Fixed

- Restores the current release.

## [v2.1.x](https://github.com/icebear0828/codex-proxy/releases?q=2.1) - 2026-09-01 至 2026-09-07

### Fixed

- Keeps prior release history.
`;

    const updated = syncChangelogSeries(current, "2.1");
    expect(updated.match(/^### Fixed$/gm)).toHaveLength(1);
    expect(updated).toContain("- Restores the current release.\n\n- Keeps prior release history.");
  });

  it("derives the release series from a semantic version", () => {
    expect(resolveSeries("2.1.5")).toBe("2.1");
    expect(resolveSeries("3.0.0-beta.1")).toBe("3.0");
    expect(() => resolveSeries("2.1")).toThrow("Expected a semantic version");
  });
});
