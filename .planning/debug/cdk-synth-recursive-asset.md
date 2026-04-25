---
slug: cdk-synth-recursive-asset
status: investigating
trigger: |
  Bug B: cdk synth fails with recursive asset bundling. An Asset construct in a CDK stack points at a directory containing cdk.out/, creating infinite nesting (asset.9dc02e.../packages/cdk/cdk.out/asset.9dc02e.../... 40+ levels deep). Grep packages/cdk/lib/ for Asset constructs (new s3_assets.Asset, Code.fromAsset, etc.) that point at repo root, ../.., or similar broad paths. Fix is usually adding exclude: ['cdk.out', 'cdk.out.*', 'node_modules'] or scoping to a narrower subdirectory. Blocks deploy.
created: 2026-04-23
updated: 2026-04-23
---

# Debug Session: cdk-synth-recursive-asset

## Symptoms

- **Expected behavior:** `cdk synth` should produce a CloudFormation template and a clean cdk.out/ without recursive asset nesting. Assets should bundle only the intended source directories.
- **Actual behavior:** `cdk synth` creates recursively nested asset hashes — `cdk.out/asset.9dc02e.../packages/cdk/cdk.out/asset.9dc02e.../packages/cdk/cdk.out/...` repeating 40+ levels deep. Eventually fails (likely ENAMETOOLONG or similar).
- **Error messages:** Recursive path nesting in cdk.out/ during synth.
- **Timeline:** Present on Windows before EC2 migration — not environment-related. Blocks deploy.
- **Reproduction:** `cd packages/cdk && pnpm cdk synth` (or equivalent monorepo command).
- **Hypothesis from user:** One or more `new s3_assets.Asset(...)` or `Code.fromAsset(...)` constructs in packages/cdk/lib/ point at a directory that contains cdk.out/ (e.g. repo root, `../..`, or the cdk package itself). Fix: add `exclude: ['cdk.out', 'cdk.out.*', 'node_modules']` or scope the asset to a narrower subdirectory.

## Current Focus

- hypothesis: An Asset/Code.fromAsset construct in packages/cdk/lib/ points at a path that contains the cdk.out/ directory, causing each synth to re-ingest its own previous output.
- test: Grep packages/cdk/lib/ for `s3_assets.Asset`, `Code.fromAsset`, `DockerImage.fromAsset`, `Source.asset`, and any `fromAsset(` call. Inspect each path arg. Identify the one that resolves to a directory containing cdk.out/.
- expecting: At least one asset path resolves to repo root, `path.resolve(__dirname, '../..')`, or the packages/cdk directory itself. Adding an exclude list or narrowing the path fixes it.
- next_action: gather initial evidence — list all Asset/fromAsset usages in packages/cdk/lib/, check packages/cdk/cdk.json, and determine which asset is pulling cdk.out/.

## Evidence

(to be populated by debugger)

## Eliminated

(none yet)

## Resolution

(pending)
