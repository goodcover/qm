# Goodcover QM

This is the Goodcover source fork. Work on QM here. `origin` is the standalone
private `goodcover/qm` repository; `upstream` is `yc-software/qm`.

The existing deployment runs on GC4 EKS. Its Terraform, Kubernetes manifests,
image pins, and git-crypt secrets remain in the sibling `goodcover/ops` checkout.
Use `python3 deploy/layers/goodcover/ops.py` for operator commands from this repo.
This imported EKS layer does not use the CLI-generated AWS/ECS scaffolding.
Do not run `qm init` over it or `qm up --target aws` for GC4.

Material infrastructure additions need Dan's high-level approval. Creating this
source repository does not authorize a production upgrade or new infrastructure.
Keep Google Workspace login and the existing subscription credential for chats
and background jobs. No API-key fallback or Slack bot is configured.

Never copy decrypted secrets, `.local` records, credentials, workspace snapshots,
or Terraform state from ops into this repository. Only ops has git-crypt setup.
The sandbox build command creates a local archive by default; `--publish` creates
a billable AWS image version and must only be used for an authorized image update.

Keep Goodcover material under this layer. Use the upstream `update-qm` skill for
source updates and preserve merge ancestry. Upstream release workflows are
restricted to their upstream repository; GitHub Actions is disabled here until
our CI is deliberately enabled. Review imported workflows before enabling it.
