"""BGM 匯入的來源限制、成功切換與失敗保留行為。"""

import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))
import admin_bgm_import as bgm


class FakeSupabase:
    def __init__(self):
        self.row = {
            "id": 1, "import_id": "12345678-1234-4123-8123-123456789abc",
            "import_url": "https://www.youtube.com/watch?v=abcdefghijk",
            "import_status": "pending", "audio_path": "audio/old.mp3",
            "audio_name": "old.mp3", "source_url": "https://example.com/old",
        }
        self.objects = {"audio/old.mp3": b"old"}

    def record(self):
        return dict(self.row)

    def patch(self, import_id, status, values, extra_filter=""):
        if self.row["import_id"] != import_id or self.row["import_status"] != status:
            return False
        self.row.update(values)
        return True

    def upload(self, path, data):
        self.objects[path] = data

    def remove(self, path):
        self.objects.pop(path, None)


class BgmImportTests(unittest.TestCase):
    def test_only_supported_public_post_urls_are_accepted(self):
        valid = [
            "https://youtu.be/abcdefghijk?t=10",
            "https://www.instagram.com/reel/ABC_123/",
            "https://www.threads.com/share/_eVucClPD/",
        ]
        for value in valid:
            with self.subTest(value=value):
                self.assertTrue(bgm.validate_source_url(value)[0].startswith("https://"))
        invalid = [
            "http://www.youtube.com/watch?v=abcdefghijk",
            "https://www.youtube.com.evil.test/watch?v=abcdefghijk",
            "https://127.0.0.1/watch?v=abcdefghijk",
            "https://user@www.instagram.com/reel/ABC/",
            "https://www.threads.com:8443/share/ABC/",
        ]
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(bgm.ImportFailure):
                    bgm.validate_source_url(value)

    def test_instagram_reel_without_metadata_duration_reaches_media_probe(self):
        def run(command, **_kwargs):
            if command[1:3] == ["-m", "yt_dlp"]:
                filter_value = command[command.index("--match-filter") + 1]
                self.assertEqual(filter_value, f"duration <=? {bgm.MAX_SECONDS}")
                pathlib.Path(command[command.index("-o") + 1].replace("%(ext)s", "mp4")).write_bytes(b"source")
                return mock.Mock(stdout='{"title":"IG Reel"}\n', stderr="")
            if command[0] == "ffprobe":
                return mock.Mock(stdout='{"format":{"duration":"60"},"streams":[{"codec_type":"audio"}]}')
            if command[0] == "ffmpeg":
                pathlib.Path(command[-1]).write_bytes(b"converted")
                return mock.Mock()
            self.fail(f"unexpected command: {command[0]}")

        with tempfile.TemporaryDirectory() as folder, mock.patch.object(bgm.subprocess, "run", side_effect=run):
            destination = pathlib.Path(folder) / "output.mp3"
            name = bgm.download_and_convert("https://www.instagram.com/reel/Dcvf9-ONVRW/", destination)
            self.assertEqual(name, "IG Reel.mp3")
            self.assertEqual(destination.read_bytes(), b"converted")

    def test_failed_conversion_keeps_original_audio(self):
        api = FakeSupabase()
        with mock.patch.object(bgm, "download_and_convert", side_effect=bgm.ImportFailure("音軌不可用。")):
            result = bgm.run_once(api)
        self.assertEqual(result, "音軌不可用。")
        self.assertEqual(api.row["import_status"], "failed")
        self.assertEqual(api.row["audio_path"], "audio/old.mp3")
        self.assertEqual(api.objects["audio/old.mp3"], b"old")

    def test_success_switches_then_removes_old_audio(self):
        api = FakeSupabase()

        def convert(url, destination):
            destination.write_bytes(b"new")
            return "new.mp3"

        with mock.patch.object(bgm, "download_and_convert", side_effect=convert):
            result = bgm.run_once(api)
        self.assertEqual(result, "BGM 匯入完成")
        self.assertEqual(api.row["import_status"], "done")
        self.assertEqual(api.objects[api.row["audio_path"]], b"new")
        self.assertNotIn("audio/old.mp3", api.objects)

    def test_replaced_import_cannot_switch_audio(self):
        api = FakeSupabase()

        def convert(url, destination):
            destination.write_bytes(b"new")
            return "new.mp3"

        def upload(path, data):
            api.objects[path] = data
            api.row["import_id"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            api.row["import_status"] = "pending"

        api.upload = upload
        with mock.patch.object(bgm, "download_and_convert", side_effect=convert):
            result = bgm.run_once(api)
        self.assertEqual(result, "工作已被新的管理員操作取代")
        self.assertEqual(api.row["audio_path"], "audio/old.mp3")
        self.assertEqual(api.objects, {"audio/old.mp3": b"old"})


if __name__ == "__main__":
    unittest.main()
