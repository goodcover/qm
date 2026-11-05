#!/usr/bin/env python3
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import zipfile

LAYER = Path(__file__).resolve().parent
ROOT = LAYER.parents[2]
AWS = ['aws', '--profile', 'admin-dcos', '--region', 'us-west-2', '--output', 'json', '--no-cli-pager']
IMAGE = 'arn:aws:lambda:us-west-2:008562636938:microvm-image:gc4-qm-sandbox'


def aws(*args):
    return json.loads(subprocess.check_output([*AWS, *args]))


def main():
    parser = argparse.ArgumentParser(description='Build a GC4 sandbox archive from this source checkout.')
    parser.add_argument('--publish', action='store_true', help='Upload and create a new AWS image version.')
    args = parser.parse_args()
    assets = ROOT / 'cli/templates/aws/microvm-agent'
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in ('Dockerfile', 'agent.mjs'):
            content = (assets / name).read_bytes()
            if name == 'Dockerfile':
                content += b'\nCOPY microvm-runtime.mjs /opt/microvm-agent/microvm-runtime.mjs\nCMD ["node", "/opt/microvm-agent/microvm-runtime.mjs"]\n'
            info = zipfile.ZipInfo(name, (2026, 9, 14, 0, 0, 0))
            archive.writestr(info, content)
        archive.writestr(zipfile.ZipInfo('microvm-runtime.mjs', (2026, 9, 14, 0, 0, 0)),
                         (LAYER / 'sandbox/microvm-runtime.mjs').read_bytes())
    content = buffer.getvalue()
    digest = hashlib.sha256(content).hexdigest()
    private = LAYER / '.local'
    private.mkdir(mode=0o700, exist_ok=True)
    path = private / 'gateway-image.zip'
    path.write_bytes(content)
    path.chmod(0o600)
    print(json.dumps({'archive': str(path), 'archiveSha256': digest, 'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()}))
    if not args.publish:
        return
    if aws('sts', 'get-caller-identity')['Account'] != '008562636938':
        raise RuntimeError('Unexpected AWS account')
    key = f'deployment/microvm-images/{digest}.zip'
    aws('s3api', 'put-object', '--bucket', 'goodcover-gc4-qm', '--key', key, '--body', str(path))
    result = aws('lambda-microvms', 'update-microvm-image', '--image-identifier', IMAGE,
        '--base-image-arn', 'arn:aws:lambda:us-west-2:aws:microvm-image:al2023-1',
        '--description', 'QM native DNS through the dedicated GC4 VPC gateway',
        '--build-role-arn', 'arn:aws:iam::008562636938:role/gc4-qm-microvm-build',
        '--code-artifact', f'uri=s3://goodcover-gc4-qm/{key}',
        '--cpu-configurations', 'architecture=ARM_64', '--resources', 'minimumMemoryInMiB=2048',
        '--logging', json.dumps({'cloudWatch': {'logGroup': '/aws/lambda/microvms/gc4-qm-sandbox'}}),
        '--additional-os-capabilities', '["ALL"]',
        '--hooks', json.dumps({'port': 8082, 'microvmHooks': {
            'run': 'ENABLED', 'runTimeoutInSeconds': 30,
            'resume': 'ENABLED', 'resumeTimeoutInSeconds': 30,
            'suspend': 'DISABLED', 'terminate': 'DISABLED'},
            'microvmImageHooks': {'ready': 'ENABLED', 'readyTimeoutInSeconds': 60, 'validate': 'DISABLED'}}),
        '--client-token', digest)
    (LAYER / '.local/gateway-image-build.json').write_text(json.dumps({**result, 'archiveSha256': digest}, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
