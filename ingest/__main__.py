"""Command-line entry point for internal ingestion."""
import argparse
import sys

from .extract import IngestError, extract_from_manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--only")
    args = parser.parse_args(argv)
    try:
        for meta in extract_from_manifest(args.manifest, args.out, only=args.only):
            print(f"{meta['source_id']}: {meta['page_count']} pages, mean quality "
                  f"{meta['quality']['mean']:.3f}, {meta['quality']['low_pages']} pages queued for review")
    except IngestError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
