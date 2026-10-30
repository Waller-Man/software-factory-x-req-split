"""Package final deliverables without rerunning conversion, OCR or models."""
from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4
from zipfile import ZIP_DEFLATED, ZipFile
from .tasks import validate_run_directory


def _plain(path: Path) -> Path:
    if not path.is_absolute() or path.is_symlink() or path.resolve(strict=True) != path.absolute():
        raise ValueError('Archive path contains a link')
    return path


def build_archive(data: dict) -> dict:
    directory = validate_run_directory(data['runId'], data['runDirectory'])
    final = _plain(directory / 'final')
    destination = final / 'requirements.zip'
    if destination.exists():
        _plain(destination)
        with ZipFile(destination) as archive:
            if archive.testzip() is not None:
                raise ValueError('Existing archive is damaged; original retained')
        return {'path': 'final/requirements.zip'}
    # Check every directory as well as files, refusing links before traversal.
    files = []
    def visit(folder):
        for path in sorted(folder.iterdir()):
            _plain(path)
            if path.is_dir():
                visit(path)
            elif path.is_file() and path != destination and not path.name.endswith('.tmp'):
                files.append(path)
    visit(final)
    if not any(path.suffix.lower() == '.md' for path in files):
        raise ValueError('No final Markdown deliverable to package')
    temporary = final / f'.requirements-{uuid4()}.zip.tmp'
    try:
        with ZipFile(temporary, 'x', compression=ZIP_DEFLATED, allowZip64=True) as archive:
            for path in files:
                _plain(path)
                archive.write(path, path.relative_to(final).as_posix())
        # Publish exclusively: never replace a historical result, even on Unix.
        os.link(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return {'path': 'final/requirements.zip'}
