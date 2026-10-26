"""Dependency vulnerability audit helper for pre-commit hooks.

Runs `cargo audit` / `npm audit` in the given directories and exits
non-zero if any of them report vulnerabilities (npm: --audit-level=high).

Checks are skipped with a warning (exit 0) when the required tool or
lockfile is missing, so the hook never blocks on an absent toolchain:
- cargo audit  : requires `cargo install cargo-audit --locked`
- npm audit    : requires package-lock.json in the target directory

Usage:
    python scripts/security_audit.py [--cargo DIR]... [--npm DIR]...
"""

import argparse
import os
import shutil
import subprocess
import sys


def run(cmd, cwd):
    print(f"[security_audit] ({os.path.relpath(cwd)})$ {' '.join(cmd)}")
    if os.name == "nt":
        return subprocess.run(" ".join(cmd), cwd=cwd, shell=True).returncode  # nosec B602
    return subprocess.run(cmd, cwd=cwd).returncode


def cargo_audit(root):
    cargo = shutil.which("cargo")
    if not cargo:
        print("[security_audit] SKIP: cargo not found")
        return 0
    probe = subprocess.run(
        [cargo, "audit", "--version"], capture_output=True
    )
    if probe.returncode != 0:
        print(
            "[security_audit] SKIP: cargo-audit not installed "
            "(cargo install cargo-audit --locked)"
        )
        return 0
    if not os.path.isfile(os.path.join(root, "Cargo.lock")):
        if run([cargo, "generate-lockfile"], root):
            return 1
    return run([cargo, "audit"], root)


def npm_audit(root):
    if not (
        os.path.isfile(os.path.join(root, "package.json"))
        and os.path.isfile(os.path.join(root, "package-lock.json"))
    ):
        print(
            f"[security_audit] SKIP: {os.path.relpath(root)} has no "
            "package.json + package-lock.json pair"
        )
        return 0
    if not shutil.which("npm"):
        print("[security_audit] SKIP: npm not found")
        return 0
    return run(["npm", "audit", "--audit-level=high"], root)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cargo", action="append", default=[], metavar="DIR")
    ap.add_argument("--npm", action="append", default=[], metavar="DIR")
    args = ap.parse_args()
    code = 0
    for d in args.cargo:
        code |= cargo_audit(os.path.abspath(d))
    for d in args.npm:
        code |= npm_audit(os.path.abspath(d))
    return code


if __name__ == "__main__":
    sys.exit(main())
