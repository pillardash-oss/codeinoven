# Publishing the Oven CLI

`@pdslng/cio-oven` is the command that turns a machine into an Oven without this app reaching it first. It ships on its own cadence, separately from the desktop app, because a machine prepared with `npx` has to receive the same service bundle the app would push.

One command runs the whole release, in the order that keeps the three moving parts in agreement:

```sh
bun run oven:cli:publish
```

It refuses rather than guesses. The run stops before anything reaches the registry when:

- the tree has uncommitted changes in `package.json`, `packages/cio-oven`, `scripts`, `src/lib/ovens.ts` or `src/main/ovens`, because those are what the published package is built from;
- npm is not authenticated, so the account cannot be named;
- the target version already exists on npm.

## What it does

1. Builds the app, which produces `out/main/oven-service.mjs`.
2. Bumps `packages/cio-oven/package.json` by one patch version.
3. Builds `dist/cli.mjs` and `dist/service.mjs` from that bundle.
4. Inspects the tarball with `npm pack --dry-run` and fails when a required file is missing (`bin/cio-oven.mjs`, `dist/cli.mjs`, `dist/service.mjs`, `package.json`, `README.md`, `LICENSE`) or when source files are shipped.
5. Publishes with `--access public`.
6. Polls the registry until the version is served, then commits the version bump.

## Flags

| Flag                | Use                                                               |
| ------------------- | ----------------------------------------------------------------- |
| `--version <x.y.z>` | Publish an exact version instead of bumping the patch.            |
| `--no-bump`         | Publish the version already in the manifest, for a retry.         |
| `--dry-run`         | Build and inspect the tarball, change nothing, publish nothing.   |
| `--skip-build`      | Reuse the existing `out/main/oven-service.mjs`.                   |
| `--otp <code>`      | Forward a one-time code to npm for an account without 2FA bypass. |
| `--no-commit`       | Leave the version bump uncommitted.                               |
| `--allow-dirty`     | Publish anyway with uncommitted changes in the release paths.     |

## When npm stages the release

npm defers the 2FA proof for granular tokens, so a publish can land in staging instead of the registry. The script reports that instead of claiming success, and it does not commit the bump. Finish it with the one-time code:

```sh
npm stage list
npm stage approve <stage-id> --otp <code>
```

An account that cannot see the staged entry in `npm stage list` does not own the scope: the owner approves it on the package page at `https://www.npmjs.com/package/@pdslng/cio-oven`, or the release runs with a token from an account that does.

## Verify by hand

```sh
npm view @pdslng/cio-oven version dist-tags
npx @pdslng/cio-oven@<version> status
```

The published package carries the same service bundle the app ships in that build, so the app shows the Oven as current only when the revision matches. Publishing a CLI built from a stale `out/` is what makes an Oven report an old revision, which is why the script rebuilds the app unless `--skip-build` says otherwise.
