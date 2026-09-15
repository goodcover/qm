#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import subprocess
import sys

LAYER = Path(__file__).resolve().parent
CHECKOUT = LAYER.parents[2]
CONTEXT = 'arn:aws:eks:us-west-2:008562636938:cluster/prod-gc4-eks-cluster'


def main():
    parser = argparse.ArgumentParser(description='Operate the existing GC4 EKS deployment from the QM checkout.')
    parser.add_argument('command', choices=['status', 'images', 'deploy', 'network-test'])
    parser.add_argument('--ops-root', type=Path, default=CHECKOUT.parent / 'ops')
    args = parser.parse_args()
    deployment = args.ops_root.resolve() / 'gc4/packages/qm'
    if not (deployment / 'deploy.py').is_file():
        parser.error('GC4 ops checkout not found; use --ops-root /path/to/ops')
    if args.command == 'status':
        subprocess.run(['kubectl', '--context', CONTEXT, '-n', 'qm', 'get', 'deployments,statefulsets,pods,pvc'], check=True)
    elif args.command == 'images':
        print(json.dumps(json.loads((deployment / 'images.json').read_text()), indent=2))
    elif args.command == 'deploy':
        subprocess.run([sys.executable, str(deployment / 'deploy.py')], cwd=deployment, check=True)
    elif args.command == 'network-test':
        subprocess.run([sys.executable, str(deployment / 'network/run-canary.py'), 'test'], cwd=deployment, check=True)


if __name__ == '__main__':
    main()
