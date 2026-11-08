"""Command-line entry point for internal ingestion."""
import argparse
import sys
import subprocess
from pathlib import Path

from .extract import IngestError, extract_from_manifest


def _check_output(path):
    """Keep internal full text out of unignored Git paths."""
    path = Path(path).resolve()
    ancestor = path
    while not ancestor.exists():
        ancestor = ancestor.parent
    try:
        repo = subprocess.run(["git", "-C", str(ancestor), "rev-parse", "--show-toplevel"],
                              capture_output=True, text=True)
        if repo.returncode != 0:
            return
        root = Path(repo.stdout.strip()).resolve()
        if not path.is_relative_to(root):
            return
        ignored = subprocess.run(["git", "-C", str(root), "check-ignore", "-q", "--", str(path)],
                                 capture_output=True)
    except FileNotFoundError:
        return
    if ignored.returncode != 0:
        raise IngestError(f"Output path must be ignored by git: {path}")


def _summary(meta):
    print(f"{meta['source_id']}: {meta['page_count']} pages, mean quality "
          f"{meta['quality']['mean']:.3f}, {meta['quality']['low_pages']} pages queued for review",
          flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--out", default="sources/extracts")
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--only")
    args = parser.parse_args(argv)
    try:
        out = Path(args.out)
        if not out.is_absolute():
            out = Path(args.repo_root) / out
        _check_output(out)
        extract_from_manifest(args.manifest, out, only=args.only,
                              repo_root=args.repo_root, on_result=_summary)
    except IngestError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
