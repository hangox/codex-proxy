import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_OUT = resolve(ROOT, "portable-release");
const BUNDLE = resolve(ROOT, "packages/electron/dist-electron/server.mjs");

function parseArgs(argv) {
  const options = {
    out: DEFAULT_OUT,
    version: process.env.PORTABLE_VERSION ?? null,
    webview2Host: process.env.PORTABLE_WEBVIEW2_HOST ?? null,
    webview2HostX86: process.env.PORTABLE_WEBVIEW2_HOST_X86 ?? null,
    webview2HostX64: process.env.PORTABLE_WEBVIEW2_HOST_X64 ?? null,
    webview2HostArm64: process.env.PORTABLE_WEBVIEW2_HOST_ARM64 ?? null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ([
      "--out", "--version", "--webview2-host", "--webview2-host-x86",
      "--webview2-host-x64", "--webview2-host-arm64",
    ].includes(arg)) {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--out") options.out = resolve(value);
      else if (arg === "--version") options.version = value;
      else if (arg === "--webview2-host") options.webview2Host = resolve(value);
      else if (arg === "--webview2-host-x86") options.webview2HostX86 = resolve(value);
      else if (arg === "--webview2-host-x64") options.webview2HostX64 = resolve(value);
      else options.webview2HostArm64 = resolve(value);
    } else if (arg.startsWith("--out=")) {
      options.out = resolve(arg.slice("--out=".length));
    } else if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
    } else if (arg.startsWith("--webview2-host=")) {
      options.webview2Host = resolve(arg.slice("--webview2-host=".length));
    } else if (arg.startsWith("--webview2-host-x86=")) {
      options.webview2HostX86 = resolve(arg.slice("--webview2-host-x86=".length));
    } else if (arg.startsWith("--webview2-host-x64=")) {
      options.webview2HostX64 = resolve(arg.slice("--webview2-host-x64=".length));
    } else if (arg.startsWith("--webview2-host-arm64=")) {
      options.webview2HostArm64 = resolve(arg.slice("--webview2-host-arm64=".length));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function requirePath(path, description) {
  if (!existsSync(path)) throw new Error(`${description} not found: ${path}`);
}

function commandExists(command) {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  return spawnSync(lookup, [command], { stdio: "ignore", windowsHide: true }).status === 0;
}

function copyDirectory(source, destination) {
  requirePath(source, "Required directory");
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true, force: true });
}

function copyRuntimeNative(source, destination) {
  requirePath(source, "native source directory");
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) {
    const sourcePath = join(source, name);
    if (name === "index.js" || name === "index.d.ts" || name.endsWith(".node")) {
      cpSync(sourcePath, join(destination, name), { force: true });
    }
  }
  // The generated napi-rs loader is CommonJS. The portable package is often
  // extracted below a repository or application with `type: module`; keep a
  // local package boundary so Node does not reinterpret native/index.js as ESM.
  writeFileSync(join(destination, "package.json"), '{"type":"commonjs"}\n');
}

function existingPath(...candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

function msysPath(path) {
  const normalized = resolve(path).replaceAll("\\", "/");
  const drive = normalized.match(/^([A-Za-z]):\/(.*)$/);
  return drive ? `/${drive[1].toLowerCase()}/${drive[2]}` : normalized;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function msys2Roots() {
  const runnerMsys2 = process.env.RUNNER_TEMP
    ? join(process.env.RUNNER_TEMP, "setup-msys2", "msys64")
    : null;
  const runnerMsys2Root = process.env.RUNNER_TEMP
    ? join(process.env.RUNNER_TEMP, "setup-msys2")
    : null;
  return [
    process.env.MSYS2_ROOT,
    process.env.PORTABLE_MSYS2_ROOT,
    "D:\\DevTools\\Tools\\msys64",
    runnerMsys2,
    runnerMsys2Root,
    "C:\\msys64",
  ].filter(Boolean);
}

function resolveMsys2LauncherToolchain() {
  for (const root of msys2Roots()) {
    const compiler = existingPath(join(root, "mingw32", "bin", "gcc.exe"));
    const bash = existingPath(join(root, "usr", "bin", "bash.exe"));
    const resourceCompiler = compiler && existingPath(
      join(dirname(compiler), "windres.exe"),
      join(root, "mingw32", "bin", "windres.exe"),
      join(root, "mingw64", "bin", "windres.exe"),
    );
    if (compiler && bash && resourceCompiler) return { compiler, bash, resourceCompiler };
  }
  return null;
}

function tryBuildWindowsLauncher(destination) {
  if (process.platform !== "win32") {
    return false;
  }

  const source = resolve(SCRIPT_DIR, "win-launcher.c");
  const resource = resolve(SCRIPT_DIR, "codex-proxy.rc");
  const output = join(destination, "codex-proxy.exe");
  const requireExe = process.env.PORTABLE_REQUIRE_WINDOWS_EXE === "1";
  const toolchain = resolveMsys2LauncherToolchain();
  if (!toolchain) {
    const message = "MSYS2 MinGW x86 compiler/resource compiler was not found; using .cmd fallback";
    if (requireExe) throw new Error(`PORTABLE_REQUIRE_WINDOWS_EXE=1 but ${message}`);
    console.warn(`[portable] ${message}`);
    return false;
  }
  requirePath(source, "Windows launcher source");
  requirePath(resource, "Windows launcher icon resource");

  // Build through MSYS2's bash so Windows paths are converted consistently.
  // The x86 launcher is intentionally architecture-neutral at the package
  // boundary: Windows x64 and Windows on ARM64 can run it through their
  // compatibility layers, while it dispatches to the user's Node binary.
  const resourceObject = join(destination, ".codex-proxy-icon.o");
  const compilerBin = dirname(toolchain.compiler);
  const environment = `export PATH=${shellQuote(msysPath(compilerBin))}:/usr/bin:$PATH; `;
  const resourceCommand = [
    shellQuote(msysPath(toolchain.resourceCompiler)),
    "-I", shellQuote(msysPath(SCRIPT_DIR)),
    shellQuote(msysPath(resource)),
    "-O", "coff",
    "-o", shellQuote(msysPath(resourceObject)),
  ].join(" ");
  const resourceResult = spawnSync(toolchain.bash, ["-lc", environment + resourceCommand], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (resourceResult.error || resourceResult.status !== 0 || !existsSync(resourceObject)) {
    rmSync(resourceObject, { force: true });
    const detail = resourceResult.error?.message ?? resourceResult.stderr ?? resourceResult.stdout ?? "unknown error";
    if (requireExe) throw new Error(`MSYS2 Windows launcher icon build failed: ${detail}`);
    console.warn(`[portable] MSYS2 Windows launcher icon build failed: ${detail}; using .cmd fallback`);
    return false;
  }

  const command = [
    shellQuote(msysPath(toolchain.compiler)),
    "-O2",
    "-s",
    "-municode",
    "-mwindows",
    "-static",
    "-static-libgcc",
    "-static-libstdc++",
    shellQuote(msysPath(source)),
    shellQuote(msysPath(resourceObject)),
    "-luser32",
    "-lshell32",
    "-o", shellQuote(msysPath(output)),
  ].join(" ");
  const result = spawnSync(toolchain.bash, [
    "-lc",
    environment + command,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  rmSync(resourceObject, { force: true });
  if (result.error) {
    if (requireExe) throw result.error;
    console.warn(`[portable] MSYS2 launcher build could not start: ${result.error.message}; using .cmd fallback`);
    return false;
  }
  if (result.status !== 0) {
    if (requireExe) throw new Error(`MSYS2 Windows launcher build failed:\n${result.stdout}\n${result.stderr}`);
    console.warn("[portable] MSYS2 launcher build failed; using .cmd fallback");
    return false;
  }
  if (!existsSync(output)) {
    if (requireExe) throw new Error(`MSYS2 launcher build succeeded but output was not created: ${output}`);
    console.warn("[portable] MSYS2 launcher output was not created; using .cmd fallback");
    return false;
  }
  return true;
}

function copyWebView2Host(source, destination, architecture = null) {
  const target = join(destination, "hosts", "webview2", ...(architecture ? [`win-${architecture}`] : []));
  mkdirSync(target, { recursive: true });
  if (!source) {
    return false;
  }
  requirePath(source, "WebView2 host");
  const stat = readFileSync(source);
  writeFileSync(join(target, "webview2-host.exe"), stat);
  return true;
}

function copyWebView2Hosts(options, destination) {
  const hosts = [
    [options.webview2Host, null],
    [options.webview2HostX86, "x86"],
    [options.webview2HostX64, "x64"],
    [options.webview2HostArm64, "arm64"],
  ];
  const included = hosts
    .filter(([source]) => source)
    .map(([source, architecture]) => {
      copyWebView2Host(source, destination, architecture);
      return architecture ?? "default";
    });
  const target = join(destination, "hosts", "webview2");
  mkdirSync(target, { recursive: true });
  if (included.length === 0) {
    writeFileSync(join(target, "README.txt"),
      "WebView2 host is not included in this development build.\r\n" +
      "Provide --webview2-host-x86/--webview2-host-x64 when packaging a host executable.\r\n");
  }
  return included;
}

function createZip(stage, archive) {
  // Python's zipfile is the only cross-platform deflate implementation with an
  // explicit compression level that the Windows/macOS/Linux runners share; the
  // archive test harness already requires Python 3 for metadata checks.
  // A ZipInfo passed to writestr() ignores the archive-level compression and
  // compresslevel and uses ZipInfo's own compress_type, which defaults to
  // ZIP_STORED — set both explicitly on every file entry.
  const pythonScript = [
    "import os, sys, zipfile",
    "stage, output = sys.argv[1:3]",
    "with zipfile.ZipFile(output, 'w') as archive:",
    "    for root, dirs, files in os.walk(stage):",
    "        dirs.sort()",
    "        rel_root = os.path.relpath(root, stage).replace('\\\\', '/')",
    "        prefix = '' if rel_root == '.' else rel_root + '/'",
    "        for name in sorted(dirs):",
    "            info = zipfile.ZipInfo(prefix + name + '/')",
    "            info.create_system = 3",
    "            info.external_attr = (0o755 << 16) | 0x10",
    "            archive.writestr(info, b'')",
    "        for name in sorted(files):",
    "            rel = prefix + name",
    "            mode = 0o755 if (rel == 'codex-proxy.sh' or rel.endswith('/codex-proxy.sh')) else 0o644",
    "            info = zipfile.ZipInfo(rel)",
    "            info.compress_type = zipfile.ZIP_DEFLATED",
    "            info.create_system = 3",
    "            info.external_attr = mode << 16",
    "            with open(os.path.join(root, name), 'rb') as source:",
    "                archive.writestr(info, source.read(), compresslevel=9)",
  ].join("\n");
  for (const python of ["python", "python3"]) {
    if (!commandExists(python)) continue;
    const result = spawnSync(python, ["-c", pythonScript, stage, archive], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 0) return "python-zipfile";
    console.warn(`[portable] ${python} zip creation failed: ${result.stderr || result.stdout}`);
  }
  throw new Error("No zip compressor found. Install Python 3 to create the zip archive.");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootPackage = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const version = options.version ?? rootPackage.version;
  requirePath(BUNDLE, "server bundle; run the Electron esbuild step first");
  requirePath(resolve(ROOT, "public", "index.html"), "built web assets; run npm run build first");

  const stage = resolve(options.out, ".staging", "codex-proxy");
  const archive = resolve(options.out, `codex-proxy-${version}-no-node-lite-all-platforms.zip`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  mkdirSync(options.out, { recursive: true });

  const app = join(stage, "app");
  mkdirSync(app, { recursive: true });
  cpSync(BUNDLE, join(app, "server-bundle.mjs"));
  cpSync(resolve(SCRIPT_DIR, "server.mjs"), join(app, "server.mjs"));
  const webview2Hosts = copyWebView2Hosts(options, stage);
  writeFileSync(join(app, "manifest.json"), JSON.stringify({
    name: "codex-proxy-lite",
    version,
    bundledNode: false,
    minimumNodeMajor: 20,
    modes: ["server", "browser", "auto", "webview2"],
    webview2: {
      hostArchitectures: webview2Hosts,
      runtimeInstall: "download-on-demand",
      supportedWindows: "Windows 10 SAC 1709+ and supported Windows 10 LTSC/IoT/Server editions; Windows 11",
    },
  }, null, 2) + "\n");

  for (const directory of ["config", "public", "bin"]) {
    copyDirectory(resolve(ROOT, directory), join(stage, directory));
  }
  cpSync(resolve(SCRIPT_DIR, "THIRD-PARTY-NOTICES.txt"), join(stage, "THIRD-PARTY-NOTICES.txt"));
  mkdirSync(join(stage, "data"), { recursive: true });
  copyRuntimeNative(resolve(ROOT, "native"), join(stage, "native"));

  cpSync(resolve(SCRIPT_DIR, "codex-proxy.sh"), join(stage, "codex-proxy.sh"));
  chmodSync(join(stage, "codex-proxy.sh"), 0o755);
  const hasWindowsExe = tryBuildWindowsLauncher(stage);
  // Keep the script even when the native launcher is present. It is useful
  // for diagnostics, custom Node resolution, and environments where the EXE
  // cannot be started by policy or compatibility tooling.
  cpSync(resolve(SCRIPT_DIR, "codex-proxy.cmd"), join(stage, "codex-proxy.cmd"));

  rmSync(archive, { force: true });
  const compressor = createZip(stage, archive);
  rmSync(resolve(options.out, ".staging"), { recursive: true, force: true });

  console.log(`[lite] archive: ${archive}`);
  console.log(`[lite] compression: ${compressor} (-9)`);
  console.log(`[lite] Windows launcher: ${hasWindowsExe ? "codex-proxy.exe (MSYS2 MinGW x86)" : "codex-proxy.cmd fallback"}`);
  console.log("[lite] Windows script fallback: codex-proxy.cmd (always included)");
  console.log(`[lite] WebView2 host: ${webview2Hosts.length ? webview2Hosts.join(", ") : "not included"}`);
  console.log("[lite] WebView2 installer: downloaded on demand when missing (not bundled)");
}

main();
