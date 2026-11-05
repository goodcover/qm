# Deployed apps on the QM origin

Superseded: this records a 0.1.11-era derived image. Its change now lives in
the source tree, and current releases build from source.

Dan authorized removing QM's browser sandbox from deployed apps on 2026-09-17.
Apps served through `/d/`, the admin deployment proxy, and `/deployments/` now
run on the QM origin. They can use browser storage and make authenticated
same-origin requests. Deployment sign-in and scope authorization still apply.
Application-provided Content-Security-Policy headers pass through unchanged.
File previews and the playground retain their separate sandbox policies.

The application source changes live in `src/api/routes/deployments.ts` and
`plugins/web-ui/server/index.ts`. The production release uses two derived images
from the existing 0.1.11 pins, avoiding an unrelated application upgrade.
`open-app-origin.patch` is the backport against source commit
`51bf455ea414a58f70274284ce212142518e556a`; it changes only those two files.
The Dockerfiles replace one TypeScript file in each immutable baseline image.

To reproduce the build from the QM repository root:

```sh
build_dir=$(mktemp -d /tmp/qm-app-origin.XXXXXX)
git archive 51bf455ea414a58f70274284ce212142518e556a \
  src/api/routes/deployments.ts plugins/web-ui/server/index.ts | tar -x -C "$build_dir"
patch_file="$PWD/deploy/layers/goodcover/app-origin/open-app-origin.patch"
(cd "$build_dir" && git apply "$patch_file")
cp deploy/layers/goodcover/app-origin/*.Dockerfile "$build_dir/"
podman build --platform linux/amd64 -f core.Dockerfile \
  -t 008562636938.dkr.ecr.us-west-2.amazonaws.com/goodcover/qm:core-0.1.11-gc.1 "$build_dir"
podman build --platform linux/amd64 -f web-ui.Dockerfile \
  -t 008562636938.dkr.ecr.us-west-2.amazonaws.com/goodcover/qm:web-ui-0.1.11-gc.1 "$build_dir"
```

Ops owns the ECR repository declaration, deployment image digests, and rollout
record in `gc4/env/qm.tf` and `gc4/packages/qm/`. Production image tags are
immutable. Future releases need new tags; Kubernetes uses digests.
