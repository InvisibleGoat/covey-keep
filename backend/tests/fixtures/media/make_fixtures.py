"""Regenerates the committed media fixtures (CK-36) — run from backend/:

    python tests/fixtures/media/make_fixtures.py

The three files beside this script are the REAL SUBJECTS of the arc's most
important test: an image carrying EXIF GPS goes into the processor, and the
test asserts no GPS comes out of any of the three layers. That promise has
been stated in five decision records and executed by nothing until CK-36;
a test against a mock would prove nothing, so the fixtures are genuine
files with a genuine GPS IFD, generated here so their provenance is on the
record and nobody has to wonder whose photograph they are (they are nobody's
— synthetic pixels, and the coordinates below are a public landmark, not a
home).

  gps-oriented.jpg   JPEG, EXIF orientation 6 (rotate 90° CW to display) +
                     GPS + Make/Model. The pixel layout is asymmetric — the
                     top-left quadrant of the STORED image is red, the rest
                     blue — so "upright" is checkable pixel by pixel: after
                     the transpose the red quadrant sits top-RIGHT.
  gps.png            PNG with an eXIf chunk carrying the same GPS IFD (no
                     orientation) — the PNG decoder path, and proof that the
                     stripping is not a JPEG-only accident.
  gps.heic           HEIC (pillow-heif) carrying the same GPS IFD — the
                     phone-first launch shape's default format, the one the
                     intent allowlist admits and CK-36 settled (record §0).

Every value is deterministic, so a regeneration produces byte-identical
files unless Pillow or libheif changes its encoder.
"""

from __future__ import annotations

from pathlib import Path

from PIL import ExifTags, Image
import pillow_heif

HERE = Path(__file__).resolve().parent

# A public landmark (the Bean, Chicago) — never anyone's home.
LATITUDE = ("N", (41.0, 52.0, 58.0))
LONGITUDE = ("W", (87.0, 37.0, 25.0))


def _exif(*, orientation: int | None) -> bytes:
    exif = Image.Exif()
    exif[ExifTags.Base.Make] = "CoveyKeep fixture"
    exif[ExifTags.Base.Model] = "synthetic"
    if orientation is not None:
        exif[ExifTags.Base.Orientation] = orientation
    gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
    gps[ExifTags.GPS.GPSLatitudeRef], gps[ExifTags.GPS.GPSLatitude] = LATITUDE
    gps[ExifTags.GPS.GPSLongitudeRef], gps[ExifTags.GPS.GPSLongitude] = LONGITUDE
    return exif.tobytes()


def _quadrant_image(width: int = 96, height: int = 64) -> Image.Image:
    """Blue, with the top-left quadrant red — asymmetric on both axes so
    every one of the eight EXIF orientations lands somewhere distinct."""
    image = Image.new("RGB", (width, height), (0, 0, 255))
    red = Image.new("RGB", (width // 2, height // 2), (255, 0, 0))
    image.paste(red, (0, 0))
    return image


def main() -> None:
    pillow_heif.register_heif_opener()
    base = _quadrant_image()
    base.save(HERE / "gps-oriented.jpg", "JPEG", quality=92, exif=_exif(orientation=6))
    base.save(HERE / "gps.png", "PNG", exif=_exif(orientation=None))
    base.save(HERE / "gps.heic", "HEIF", quality=90, exif=_exif(orientation=None))
    for name in ("gps-oriented.jpg", "gps.png", "gps.heic"):
        print(name, (HERE / name).stat().st_size, "bytes")


if __name__ == "__main__":
    main()
