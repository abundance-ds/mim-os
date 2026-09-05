# App Auto-Update

This covers updating the Mim desktop binary. It is separate from package update
checks in `src/main/packages/updateCheck.ts`.

## Supported Builds

| Platform | Target | Auto-update |
|---|---|---|
| macOS arm64/x64 | dmg + zip | yes |
| Windows x64 | nsis | yes |
| Linux x64/arm64 | AppImage | yes |
| Linux x64/arm64 | deb, tar.gz | no; manual download |

macOS needs the zip artifact for Squirrel.Mac updates; the dmg remains the
first-install artifact. Linux update checks only run when `APPIMAGE` is present.

## Build Metadata

`electron-builder.config.mjs` has a GitHub `publish` config for
`abundance-ds/mim-os`. That makes electron-builder write:

- packaged `app-update.yml`
- `latest-mac.yml`
- `latest.yml`
- `latest-linux.yml`
- `latest-linux-arm64.yml`
- blockmaps

The release workflow still controls uploads manually. It runs electron-builder
with `--publish never`, then uploads installers, zip files, blockmaps, and
`latest*.yml` to the GitHub Release. Before upload, it verifies that every file
named by the platform's update manifest exists in the packaging output. The
Windows NSIS artifact uses the explicit name `Mim-Setup-<version>.exe` so the
manifest and GitHub asset name cannot diverge through filename normalization.

macOS arm64 and x64 are built in one macOS job so electron-builder writes one
arch-aware `latest-mac.yml` containing both zip files. Separate mac jobs would
clobber `latest-mac.yml`.

Linux x64 and arm64 are built in separate native Linux jobs so native modules
are rebuilt for the target architecture. Electron Builder writes x64 AppImage
updates to `latest-linux.yml` and arm64 AppImage updates to
`latest-linux-arm64.yml`.

`deb.publish: null` keeps deb artifacts out of updater metadata.

## Runtime

`src/main/autoUpdater.ts` wraps `electron-updater`.

- Initializes only for packaged updater-capable builds.
- Uses the packaged `app-update.yml`; it does not call `setFeedURL`.
- Sets `autoDownload = false`.
- Sets `autoInstallOnAppQuit = true`.
- Checks once after startup, then every four hours.
- Sends update events to the renderer and hosted package runtime.

The renderer shows persistent toasts:

- `Download` when an update is available.
- `Restart` after the update downloads.

Preload exposes `downloadUpdate()` and `quitAndInstall()`.

## Release Checklist

1. Bump `package.json` version.
2. Commit and tag with the same version, for example `v0.2.1`.
3. Push the tag.
4. Confirm the release contains installers, zip files, blockmaps, and
   `latest*.yml`.
5. Confirm packaged apps contain `app-update.yml`.
6. Install a signed older build.
7. Publish a newer signed build.
8. Open the older build and verify the Download and Restart update flow.

Local unsigned packaging can prove metadata generation, but it cannot prove
macOS update application. macOS end-to-end update testing needs signed and
notarized builds.

## Verification Commands

```bash
npm run test
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac -- --publish never
npm run dist:linux -- --x64 --publish never
```

Run the Linux arm64 packaging smoke on GitHub's `ubuntu-24.04-arm` runner or
another ARM64 Linux host:

```bash
npm run dist:linux -- --arm64 --publish never
```

After the mac packaging smoke:

```bash
sed -n '1,120p' dist-installers/latest-mac.yml
find dist-installers -path '*/Mim.app/Contents/Resources/app-update.yml' -print -exec sed -n '1,40p' {} \;
```
