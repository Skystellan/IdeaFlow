"""Images pasted into node notes, stored beside the research database.

Notes refer to them in Markdown as `assets/NAME`, relative to the store directory, so
agents reading a node's body can open the same file. Names are content hashes: saving the
same image twice keeps one file, and a stored file never changes.
"""
from __future__ import annotations

import hashlib
import os
import re
import tempfile
from pathlib import Path

LIMIT = 20 * 1024 * 1024
# SVG is excluded: it can carry scripts and would run in the app's origin if opened directly.
TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}
MIME = {extension: mime for mime, extension in TYPES.items()}
NAME = re.compile(r"[0-9a-f]{24}\.(?:png|jpg|gif|webp)")


def _matches(data, mime):
    if mime == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if mime == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if mime == "image/gif":
        return data[:6] in (b"GIF87a", b"GIF89a")
    return data[:4] == b"RIFF" and data[8:12] == b"WEBP"


def _directory(store_path):
    directory = Path(store_path) / "assets"
    if directory.is_symlink():
        raise ValueError("The assets directory must not be a symlink")
    return directory


def save(store_path, data, mime):
    if mime not in TYPES:
        raise ValueError("Images must be PNG, JPEG, GIF or WebP")
    if not data or len(data) > LIMIT:
        raise ValueError(f"Images must be 1 byte to {LIMIT // (1024 * 1024)} MiB")
    if not _matches(data, mime):
        raise ValueError("The file content does not match its image type")
    name = hashlib.sha256(data).hexdigest()[:24] + TYPES[mime]
    directory = _directory(store_path)
    directory.mkdir(mode=0o700, exist_ok=True)
    target = directory / name
    if not target.exists():
        handle, temporary = tempfile.mkstemp(dir=directory, prefix=".upload-")
        try:
            with os.fdopen(handle, "wb") as file:
                file.write(data)
            os.replace(temporary, target)
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise
    return {"name": name, "path": f"assets/{name}"}


def read(store_path, name):
    """Return (bytes, mime). Invalid names raise ValueError; a missing file raises FileNotFoundError."""
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise ValueError("Unknown image")
    path = _directory(store_path) / name
    if path.is_symlink():
        raise ValueError("Images must not be symlinks")
    return path.read_bytes(), MIME[path.suffix]
