# Releasing SSH Ache

Two workflows drive distribution:

- **`.github/workflows/release.yml`** — builds installers for macOS, Windows, and
  Linux and attaches them to a GitHub Release.
- **`.github/workflows/homebrew.yml`** — updates the Homebrew cask so
  `brew install --cask SSH-Ache/sshache/sshache` tracks the latest macOS build.

## One-time setup

1. **Create the Homebrew tap repo:** `SSH-Ache/homebrew-sshache` (public,
   empty is fine). The tap name `SSH-Ache/sshache` maps to this repo.
2. **Add a tap token:** in the **app** repo, add a secret `HOMEBREW_TAP_TOKEN` —
   a Personal Access Token with write access to the tap repo (classic `repo`
   scope, or a fine-grained token scoped to `homebrew-sshache` with
   `Contents: read and write`).
3. *(macOS code signing/notarisation is optional.)* Without it, the `.dmg` still
   installs but Gatekeeper shows an unsigned-app warning. To sign, add the
   standard Tauri signing secrets and pass them through `release.yml`
   (`APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, etc.).

## Cutting a release

1. Bump the version in **`src-tauri/tauri.conf.json`** (and `package.json`) so the
   built filenames match the tag.
2. Commit, then tag and push:
   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. `release.yml` runs on the tag, builds every platform, and creates a **draft**
   release with the installers attached.
4. Review the draft on GitHub and **publish** it.
5. Publishing fires `homebrew.yml`, which downloads the universal `.dmg`,
   computes its SHA-256, and pushes `Casks/sshache.rb` to the tap.

## Artifacts produced

| Platform | File |
| --- | --- |
| macOS (universal) | `.dmg`, `.app.tar.gz` |
| Windows | `.msi`, `.exe` (NSIS) |
| Linux | `.AppImage`, `.deb` |

## Verify the cask

```sh
brew tap SSH-Ache/sshache
brew install --cask sshache
```
