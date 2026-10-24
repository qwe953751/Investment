#!/usr/bin/env python3
"""僅在隔離 bare clone 清除 device_sessions 歷史資料並完整加密 SQL 快照。

不執行 push。重寫後逐 commit 核對 snapshots 以外的 tree object 完全相同。
需要 git-filter-repo 2.47+；原始 bare clone 必須保留在受限的 repository 外位置。
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import shutil


def sanitize_sql(data):
    lines = data.splitlines(keepends=True)
    result, copying, removed = [], False, 0
    for line in lines:
        if re.match(rb'^INSERT INTO (?:public\.)?"?device_sessions"?\b', line, re.I):
            raise ValueError('unexpected INSERT format; refuse automatic rewrite')
        if copying:
            if line.rstrip(b'\r\n') == b'\\.':
                result.append(line)
                copying = False
            else:
                removed += 1
        else:
            result.append(line)
            if re.match(rb'^COPY public\.device_sessions \(.*\) FROM stdin;\r?\n?$', line):
                copying = True
    if copying:
        raise ValueError('incomplete device_sessions COPY')
    return b''.join(result), removed


def sanitize_gzip(data):
    if not data.startswith(b'\x1f\x8b'):
        return data, 0
    plain = gzip.decompress(data)
    if b'PostgreSQL database dump' not in plain[:128]:
        return data, 0
    cleaned, removed = sanitize_sql(plain)
    return (gzip.compress(cleaned, compresslevel=9, mtime=0), removed) if removed else (data, 0)


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])


class Objects:
    def __init__(self, repo):
        self.proc = subprocess.Popen(['git', '-C', str(repo), 'cat-file', '--batch'],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.trees = {}

    def get(self, oid):
        self.proc.stdin.write(oid + b'\n')
        self.proc.stdin.flush()
        header = self.proc.stdout.readline().split()
        if len(header) != 3:
            raise ValueError('missing Git object')
        body = self.proc.stdout.read(int(header[2]))
        if self.proc.stdout.read(1) != b'\n':
            raise ValueError('invalid Git object boundary')
        return body

    def tree_without_snapshots(self, commit):
        tree = self.get(commit).split(b'\n', 1)[0].split()[1]
        if tree in self.trees:
            return self.trees[tree]
        raw = self.get(tree)
        entries = {}
        while raw:
            mode_name, raw = raw.split(b'\0', 1)
            mode, name = mode_name.split(b' ', 1)
            oid, raw = raw[:20], raw[20:]
            if name != b'snapshots':
                entries[name] = (mode, oid)
        self.trees[tree] = entries
        return entries

    def close(self):
        self.proc.stdin.close()
        self.proc.wait()


def cms(data, *, certificate=None, key=None):
    executable = os.environ.get('OPENSSL') or ('/opt/homebrew/opt/openssl@3/bin/openssl'
        if Path('/opt/homebrew/opt/openssl@3/bin/openssl').is_file() else shutil.which('openssl'))
    command = [executable, 'cms', '-binary']
    if certificate:
        command += ['-encrypt', '-aes-256-gcm', '-outform', 'DER', str(certificate)]
    else:
        command += ['-decrypt', '-inform', 'DER', '-inkey', str(key)]
    result = subprocess.run(command, input=data, capture_output=True)
    if result.returncode:
        raise ValueError('historical backup encryption/decryption failed; data suppressed')
    return result.stdout


def verify(original, cleaned, key, expected):
    mapping = (cleaned / 'filter-repo/commit-map').read_bytes().splitlines()[1:]
    old, new = Objects(original), Objects(cleaned)
    checked = 0
    try:
        for line in mapping:
            before, after = line.split()
            if after == b'0' * 40:
                raise ValueError('a historical commit was deleted')
            if old.tree_without_snapshots(before) != new.tree_without_snapshots(after):
                raise ValueError('non-snapshot historical tree changed')
            checked += 1
        blobs = {}
        for line in git(cleaned, 'rev-list', '--objects', 'refs/heads/data').splitlines():
            parts = line.split(b' ', 1)
            if len(parts) == 2 and re.fullmatch(rb'snapshots/\d{4}-\d{2}-\d{2}\.sql\.gz(?:\.cms)?', parts[1]):
                if not parts[1].endswith(b'.cms'):
                    raise ValueError('plaintext historical snapshot remains reachable')
                blobs[parts[0]] = parts[1]
        for oid in blobs:
            encrypted = new.get(oid)
            plain_gzip = cms(encrypted, key=key)
            _, remaining = sanitize_gzip(plain_gzip)
            if remaining:
                raise ValueError('device_sessions rows remain reachable')
            if hashlib.sha256(gzip.decompress(plain_gzip)).hexdigest() != expected[hashlib.sha256(encrypted).hexdigest()]:
                raise ValueError('non-device historical SQL data changed')
        return dict(commitsVerified=checked, snapshotBlobsVerified=len(blobs),
                    nonSnapshotTreesUnchanged=True, nonDeviceSqlPreserved=True,
                    remainingDeviceRows=0, plaintextSnapshots=0)
    finally:
        old.close()
        new.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--original', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--certificate', type=Path, required=True)
    parser.add_argument('--key', type=Path, required=True)
    args = parser.parse_args()
    cleaned, original = args.repo.resolve(), args.original.resolve()
    if cleaned == original or cleaned.name != 'data-history-clean.git':
        parser.error('use a separate data-history-clean.git bare clone')
    for repo in (cleaned, original):
        if git(repo, 'rev-parse', '--is-bare-repository').strip() != b'true':
            parser.error('both repositories must be isolated bare clones')
        if git(repo, 'for-each-ref', '--format=%(refname)').splitlines() != [b'refs/heads/data']:
            parser.error('isolated clones must contain only refs/heads/data')
    before = git(original, 'rev-parse', 'refs/heads/data').decode().strip()
    if git(cleaned, 'rev-parse', 'refs/heads/data').decode().strip() != before:
        parser.error('original and clean clones must start at the same data HEAD')
    import git_filter_repo as filtering
    stats = dict(changedSnapshotBlobs=0, removedDeviceRowsAcrossBlobs=0, encryptedSnapshotBlobs=0)
    expected = {}

    def callback(blob, _metadata):
        if not blob.data.startswith(b'\x1f\x8b'):
            return
        if b'PostgreSQL database dump' not in gzip.decompress(blob.data)[:128]:
            return
        replacement, removed = sanitize_gzip(blob.data)
        if removed:
            stats['changedSnapshotBlobs'] += 1
            stats['removedDeviceRowsAcrossBlobs'] += removed
        blob.data = cms(replacement, certificate=args.certificate)
        expected[hashlib.sha256(blob.data).hexdigest()] = hashlib.sha256(gzip.decompress(replacement)).hexdigest()
        stats['encryptedSnapshotBlobs'] += 1

    def rename(commit, _metadata):
        for change in commit.file_changes:
            if re.fullmatch(rb'snapshots/\d{4}-\d{2}-\d{2}\.sql\.gz', change.filename):
                change.filename += b'.cms'

    os.chdir(cleaned)
    options = filtering.FilteringOptions.parse_args([
        '--force', '--refs', 'refs/heads/data', '--prune-empty', 'never', '--prune-degenerate', 'never'])
    filtering.RepoFilter(options, blob_callback=callback, commit_callback=rename).run()
    report = dict(originalHead=before, cleanedHead=git(cleaned, 'rev-parse', 'refs/heads/data').decode().strip(),
                  **stats, **verify(original, cleaned, args.key, expected))
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
