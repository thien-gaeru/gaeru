"""Run with Python 3.5+; all fixtures are temporary, never the production root."""
import base64
import hashlib
import importlib.util
import os
import shutil
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('media_receiver', os.path.join(os.path.dirname(__file__), '..', 'scripts', 'gaeru-media-sync.py'))
receiver = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(receiver)


def payload(key, data):
    return {'action': 'put', 'key': key, 'expectedMissing': True, 'data': base64.b64encode(data).decode('ascii'),
            'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


class MediaProtocolTests(unittest.TestCase):
    def test_rejects_traversal_and_platform_escape_names(self):
        for key in ('../outside', '/absolute', 'a/../outside', 'a\\outside', 'C:outside', 'a//b', 'NUL.txt',
                    '.gaeru-storage-check', 'nested/.gaeru-storage-check', '.gaeru-storage-check/child.bin'):
            with self.assertRaises(ValueError):
                receiver.key_parts(key)

    def test_checksum_failure_precedes_any_filesystem_write(self):
        request = payload('bad.bin', b'bytes')
        request['sha256'] = '0' * 64
        with self.assertRaises(ValueError):
            receiver.dispatch(request)

    def test_overwrite_requests_are_rejected(self):
        request = payload('existing.bin', b'bytes')
        request['expectedMissing'] = False
        with self.assertRaises(ValueError):
            receiver.dispatch(request)

    def test_identity_is_rejected_by_get_and_put_before_opening_files(self):
        for key in ('.gaeru-storage-check', 'nested/.gaeru-storage-check', '.gaeru-storage-check/child.bin', '.GAERU-STORAGE-CHECK'):
            request = payload(key, b'identity')
            with self.assertRaises(ValueError):
                receiver.dispatch(request)
            request['action'] = 'get'
            with self.assertRaises(ValueError):
                receiver.dispatch(request)


@unittest.skipUnless(os.name == 'posix', 'descriptor-relative filesystem operations require POSIX')
class MediaFilesystemTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='gaeru-media-helper-test-')
        self.previous = receiver.MEDIA_ROOT
        receiver.MEDIA_ROOT = self.root

    def tearDown(self):
        receiver.MEDIA_ROOT = self.previous
        shutil.rmtree(self.root)

    def test_put_get_inventory_and_existing_conflict(self):
        request = payload('nested/test.bin', b'original')
        self.assertEqual(receiver.dispatch(request)['status'], 'copied')
        self.assertEqual(receiver.dispatch(request)['status'], 'already_present')
        self.assertEqual(receiver.dispatch(payload('nested/test.bin', b'changed'))['status'], 'conflict')
        item = receiver.dispatch({'action': 'inventory'})['files']['nested/test.bin']
        result = receiver.dispatch(dict(item, action='get', key='nested/test.bin'))
        self.assertEqual(base64.b64decode(result['data']), b'original')
        self.assertEqual(os.listdir(os.path.join(self.root, 'nested')), ['test.bin'])

    def test_symlink_destination_cannot_escape_root(self):
        outside = tempfile.mkdtemp(prefix='gaeru-media-outside-test-')
        try:
            os.symlink(outside, os.path.join(self.root, 'escape'))
            with self.assertRaises(OSError):
                receiver.dispatch(payload('escape/unsafe.bin', b'unsafe'))
            self.assertEqual(os.listdir(outside), [])
        finally:
            shutil.rmtree(outside)

    def test_changed_source_does_not_satisfy_previous_hash(self):
        request = payload('changed.bin', b'old')
        receiver.dispatch(request)
        with open(os.path.join(self.root, 'changed.bin'), 'wb') as stream:
            stream.write(b'new')
        with self.assertRaises(ValueError):
            receiver.dispatch({'action': 'get', 'key': 'changed.bin', 'size': request['size'], 'sha256': request['sha256']})

    def test_inventory_excludes_node_identity_at_all_depths(self):
        os.mkdir(os.path.join(self.root, 'nested'))
        for key in ('.gaeru-storage-check', 'nested/.gaeru-storage-check'):
            with open(os.path.join(self.root, key), 'wb') as stream:
                stream.write(b'node-specific identity')
        inventory = receiver.dispatch({'action': 'inventory'})
        self.assertEqual(inventory['files'], {})
        self.assertEqual(inventory['errors'], [])


if __name__ == '__main__':
    unittest.main()
