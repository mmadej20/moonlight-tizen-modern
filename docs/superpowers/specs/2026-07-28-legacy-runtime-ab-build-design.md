# Legacy runtime A/B build design

## Goal

Produce a signed `Moonlight.wgt` for a controlled TV test while retaining all
current audio-sync, HEVC timing, recovery, and diagnostic fixes.

The package must restore the application-facing profile from immediately before
commit `7eff49d`:

- `required_version="5.5"`;
- jQuery 2.2.0 referenced by `index.html`;
- no jQuery 4.0.0 asset in the WGT.

## Constraint: the compiler did not change

Commit `7eff49d` retained Tizen Studio CLI 6.1, Samsung Emscripten 1.39.4.7,
`latest-fastcomp`, the CMake toolchain file, and the CMake flags. Therefore no
historically different WASM compiler exists to select at this boundary.

The experiment tests the legacy manifest and frontend runtime. It must not be
described as proof that a different compiler was used.

## Considered approaches

1. Check out the parent of `7eff49d` and build it.
   Rejected because it would discard all later reliability fixes and confound
   the crash comparison.
2. Revert the complete modernization commit.
   Rejected because release extraction, documentation, and dependency tooling
   do not execute on the TV and would add unrelated variables.
3. Restore only the packaged runtime profile on the current branch.
   Selected because it changes the minimum Tizen declaration and jQuery version
   while preserving current native code and the proven signing pipeline.

## Implementation

- Restore the tracked jQuery 2.2.0 minified asset from `7eff49d^`.
- Point `wasm/index.html` to that asset.
- Set `required_version="5.5"` in `res/config.xml`.
- Remove the jQuery 4 dependency-fetch stage and copy step from `Dockerfile`.
- Remove the now-unused jQuery dependency from the npm manifest and lockfile,
  while retaining the Node test runner declaration and artifact-only final
  Docker stage.
- Update the dependency-manifest regression test before implementation, observe
  it fail against the current profile, then make it pass.

## Verification

Run the complete JavaScript suite, targeted native receiver tests used by the
current branch, and a fresh Docker build. Extract the signed WGT and verify:

- both Tizen signature files exist;
- packaged `config.xml` declares 5.5;
- packaged `index.html` references jQuery 2.2.0;
- jQuery 2.2.0 exists and jQuery 4.0.0 does not;
- the current diagnostic markers remain in the packaged JavaScript/WASM assets;
- record file size, UTC timestamp, SHA-256, and source commit.

Device behavior remains unverified until the package is installed and streamed
on the target TV.
