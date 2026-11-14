#!/usr/bin/env python3
"""GAERU media protocol: Python 3.5+, fixed root, no overwrite or deletion."""
import base64
import errno
import hashlib
import json
import os
import re
import stat
import sys
import uuid

MEDIA_ROOT = '/userdata/storage/ubuntu/storage/apps/gaeru/media'
MAX_FILE_BYTES = 128 * 1024 * 1024
NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)


def key_parts(key):
    if not isinstance(key, str) or not key or key.startswith('/') or re.search(r'[\\\x00-\x1f:*?"<>|]', key):
        raise ValueError('invalid_media_key')
    parts = key.split('/')
    for part in parts:
        if (not part or part in ('.', '..') or part.lower() == '.gaeru-storage-check' or part.endswith(('.', ' ')) or
                part.startswith('.gaeru-sync-') or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', part, re.I)):
            raise ValueError('invalid_media_key')
    return parts


def open_parent(key, create=False):
    parts = key_parts(key)
    parent = os.open(MEDIA_ROOT, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
    try:
        for part in parts[:-1]:
            if create:
                try:
                    os.mkdir(part, 0o755, dir_fd=parent)
                    owner = os.fstat(parent)
                    os.chown(part, owner.st_uid, owner.st_gid, dir_fd=parent, follow_symlinks=False)
                except OSError as error:
                    if error.errno != errno.EEXIST:
                        raise
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
        return parent, parts[-1]
    except Exception:
        os.close(parent)
        raise


def read_file(key, include_data=False):
    parent, name = open_parent(key)
    try:
        descriptor = os.open(name, os.O_RDONLY | NOFOLLOW, dir_fd=parent)
    finally:
        os.close(parent)
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_FILE_BYTES:
            raise ValueError('unsupported_media_file')
        digest = hashlib.sha256()
        chunks = []
        total = 0
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_FILE_BYTES:
                raise ValueError('media_too_large')
            digest.update(chunk)
            if include_data:
                chunks.append(chunk)
        after = os.fstat(stream.fileno())
        if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns or total != after.st_size:
            raise ValueError('media_changed_during_read')
    result = {'size': total, 'sha256': digest.hexdigest()}
    if include_data:
        result['data'] = base64.b64encode(b''.join(chunks)).decode('ascii')
    return result


def inventory():
    files, errors = {}, []
    for directory, directories, names in os.walk(MEDIA_ROOT, followlinks=False):
        directories[:] = [name for name in directories if name.lower() != '.gaeru-storage-check' and not name.startswith('.gaeru-sync-') and not os.path.islink(os.path.join(directory, name))]
        for name in names:
            if name.startswith('.gaeru-sync-') or name.lower() == '.gaeru-storage-check':
                continue
            key = os.path.relpath(os.path.join(directory, name), MEDIA_ROOT).replace(os.sep, '/')
            try:
                files[key] = read_file(key)
            except Exception:
                errors.append(key)
    return {'ok': True, 'files': files, 'errors': errors}


def put_file(request):
    if request.get('expectedMissing') is not True:
        raise ValueError('missing_create_only_precondition')
    data = base64.b64decode(request['data'].encode('ascii'), validate=True)
    if len(data) > MAX_FILE_BYTES or len(data) != request['size'] or hashlib.sha256(data).hexdigest() != request['sha256']:
        raise ValueError('media_hash_mismatch')
    parent, name = open_parent(request['key'], create=True)
    temporary = '.gaeru-sync-' + uuid.uuid4().hex + '.partial'
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o644, dir_fd=parent)
        with os.fdopen(descriptor, 'wb') as stream:
            owner = os.fstat(parent)
            os.fchown(stream.fileno(), owner.st_uid, owner.st_gid)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            # Hard-link creation is atomic and fails if the destination appears meanwhile.
            os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        except OSError as error:
            if error.errno != errno.EEXIST:
                raise
            try:
                current = read_file(request['key'])
                status = 'already_present' if current['sha256'] == request['sha256'] else 'conflict'
            except Exception:
                status = 'conflict'
            return {'ok': True, 'status': status}
        os.fsync(parent)
        verified = read_file(request['key'])
        if verified['sha256'] != request['sha256'] or verified['size'] != request['size']:
            raise ValueError('media_changed_after_copy')
        return {'ok': True, 'status': 'copied'}
    finally:
        try:
            os.unlink(temporary, dir_fd=parent)
        except OSError:
            pass
        os.close(parent)


def dispatch(request):
    action = request.get('action')
    if action == 'inventory':
        if not os.path.isdir(MEDIA_ROOT) or os.path.islink(MEDIA_ROOT):
            raise ValueError('media_root_unavailable')
        return inventory()
    if action == 'get':
        result = read_file(request['key'], include_data=True)
        if result['sha256'] != request['sha256'] or result['size'] != request['size']:
            raise ValueError('media_changed_since_inventory')
        result['ok'] = True
        return result
    if action == 'put':
        return put_file(request)
    raise ValueError('unsupported_action')


if __name__ == '__main__':
    try:
        raw = sys.stdin.read(int(MAX_FILE_BYTES * 1.4) + 1024 * 1024)
        result = dispatch(json.loads(raw))
    except Exception:
        result = {'ok': False, 'error': 'media_request_failed'}
    sys.stdout.write(json.dumps(result, ensure_ascii=True))
    sys.stdout.write('\n')
