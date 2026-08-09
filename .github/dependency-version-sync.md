# Dependency version sync

Dependabot updates dependencies it recognizes, but it cannot infer semantic links between arbitrary fields. This automation keeps those links explicit and applies them to Dependabot pull requests.

Each entry in [`dependency-version-sync.json`](./dependency-version-sync.json) defines:

- `manifest`: the JSON manifest relative to the repository root.
- `source`: a JSON Pointer to the authoritative dependency spec.
- `targets`: JSON Pointers and templates that must follow the source.
- `{{spec}}`: the complete source spec, such as `^2.3.0`.
- `{{version}}`: the single semantic version inside the source spec, such as `2.3.0`.

JSON Pointer escapes `/` as `~1`, so a scoped dependency path looks like `/dependencies/@scope~1package`.

Example for another linked override:

```json
{
  "manifest": "package.json",
  "source": "/dependencies/@scope~1tool",
  "targets": [
    {
      "path": "/overrides/@scope~1tool",
      "template": "{{spec}}"
    },
    {
      "path": "/pnpm/overrides/helper",
      "template": "npm:@scope/helper@{{version}}"
    }
  ]
}
```

The pull-request workflow runs the trusted synchronizer from the base branch, updates only existing configured fields, regenerates this repository's `bun.lock` with lifecycle scripts disabled, commits the result to the Dependabot branch, and explicitly dispatches CI. It then dispatches the trusted merge workflow with the new head SHA; that workflow waits for a successful CI run for that exact SHA before merging. The synchronizer itself is package-name and field agnostic; if another package ecosystem is added, its lockfile command can be attached to the same workflow. The explicit dispatch is required because pushes made with `GITHUB_TOKEN` do not normally start another workflow run.

Run the consistency check locally with:

```sh
node .github/scripts/sync-dependency-versions.mjs --check
```
