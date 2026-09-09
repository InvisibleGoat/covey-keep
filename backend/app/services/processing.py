"""Processing — decode a photograph, apply its orientation, strip every byte
of metadata, and render the three derivative layers (CK-36).

Pure functions over bytes: no database, no network, no logging. The worker's
claim service (ingest.py) calls `render_layers` off the event loop and owns
everything around it — the read from quarantine, the writes to published,
the atomic `ready` transaction, the deletion of the original. This module
knows nothing about a media row, a bucket, or a key.

WHAT COMES OUT, per `decisions/2026-08-25-media-derivative-layers.md` §1/§4:

    layer      target                          format       storage class
    archival   ~4000px long edge, quality 90   JPEG         Infrequent Access
    web        ~2560px long edge               WebP q82     Standard
    thumbnail  ~400px long edge, <= ~30 KB     WebP         Standard

Never upscaled: a small original yields small renditions, and the layer set
stays three rows regardless — a 640px snapshot gets an archival, a web and a
thumbnail layer that are all 640px and differ only in encoding. §5's format
fact is why the web layer's quality is where it is: against JPEG, WebP saves
25-35% (the 90% figure that circulates is PNG->WebP), so ~2560px WebP lands
in the record's 400-700 KB band at a quality that does not visibly cost.

THE ORDER OF OPERATIONS IS THE POINT, and each step is here for a reason:

1. OPEN, and read the header only. Pillow parses dimensions lazily, so the
   pixel guard (MAX_PIXELS, ~50 megapixels — pipeline record §6.6: worker
   memory tracks pixels, not bytes, so a small heavily-compressed file is
   still a decompression bomb and the 25 MB byte cap alone bounds nothing)
   runs BEFORE any pixel is decoded. Pillow's own bomb protection is set to
   the same number as the backstop for any path this check does not see.
   The real format comes from the bytes here, never from the declared
   content type (the intent allowlist is advisory — CK-34's record §2):
   a renamed .mov, a GIF, a TIFF, or random bytes all fail HERE, once,
   permanently.

2. TRANSPOSE FIRST, THEN STRIP. EXIF carries the orientation a phone wrote
   when it took the picture sideways; stripping it without applying it
   rotates every portrait photograph 90 degrees and looks like a UI bug
   rather than a pipeline one — the single most visible defect this phase
   could ship. `ImageOps.exif_transpose` applies the tag to the pixels;
   only then is the metadata dropped.

3. STRIP EVERYTHING — by never carrying it, not by editing it. Every
   rendition is re-encoded from pixel data with no `exif=`, no
   `icc_profile=`, no `xmp=` passed to the encoder (Pillow writes only what
   it is handed at save time — pinned by test against real fixtures, not
   a stub), and the decoded image's metadata dict is cleared before any
   rendition is made so nothing can be handed over by accident. GPS is
   the binding case (consent-and-compliance; pipeline record §9 — the
   Partiful failure), but the rule is ALL of it: an EXIF block "minus GPS"
   is a copied block, and a copied block is one edit from carrying the
   thing it was edited to remove. Colour is preserved in PIXEL space
   instead: an embedded ICC profile (an iPhone's Display P3) is converted
   to sRGB — the untagged web default — with littlecms, and then not
   embedded. A profile that will not parse is ignored (a slight colour
   shift beats a dead-lettered photograph).

4. RENDER archival from the transposed original, web from archival, and
   the thumbnail from web — each step from the previous, largest-first, so
   the 150 MB decode of a 50-megapixel original is resampled once and freed,
   not held through three resizes. The thumbnail walks a short quality
   ladder down to the ~30 KB target and stops at the first rung under it.

FAILURE IS PERMANENT. Everything this module raises is `Undecodable`: a
file that will not decode today will not decode on a retry, and pipeline
record §6.2 says a permanent failure fails on its first attempt rather than
burn the ladder — the worker dead-letters it at attempt 1, exactly as it
does a missing object. The reason is in operator terms (a format name, an
exception class, a limit) and never the file's contents (§6.5).

DATA-HANDLING: this is the code that makes the EXIF promise true. Nothing
here logs, and nothing here retains: the decoded original lives in this
function's frame and is dropped before it returns.
"""

from __future__ import annotations

import io
import warnings
from typing import NamedTuple

import pillow_heif
from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

from app.models import MediaLayer

# HEIC/HEIF decode through pillow-heif (the iPhone default; CK-36 record §0).
# Registering the opener is what lets Image.open recognise the container;
# it is idempotent and costs nothing when the bytes are not HEIF.
pillow_heif.register_heif_opener()

# The pixel guard (pipeline record §6.6): ~50 megapixels. Checked from the
# header before any pixel is decoded, and mirrored into Pillow's own
# decompression-bomb limit so its backstop trips at the same number (Pillow
# warns above MAX_IMAGE_PIXELS and raises above twice it — the explicit
# check below is the exact bound; Pillow's is the belt for any decoder path
# that reaches pixels some other way).
MAX_PIXELS = 50_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS

# What the worker will decode — the real-bytes counterpart of the intent
# endpoint's advisory allowlist (image/jpeg, png, webp, heic, heif). Pillow
# names the format from the bytes; pillow-heif reports HEIC and HEIF alike
# as "HEIF". Anything else is a permanent failure, by design: every format
# admitted is a decoder path this worker must carry, and none of GIF, TIFF
# or BMP is a photograph a family takes.
DECODABLE_FORMATS = frozenset({"JPEG", "PNG", "WEBP", "HEIF"})

# The layer targets (media-layers record §1) — long edge in pixels; never
# exceeded, never reached by upscaling.
ARCHIVAL_LONG_EDGE = 4000
ARCHIVAL_JPEG_QUALITY = 90
WEB_LONG_EDGE = 2560
WEB_WEBP_QUALITY = 82
THUMBNAIL_LONG_EDGE = 400
# ~30 KB (record §1): the encoder walks this ladder and stops at the first
# rung whose output fits; the last rung is taken regardless, because a
# thumbnail that exists at 34 KB beats a photograph with no thumbnail.
THUMBNAIL_TARGET_BYTES = 30_000
THUMBNAIL_QUALITY_LADDER = (80, 70, 60, 50, 40)

# The two storage classes, spelled the way R2 spells them on the wire (the
# `x-amz-storage-class` header) — recorded on the derivative row verbatim
# (record §4: archival on Infrequent Access; web and thumbnail on Standard;
# the schema keeps `storage_class` open text because R2's names may change,
# and the row records what was actually sent).
STORAGE_CLASS_STANDARD = "STANDARD"
STORAGE_CLASS_INFREQUENT_ACCESS = "STANDARD_IA"

CONTENT_TYPE_JPEG = "image/jpeg"
CONTENT_TYPE_WEBP = "image/webp"


class Undecodable(Exception):
    """A permanent failure: this upload is not a photograph this pipeline
    can process, and never will be on a retry. `reason` is operator terms
    only — a format, an exception class, a limit — never the file."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class Rendition(NamedTuple):
    """One rendered layer: the bytes to store and the facts the derivative
    row records about them."""

    layer: MediaLayer
    content_type: str
    storage_class: str
    data: bytes
    width: int
    height: int

    @property
    def size_bytes(self) -> int:
        return len(self.data)


def _fit_box(width: int, height: int, long_edge: int) -> tuple[int, int]:
    """The size after fitting the long edge to `long_edge` — or the size
    unchanged when it already fits (never upscale)."""
    longest = max(width, height)
    if longest <= long_edge:
        return width, height
    scale = long_edge / longest
    return max(1, round(width * scale)), max(1, round(height * scale))


def _fit(image: Image.Image, long_edge: int) -> Image.Image:
    target = _fit_box(image.width, image.height, long_edge)
    if target == image.size:
        return image
    return image.resize(target, Image.Resampling.LANCZOS)


def _flatten(image: Image.Image) -> Image.Image:
    """RGB pixels, whatever came in. Alpha is composited over white — a
    photograph has no transparency, and black is what a bare convert()
    would leave under a transparent PNG."""
    if image.mode == "RGB":
        return image
    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        flat = Image.new("RGB", rgba.size, (255, 255, 255))
        flat.paste(rgba, mask=rgba.getchannel("A"))
        return flat
    return image.convert("RGB")


def _to_srgb(image: Image.Image, icc_profile: bytes) -> Image.Image:
    """Convert pixels from an embedded profile to sRGB so the colour
    survives the profile's removal. A profile that will not parse is
    ignored: the image is kept as decoded."""
    try:
        source = ImageCms.ImageCmsProfile(io.BytesIO(icc_profile))
        return ImageCms.profileToProfile(image, source, ImageCms.createProfile("sRGB"), outputMode="RGB")
    except (ImageCms.PyCMSError, OSError, ValueError):
        return image


def _encode(image: Image.Image, fmt: str, **options) -> bytes:
    # NOTHING but pixels: no exif=, no icc_profile=, no xmp= — the encoder
    # writes only what it is handed here, and it is handed only the pixels.
    buffer = io.BytesIO()
    image.save(buffer, fmt, **options)
    return buffer.getvalue()


def _encode_thumbnail(image: Image.Image) -> bytes:
    data = b""
    for quality in THUMBNAIL_QUALITY_LADDER:
        data = _encode(image, "WEBP", quality=quality, method=4)
        if len(data) <= THUMBNAIL_TARGET_BYTES:
            break
    return data


def _open(data: bytes) -> Image.Image:
    """Step 1: the header, the format, the pixel guard — before any pixel."""
    try:
        with warnings.catch_warnings():
            # Between MAX_PIXELS and twice it Pillow only warns; the exact
            # check below raises for that band, so the warning is noise.
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(data))
    except Image.DecompressionBombError:
        raise Undecodable(f"larger than the {MAX_PIXELS // 1_000_000} megapixel limit") from None
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        raise Undecodable(f"not a decodable image ({exc.__class__.__name__})") from None
    fmt = image.format or "unknown"
    if fmt not in DECODABLE_FORMATS:
        raise Undecodable(f"{fmt} is not a supported photograph format")
    if image.width * image.height > MAX_PIXELS:
        raise Undecodable(f"larger than the {MAX_PIXELS // 1_000_000} megapixel limit")
    return image


def render_layers(data: bytes) -> tuple[Rendition, Rendition, Rendition]:
    """The three layers of one photograph, from its uploaded bytes — see the
    module docstring for the order and why. Raises Undecodable (permanent)
    for anything that is not a photograph this pipeline processes."""
    image = _open(data)

    # A JPEG can be decoded straight to a reduced size by the DCT (draft):
    # a 48-megapixel original bound for a 4000px archival layer never has
    # to exist at full size in memory. A no-op for every other format.
    image.draft("RGB", _fit_box(image.width, image.height, ARCHIVAL_LONG_EDGE))

    try:
        image.load()
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
        # A truncated or corrupt file: the header parsed, the pixels do not.
        raise Undecodable(f"not a decodable image ({exc.__class__.__name__})") from None

    # Step 2: orientation applied to the pixels while the tag still exists.
    try:
        ImageOps.exif_transpose(image, in_place=True)
    except Exception:  # noqa: BLE001 — an unreadable orientation block is not a reason to destroy a photograph
        pass

    # Step 3: the metadata goes now, before any rendition — the profile is
    # kept aside for the pixel-space conversion and never embedded.
    icc_profile = image.info.get("icc_profile")
    image.info.clear()

    # Step 4: largest first, each from the previous, the original freed.
    archival = _fit(_flatten(image), ARCHIVAL_LONG_EDGE)
    del image
    if icc_profile:
        archival = _to_srgb(archival, icc_profile)
    web = _fit(archival, WEB_LONG_EDGE)
    thumbnail = _fit(web, THUMBNAIL_LONG_EDGE)

    return (
        Rendition(
            MediaLayer.ARCHIVAL,
            CONTENT_TYPE_JPEG,
            STORAGE_CLASS_INFREQUENT_ACCESS,
            _encode(archival, "JPEG", quality=ARCHIVAL_JPEG_QUALITY),
            archival.width,
            archival.height,
        ),
        Rendition(
            MediaLayer.WEB,
            CONTENT_TYPE_WEBP,
            STORAGE_CLASS_STANDARD,
            _encode(web, "WEBP", quality=WEB_WEBP_QUALITY, method=4),
            web.width,
            web.height,
        ),
        Rendition(
            MediaLayer.THUMBNAIL,
            CONTENT_TYPE_WEBP,
            STORAGE_CLASS_STANDARD,
            _encode_thumbnail(thumbnail),
            thumbnail.width,
            thumbnail.height,
        ),
    )
