# Release Process

This project publishes `sandcode` to npm.

- Registry: `https://registry.npmjs.org`
- Package: `sandcode`
- Tags:
  - `next` for prerelease validation builds
  - `latest` for stable releases

## Automated Flow

Workflow: `.github/workflows/publish.yml`

1. Any merge to `main` triggers publish automation.
2. Normal PR merges publish the next patch as a prerelease tagged `next`.
3. The automated bump PR publishes the stable patch tagged `latest`.
4. The workflow verifies:
   - the expected dist-tag points to the published version
   - a clean registry install succeeds
   - `sandcode --help` and subcommand help all execute

## Required Repository Configuration

- GitHub Actions:
  - `contents: write`
  - `pull-requests: write`
- npm trusted publishing:
  - configure `sandcode` on npm to trust this GitHub repository
  - keep the publish job on a GitHub-hosted runner so npm can verify OIDC identity
- Optional:
  - `GH_PAT` if bump PR creation should use a PAT instead of `GITHUB_TOKEN`

## Verify Current Published State

```bash
npm view sandcode dist-tags
npm view sandcode versions --json
```

## First Publish From Local

The first `sandcode` publish should be done locally to create the package on npm. After that, enable npm trusted publishing for the GitHub repo and point it at `.github/workflows/publish.yml`.

```bash
bun install
bun run check
bun run typecheck
bun test
bun run build
npm pack
```

Then install the tarball into a clean local test project and smoke it before publishing:

```bash
cd /path/to/sandcode-testing
mkdir -p local-publish-check
cd local-publish-check
npm init -y
npm install /absolute/path/to/sandcode-<version>.tgz
./node_modules/.bin/sandcode --help
./node_modules/.bin/sandcode analyze --help
./node_modules/.bin/sandcode start --help
./node_modules/.bin/sandcode setup --help
```

When that passes, publish from the repo root:

```bash
npm login
npm publish
```

If your npm account requires publish-time 2FA, the npm CLI will prompt for the verification step. With a YubiKey/WebAuthn setup, that flow is handled interactively rather than by a static `--otp` value.

## Rollback

Reset `latest`:

```bash
npm dist-tag add sandcode@0.0.<good> latest
```

Reset `next`:

```bash
npm dist-tag add sandcode@0.0.<good>-next.<build> next
```

Delete a bad version:

- remove it from npm with an account allowed to manage package versions

## Manual Recovery

1. Revert bad code on a PR and merge it.
2. Retag `next` or `latest` if installs need to be corrected immediately.
3. Verify:
   - `npm view sandcode dist-tags`
   - clean install into a temp project
   - `sandcode --help`
4. Keep the automated version-bump PR aligned with the next intended stable patch.
