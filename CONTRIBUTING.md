# Contributing to Paper Pilot

## Local setup

Use Node.js 22.18.0 or a compatible newer 22.x release. The repository includes `.nvmrc` for version managers.

```bash
npm ci
npm run verify
```

`npm run verify` checks formatting, linting, TypeScript, unit coverage, and the production build. Networked crawler smoke tests are intentionally scheduled outside the pull request gate.

## Pull request workflow

1. Create a branch from the latest `main`.
2. Make the change and add or update tests.
3. Run `npm run verify` locally.
4. Open a pull request and wait for `CI / Gate`.
5. Resolve review conversations and squash-merge the pull request.

`main` accepts changes only through pull requests. Ubuntu quality checks, Windows compatibility tests, CodeQL, dependency review, and the release-label policy must pass before merge. A separate reviewer approval is not required.

## Release labels

Every squash merge creates a signed Windows GitHub Release. Choose at most one version label:

- No release label or `release:patch`: patch release, such as `v1.2.3` to `v1.2.4`.
- `release:minor`: minor release, such as `v1.2.3` to `v1.3.0`.
- `release:major`: major release, such as `v1.2.3` to `v2.0.0`.

Git tags are the version source of truth. The release workflow injects the calculated version into the signed package, while the checked-in manifest stays at `0.0.0-development`.

If publishing fails after merge, rerun the failed workflow. For recovery, manually dispatch the Release workflow with the merge commit SHA; it will reuse the existing version and repair incomplete assets.

## Useful commands

```bash
npm run format          # Apply Prettier
npm run format:check    # Check formatting only
npm run lint            # ESLint with zero warnings
npm run typecheck       # Renderer and Electron TypeScript checks
npm test                # Deterministic unit and renderer smoke tests
npm run test:coverage   # Tests plus coverage thresholds
npm run verify:platform # Typecheck, tests, and build without coverage reporting
```
