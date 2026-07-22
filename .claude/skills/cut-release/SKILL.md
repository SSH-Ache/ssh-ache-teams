---
name: cut-release
description: Cut a desktop release of the SSH Ache Teams app — bump version, add changelog, tag, build installers, publish, update Homebrew. Use when releasing a new version.
---

# Cut a desktop release (Teams app)

1. Bump the version in BOTH `package.json` and `src-tauri/tauri.conf.json` (keep them equal).
   `src-tauri/Cargo.toml` version is NOT bumped per release.
2. Add a `CHANGELOG` entry at the top of the array in `src/App.tsx`.
3. `npm run build` — confirm the frontend compiles (`tsc` does not check `App.tsx`; esbuild does).
4. Commit `chore(release): vX.Y.Z`, PR, merge to `main`.
5. Tag + push: `git tag vX.Y.Z && git push origin vX.Y.Z` → `.github/workflows/release.yml`
   builds installers into a **DRAFT** release.
6. Poll `gh run view <id>` until green (not `gh run watch`), then publish:
   `gh release edit vX.Y.Z --draft=false`.
7. Publishing triggers `.github/workflows/homebrew.yml`, which updates the Homebrew cask — this
   needs a tap repo + a `HOMEBREW_TAP_TOKEN` secret configured, or it fails.

Notes:
- Teams changes (anything in `src/teams/` or backend-connected) stay in this repo only; local
  features should remain portable to the community `ssh-ache` repo.
- Never change the frozen `@sshache/crypto` wire format in a release without matching the platform.
