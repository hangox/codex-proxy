import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..", "..");

/**
 * Builtin modules that only exist on newer Node runtimes. If application code
 * imports one of these, the Docker runtime base image must be new enough or the
 * container dies at startup with ERR_UNKNOWN_BUILTIN_MODULE — which
 * `restart: unless-stopped` turns into a production crash loop.
 *
 * `node:sqlite` landed flagged in 22.5.0 and unflagged in 22.13.0.
 */
const BUILTIN_MIN_NODE: ReadonlyArray<{ specifier: string; major: number; minor: number }> = [
  { specifier: "node:sqlite", major: 22, minor: 13 },
];

function readDockerfile(): string {
  return readFileSync(resolve(ROOT, "Dockerfile"), "utf-8");
}

/** Returns the base image of the last `FROM` (the stage that actually runs). */
function runtimeBaseImage(dockerfile: string): string {
  const fromLines = dockerfile
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^FROM\s/i.test(line));

  expect(fromLines.length).toBeGreaterThan(0);
  const last = fromLines[fromLines.length - 1]!;
  const image = last.replace(/^FROM\s+/i, "").split(/\s+/)[0]!;
  return image;
}

function parseNodeVersion(image: string): { major: number; minor: number } {
  const match = /^node:(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(image);
  if (!match) {
    throw new Error(
      `Runtime stage base image "${image}" is not a recognizable node:<version> image; ` +
        `update this guard if the runtime image intentionally changed.`,
    );
  }
  return { major: Number(match[1]), minor: match[2] === undefined ? 0 : Number(match[2]) };
}

describe("Dockerfile runtime Node version", () => {
  it("pins an explicit node:<major.minor.patch> runtime image", () => {
    const image = runtimeBaseImage(readDockerfile());
    expect(image).toMatch(/^node:\d+\.\d+\.\d+(-\S+)?$/);
  });

  it.each(BUILTIN_MIN_NODE)(
    "runtime Node satisfies the minimum required by $specifier",
    ({ specifier, major, minor }) => {
      const image = runtimeBaseImage(readDockerfile());
      const version = parseNodeVersion(image);
      const satisfied = version.major > major || (version.major === major && version.minor >= minor);
      expect(
        satisfied,
        `Runtime image ${image} cannot load ${specifier} (needs >= ${major}.${minor}.0)`,
      ).toBe(true);
    },
  );

  it("asserts node:sqlite loadability at image build time", () => {
    const dockerfile = readDockerfile();
    expect(dockerfile).toMatch(/RUN\s+node\s[^\n]*node:sqlite/);
  });
});

describe("Docker smoke coverage", () => {
  it("runs the docker smoke workflow on master pushes that touch src/", () => {
    const workflow = readFileSync(resolve(ROOT, ".github", "workflows", "ci-docker.yml"), "utf-8");
    const pushSection = workflow.split("push:")[1];
    expect(pushSection, "ci-docker.yml must have a push trigger").toBeDefined();
    const pushPaths = pushSection!.split("jobs:")[0]!;
    expect(pushPaths).toContain('"src/**"');
    expect(pushPaths).toContain('"package*.json"');
  });
});
