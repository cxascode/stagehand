#!/usr/bin/env python3
"""
Assembles flat, loadable extension folders under build/<browser>/
from src/ + manifests/manifest.<browser>.json — same thing the
GitHub Actions workflow does, but local and on demand for testing.

Usage:
    python3 scripts/build.py            # builds both chrome and firefox
    python3 scripts/build.py chrome     # builds just one
    python3 scripts/build.py firefox
"""

import json
import shutil
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = REPO_ROOT / "src"
MANIFESTS_DIR = REPO_ROOT / "manifests"
BUILD_DIR = REPO_ROOT / "build"

BROWSERS = ["chrome", "firefox"]


def build(browser: str) -> Path:
    manifest_src = MANIFESTS_DIR / f"manifest.{browser}.json"
    if not manifest_src.exists():
        sys.exit(f"error: {manifest_src} not found")

    out_dir = BUILD_DIR / browser
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    for item in SRC_DIR.iterdir():
        dest = out_dir / item.name
        if item.is_dir():
            shutil.copytree(item, dest)
        else:
            shutil.copy2(item, dest)

    shutil.copy2(manifest_src, out_dir / "manifest.json")
    return out_dir


    shutil.copy2(manifest_src, out_dir / "manifest.json")
    return out_dir


def read_version(out_dir: Path) -> str:
    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    version = manifest.get("version")
    if not version:
        sys.exit(f"error: no version in {out_dir / 'manifest.json'}")
    return version


def zip_package(out_dir: Path, browser: str) -> Path:
    version = read_version(out_dir)
    zip_path = BUILD_DIR / f"stagehand-{browser}-{version}.zip"
    if zip_path.exists():
        zip_path.unlink()

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(out_dir.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(out_dir))

    return zip_path


def main():
    targets = sys.argv[1:] or BROWSERS
    zip_paths = []
    for browser in targets:
        if browser not in BROWSERS:
            sys.exit(f"error: unknown browser '{browser}', expected one of {BROWSERS}")
        out_dir = build(browser)
        zip_path = zip_package(out_dir, browser)
        zip_paths.append((browser, out_dir, zip_path))
        print(f"Built {browser} -> {out_dir}")
        print(f"  Zip {read_version(out_dir)} -> {zip_path}")

    print("\nLoad unpacked:")
    for browser, out_dir, _ in zip_paths:
        if browser == "chrome":
            print(f"  Chrome:  chrome://extensions -> Load unpacked -> {out_dir}")
        elif browser == "firefox":
            print(f"  Firefox: about:debugging -> Load Temporary Add-on -> {out_dir / 'manifest.json'}")

    print("\nStore upload (manifest.json at zip root):")
    for _, _, zip_path in zip_paths:
        print(f"  {zip_path}")


if __name__ == "__main__":
    main()
