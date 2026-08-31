# [auto-docu P3] Extract a .hwp / .hwpx to plain text (tables inline as
# markdown) with hwp-hwpx-parser (pure Python, Apache-2.0). Run by asHwp.js via
# the docling venv's python.exe.  Usage:  python hwp_extract.py <file>
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: hwp_extract.py <file>", file=sys.stderr)
        return 2
    from hwp_hwpx_parser import Reader

    with Reader(sys.argv[1]) as r:
        enc = r.is_encrypted
        if (enc() if callable(enc) else enc):
            print("encrypted", file=sys.stderr)
            return 3
        sys.stdout.write(r.text or "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
