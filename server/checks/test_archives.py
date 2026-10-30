"""Tiny deliverable fixtures only; no models or business pipeline."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from src.archives import build_archive


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.id = '12345678-1234-1234-1234-123456789abc'
        self.directory = self.root / 'outputs' / 'runs' / self.id
        self.final = self.directory / 'final'
        (self.final / 'requirements' / '需求' / 'assets').mkdir(parents=True)
        (self.final / 'requirements' / 'final.md').write_text('# 汇总', encoding='utf-8')
        (self.final / 'requirements' / '需求' / '章节.md').write_text('![图片](assets/图.png)', encoding='utf-8')
        (self.final / 'requirements' / '需求' / 'assets' / '图.png').write_bytes(b'tiny image fixture')
        (self.final / 'result.json').write_text('{}')
        (self.directory / 'intermediate').mkdir()
        (self.directory / 'intermediate' / 'private.json').write_text('model trace retained')
        for name in ('input', 'snapshots', 'logs'):
            (self.directory / name).mkdir()
        (self.directory / 'input' / 'request.json').write_text(json.dumps({
            'toolId': 'split_requirement_document', 'input': {'text': 'tiny'}}), encoding='utf-8')
        self.request = {'runId': self.id, 'runDirectory': str(self.directory)}

    def test_zip_preserves_unicode_paths_images_and_reports_without_traces(self):
        original = (self.directory / 'input' / 'request.json').read_bytes()
        self.assertEqual(build_archive(self.request)['path'], 'final/requirements.zip')
        with ZipFile(self.final / 'requirements.zip') as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(len(archive.namelist()), 4)
            self.assertEqual(archive.read('requirements/需求/assets/图.png'), b'tiny image fixture')
            self.assertEqual(archive.read('requirements/需求/章节.md').decode(), '![图片](assets/图.png)')
            self.assertNotIn('requirements.zip', archive.namelist())
        self.assertEqual((self.directory / 'input' / 'request.json').read_bytes(), original)
        self.assertEqual((self.directory / 'intermediate' / 'private.json').read_text(), 'model trace retained')

    def test_repeated_packaging_reuses_original_archive(self):
        build_archive(self.request)
        destination = self.final / 'requirements.zip'
        before = destination.stat().st_mtime_ns, destination.read_bytes()
        (self.final / 'requirements' / 'final.md').write_text('later edit')
        build_archive(self.request)
        self.assertEqual((destination.stat().st_mtime_ns, destination.read_bytes()), before)

    def test_invalid_run_and_directory_are_rejected(self):
        for change in ({'runId': '../outside'}, {'runDirectory': str(self.final)}):
            with self.assertRaises((ValueError, FileNotFoundError)):
                build_archive({**self.request, **change})
        self.assertFalse((self.final / 'requirements.zip').exists())

    def test_missing_markdown_is_not_reported_as_a_deliverable(self):
        for path in self.final.rglob('*.md'):
            path.unlink()
        with self.assertRaisesRegex(ValueError, 'No final Markdown'):
            build_archive(self.request)
        self.assertFalse((self.final / 'requirements.zip').exists())

    def test_symlink_is_rejected_without_copying_external_data(self):
        target = self.root / 'external.txt'
        target.write_text('outside')
        try:
            (self.final / 'link.txt').symlink_to(target)
        except OSError as exc:
            self.skipTest(f'Host does not allow file symlinks: {exc}')
        with self.assertRaisesRegex(ValueError, 'link'):
            build_archive(self.request)
        self.assertFalse((self.final / 'requirements.zip').exists())

    def test_directory_link_is_rejected_before_traversal(self):
        target = self.root / 'external'
        target.mkdir()
        (target / 'secret.md').write_text('outside')
        link = self.final / 'external'
        if os.name == 'nt':
            import _winapi
            _winapi.CreateJunction(str(target), str(link))
        else:
            link.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'link'):
            build_archive(self.request)
        self.assertFalse((self.final / 'requirements.zip').exists())
