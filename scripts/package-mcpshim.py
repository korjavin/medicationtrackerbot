#!/usr/bin/env python3
"""Assemble the public helper release contract from already-built raw assets.

No credentials or pairing codes enter this script. commands.json contains a
literal <PAIRING_CODE> placeholder for the separately reviewed UI consumer.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

parser = argparse.ArgumentParser()
parser.add_argument("directory", type=Path)
parser.add_argument("--version", required=True)
parser.add_argument("--commit", required=True)
parser.add_argument("--run-url", required=True)
args = parser.parse_args()
if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", args.version):
    parser.error("stable semantic version required")
if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
    parser.error("full source commit required")
root = Path(__file__).resolve().parent.parent
output = args.directory
names = [f"mcpshim_{args.version}_{system}_{arch}" + (".exe" if system == "windows" else "")
         for system in ("darwin", "linux", "windows") for arch in ("amd64", "arm64")]
if {path.name for path in output.iterdir()} != set(names):
    parser.error("input must contain exactly the six named raw binaries")
for name in names:
    if not (output / name).is_file():
        parser.error(f"missing raw asset: {name}")
for source, target in (("install-mcpshim.sh", "install.sh"), ("install-mcpshim.ps1", "install.ps1")):
    shutil.copyfile(root / "scripts" / source, output / target)
digest = lambda name: hashlib.sha256((output / name).read_bytes()).hexdigest()
base = f"https://github.com/korjavin/medicationtrackerbot/releases/download/mcpshim-v{args.version}"
# Bootstrap digest is embedded in the command, rather than obtained beside
# the installer. Trust still begins at the UI/repository serving this command.
posix = ("( set -eu; umask 077; d=$(mktemp -d); trap 'rm -rf \"$d\"' EXIT HUP INT TERM; "
         f"curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 '{base}/install.sh' -o \"$d/install.sh\"; "
         "if command -v sha256sum >/dev/null 2>&1; then h=$(sha256sum \"$d/install.sh\"); else h=$(shasum -a 256 \"$d/install.sh\"); fi; "
         f"[ \"${{h%% *}}\" = '{digest('install.sh')}' ]; "
         f"sh \"$d/install.sh\" --version {args.version} --pairing-code '<PAIRING_CODE>' )")
powershell = ("& { $ErrorActionPreference='Stop'; $d=$null; try { $d=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N')); "
              "[IO.Directory]::CreateDirectory($d) | Out-Null; $a=Get-Acl -LiteralPath $d; $a.SetAccessRuleProtection($true,$false); "
              "$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User,'FullControl','ContainerInherit,ObjectInherit','None','Allow')); Set-Acl -LiteralPath $d -AclObject $a; $p=Join-Path $d 'install.ps1'; "
              f"Invoke-WebRequest -UseBasicParsing -Uri '{base}/install.ps1' -OutFile $p; "
              f"if ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -ne '{digest('install.ps1')}') {{ throw 'Installer checksum mismatch' }}; "
              f"& $p -Version {args.version} -PairingCode '<PAIRING_CODE>'; "
              "if ($LASTEXITCODE -ne 0) { throw 'Installer failed' } } catch { [Console]::Error.WriteLine('Helper installation failed; check the pinned release and host policy.'); exit 1 } finally { if ($d -and (Test-Path -LiteralPath $d)) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue } } }")
commands = {"version": args.version, "tag": "mcpshim-v" + args.version,
            "source_commit": args.commit, "placeholder": "<PAIRING_CODE>",
            "posix": posix, "powershell": powershell,
            "installer_sha256": {name: digest(name) for name in ("install.sh", "install.ps1")}}
(output / "commands.json").write_text(json.dumps(commands, indent=2) + "\n")
provenance = {"version": args.version, "source_commit": args.commit, "workflow_run": args.run_url,
              "toolchain": "go1.26.5", "CGO_ENABLED": "0", "assets": names,
              "cross_compiled": names,
              "native_execution": "See required native job logs for actual GOOS/GOARCH; six builds do not imply six native executions.",
              "attestation_verification": "gh attestation verify <binary> --repo korjavin/medicationtrackerbot"}
(output / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
names += ["install.sh", "install.ps1", "commands.json", "provenance.json"]
(output / "SHA256SUMS").write_text("".join(f"{digest(name)}  {name}\n" for name in sorted(names)))
