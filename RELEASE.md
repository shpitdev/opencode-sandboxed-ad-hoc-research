# Release Process

This project publishes to GitHub Packages, not npmjs.org.

- Registry: `https://npm.pkg.github.com`
- Package: `@shpitdev/opencode-sandboxed-ad-hoc-research`
- Tags:
  - `next` for prerelease validation builds
  - `latest` for stable public installs

## Automated Flow

Workflow: `.github/workflows/publish-package.yml`

1. Any merge to `main` triggers publish automation.
2. The workflow resolves the merged PR context:
   - Normal PR merge:
     - publishes `0.0.(x+1)-next.<run>.<attempt>.<sha>` with npm tag `next`
     - opens or updates draft bump PR `ci/version-bump-0.0.(x+1)`
   - Bump PR merge (`ci/version-bump-0.0.x`):
     - publishes `0.0.x` with npm tag `latest`
     - does not create another bump PR
3. The workflow verifies:
   - dist-tag points to the just-published version
   - clean install from GitHub Packages into a fresh project
   - installed CLI binaries execute (`--help`)

## Required Repository Configuration

- GitHub Actions:
  - `GITHUB_TOKEN` must keep `contents:write`, `pull-requests:write`, `packages:write` permissions in `publish-package.yml`.
- Optional token:
  - `GH_PAT` can be set to let `create-pull-request` use a PAT instead of `GITHUB_TOKEN`.
- Branch governance:
  - Keep required checks enforced for PRs into `main`:
    - `CodeQL`

## Verify Current Published State

```bash
# requires a token with read:packages
export NODE_AUTH_TOKEN="<token>"

npm view @shpitdev/opencode-sandboxed-ad-hoc-research dist-tags --registry https://npm.pkg.github.com
npm view @shpitdev/opencode-sandboxed-ad-hoc-research versions --json --registry https://npm.pkg.github.com
```

## Rollback Playbook

### Wrong `latest` version

Point `latest` back to a known-good version:

```bash
export NODE_AUTH_TOKEN="<token with packages:write>"
npm dist-tag add @shpitdev/opencode-sandboxed-ad-hoc-research@0.0.<good> latest --registry https://npm.pkg.github.com
```

### Wrong `next` version

Point `next` to a known-good prerelease or stable version:

```bash
export NODE_AUTH_TOKEN="<token with packages:write>"
npm dist-tag add @shpitdev/opencode-sandboxed-ad-hoc-research@0.0.<good>-next.<build> next --registry https://npm.pkg.github.com
```

### Bad version must be removed

Delete the package version from GitHub Packages (org package settings or API) using a token with package delete privileges.

## Manual Recovery Steps

1. Revert incorrect code on a PR and merge to `main`.
2. If needed, retag `next`/`latest` first to stop new installs from pulling bad builds.
3. Confirm dist-tags and install:
   - `npm view ... dist-tags`
   - install into clean temp project
4. Keep bump PR (`ci/version-bump-*`) aligned with intended next stable patch.
