# Pre-PR Self-Check

Walk this list before opening the PR. Anything left unchecked needs a written reason in the PR body.

## Branch & target

- [ ] Current branch is NOT `dev`, `master`, or `main`
- [ ] Branch is rebased on (or fast-forwardable to) `origin/dev`
- [ ] PR target = `dev`

## Commit hygiene

- [ ] Each commit follows `<type>(<scope>): <summary>` with a vocabulary type (see `commit-conventions.md`)
- [ ] No commit was created with `--no-verify`
- [ ] No file added with `git add -f`
- [ ] No accidental staging of `node_modules/`, `dist/`, `*.log`, `.env*`, `data/`, or other gitignored paths
- [ ] No secrets in code or commit messages (API keys, tokens, cookies, oauth_state)

## CHANGELOG

- [ ] If the change touches `src/`, `shared/`, `web/`, `packages/`, `native/`, `config/`, or `.github/workflows/` → `CHANGELOG.md` `[Unreleased]` has a new entry
- [ ] Entry placed in correct subsection (Added / Changed / Fixed)
- [ ] Entry references the issue / PR number when applicable

## Cross-artifact impact

Codex-proxy ships three artifacts: backend (Docker), Electron desktop, web frontend. The pre-push hook will catch most of these, but verify mentally first:

- [ ] If `src/` changed → backend logic still passes `npm test`
- [ ] If `web/` changed → `npm run build` produces a clean Vite bundle, and `npm run test:web` passes (separate vitest project, `web/**/*.test.tsx` — not covered by root `npm test`, must be run explicitly)
- [ ] If `Dockerfile` / `docker-compose*` changed → image still builds
- [ ] If `packages/electron/**` or `electron-builder.yml` changed → Electron config validates
- [ ] If `native/**` changed → native addon still builds

## Tests

- [ ] New behavior has new tests (TDD: tests written first when feasible)
- [ ] All affected `npm test` suites pass locally
- [ ] No `*.skip` left behind unless explicitly justified in the PR body

## TypeScript

- [ ] No `any`, `as any`, `: any`, or `<any>` in new code (use `unknown`, generics, or specific types)
- [ ] No `@ts-ignore` / `@ts-expect-error` without an inline explanation comment

## Production Docker release gate

A green build is not a green release. v2.0.80 built clean, passed CI, and then exited 1 on every start because `node:sqlite` does not exist on Node 20 — `restart: unless-stopped` turned that into a production crash loop. Before any image is deployed:

- [ ] Image `node -v` meets the Dockerfile's declared minimum, and `node:sqlite` can `new DatabaseSync(":memory:")` inside the image
- [ ] `/app/native/codex-tls.linux-*.node` can be `require`d inside the image (a failed addon load is also fatal at startup)
- [ ] Container actually reaches `healthy`, `/health` returns 200, `RestartCount == 0`
- [ ] One ordinary request (`/v1/chat/completions`) returns 200 with the expected content
- [ ] Opaque compact end-to-end: root compact → resume with the same marker → **container restart → resume with the same marker again** (without the restart step, persistence is unverified)
- [ ] On a genuinely fresh deployment (new volumes, first time `claude_code_opaque_compact_experimental` is turned on): as of the auto-init change, `startOpaqueCompactRuntime()` bootstraps the master keyring automatically whenever `firstInit` is true (no prior state exists) — turning the switch on in Admin is itself the deliberate human action that authorizes it, matching the design intent behind `9b2763a`'s original (now-removed) `allowKeyringBootstrap` gate. No manual step, no script, no `keyring_file` configuration is required for this to work — this is also the *only* way the feature is usable on the desktop app at all (`.dmg` builds don't bundle `scripts/` or `tsx`, so a manual-script fallback isn't reachable there). If `firstInit` is false (real prior state exists) the store still fails closed with `key_unavailable` — that hard boundary is unchanged and must stay unchanged. `scripts/build/opaque-keyring-bootstrap.ts` still exists as an optional tool (pre-flight verification, disaster recovery, scripted/IaC use) — see its own doc comment; it is not part of the required path anymore.
- [ ] The digest that was verified is the digest that gets deployed (compare `RepoDigests`; tags can be re-pushed, digests cannot)
- [ ] No build artifact from a failed version is reused as the deploy candidate
- [ ] A failed deploy is rolled back immediately to the last known-healthy digest, keeping the failed image / key / state for forensics
- [ ] The one real compact switch (`claude_code_opaque_compact_experimental`) still defaults to `false` in the shipped product; `claude_code_compact_bridge` is a deprecated dead config key (classic bridge removed, keyed off nothing, warns once if set to `true`) — not a second switch to verify

The first three are enforced by the Dockerfile build-time assertions, the `ci-docker.yml` smoke steps, and `tests/unit/ci/docker-node-runtime.test.ts`. When adding a dependency on a builtin that only exists on newer Node, update `BUILTIN_MIN_NODE` in that test.

## Real-upstream changes

- [ ] If the change touches the upstream protocol (translation/, proxy/, auth/), `npm run test:real` was attempted at least once

## Documentation

- [ ] Public-facing config/flag changes are reflected in `config/default.yaml` comments and `CLAUDE.md` if relevant
- [ ] No internal personal notes leaked into committed files

## After push (do NOT do these in this skill)

- [ ] Wait for CI green before requesting review
- [ ] Merge is a separate, explicit decision — never auto-merge from this skill
