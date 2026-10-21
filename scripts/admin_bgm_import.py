"""GitHub Actions 的單筆 BGM 匯入工作；只處理管理員已排入的公開貼文。"""

from __future__ import annotations

import datetime as dt
import html
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

MAX_AUDIO_BYTES = 20 * 1024 * 1024
MAX_SOURCE_BYTES = 100 * 1024 * 1024
MAX_SECONDS = 15 * 60
BUCKET = "admin-bgm"


class ImportFailure(Exception):
    pass


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def validate_source_url(value: str) -> tuple[str, str]:
    """Return a canonical URL and platform; reject arbitrary worker egress."""
    if not isinstance(value, str) or len(value) > 2048:
        raise ImportFailure("連結過長或格式無效。")
    try:
        url = urllib.parse.urlsplit(value.strip())
        host = (url.hostname or "").lower()
        if url.scheme != "https" or url.username or url.password or url.port or url.fragment:
            raise ValueError()
    except ValueError as exc:
        raise ImportFailure("只接受公開平台的 HTTPS 貼文連結。") from exc

    path = url.path.rstrip("/")
    if host in {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}:
        if path == "/watch":
            video_id = urllib.parse.parse_qs(url.query).get("v", [""])[0]
        else:
            match = re.fullmatch(r"/(?:shorts|live|embed)/([A-Za-z0-9_-]{11})", path)
            video_id = match.group(1) if match else ""
        if re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            return f"https://www.youtube.com/watch?v={video_id}", "YouTube"
    elif host in {"youtu.be", "www.youtu.be"}:
        if re.fullmatch(r"/[A-Za-z0-9_-]{11}", path):
            return f"https://www.youtube.com/watch?v={path[1:]}", "YouTube"
    elif host in {"instagram.com", "www.instagram.com"}:
        if re.fullmatch(r"/(?:p|reel|tv)/[A-Za-z0-9_-]+", path):
            return f"https://www.instagram.com{path}/", "Instagram"
    elif host in {"threads.com", "www.threads.com", "threads.net", "www.threads.net"}:
        if re.fullmatch(r"/(?:@[A-Za-z0-9._]+/post|t|share)/[A-Za-z0-9_-]+", path):
            return f"https://www.threads.com{path}/", "Threads"
    raise ImportFailure("只支援 YouTube 影片、Instagram 貼文／Reels 與 Threads 貼文連結。")


class ThreadsRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        if parsed.scheme != "https" or (parsed.hostname or "").lower() not in {
            "threads.com", "www.threads.com", "threads.net", "www.threads.net"
        }:
            raise ImportFailure("Threads 短連結轉址到非 Threads 網站。")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def resolve_threads_share(url: str) -> str:
    if "/share/" not in urllib.parse.urlsplit(url).path:
        return url
    opener = urllib.request.build_opener(ThreadsRedirect)
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with opener.open(request, timeout=20) as response:
            final_url = response.geturl()
            page = response.read(1024 * 1024).decode("utf-8", "replace")
    except (OSError, urllib.error.URLError) as exc:
        raise ImportFailure("Threads 短連結無法展開。") from exc

    if re.fullmatch(r"/@[A-Za-z0-9._]+/post/[A-Za-z0-9_-]+/?", urllib.parse.urlsplit(final_url).path):
        return validate_source_url(final_url.split("?", 1)[0])[0]
    for pattern in (
        r'<meta[^>]+property=["\']og:url["\'][^>]+content=["\']([^"\']+)',
        r'<link[^>]+rel=["\']canonical["\'][^>]+href=["\']([^"\']+)',
    ):
        match = re.search(pattern, page, re.IGNORECASE)
        if match:
            candidate = html.unescape(match.group(1)).split("?", 1)[0]
            if re.fullmatch(r"/@[A-Za-z0-9._]+/post/[A-Za-z0-9_-]+/?", urllib.parse.urlsplit(candidate).path):
                return validate_source_url(candidate)[0]
    raise ImportFailure("Threads 短連結沒有提供可驗證的原始貼文網址。")


class Supabase:
    def __init__(self):
        self.url = os.environ["SUPABASE_URL"].rstrip("/")
        self.key = os.environ["SUPABASE_STORAGE_SECRET_KEY"]
        if not self.url.startswith("https://") or not self.key:
            raise RuntimeError("缺少 Supabase 工作程序設定")

    def request(self, method: str, path: str, body=None, content_type="application/json", prefer=None):
        # sb_secret_ 是 API key，不是 JWT；Bearer 會讓 Supabase 回 Invalid JWT。
        headers = {"apikey": self.key}
        if body is not None:
            headers["Content-Type"] = content_type
            if not isinstance(body, bytes):
                body = json.dumps(body).encode("utf-8")
        if prefer:
            headers["Prefer"] = prefer
        request = urllib.request.Request(self.url + path, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"Supabase {method} HTTP {exc.code}") from exc

    def record(self):
        rows = json.loads(self.request("GET", "/rest/v1/admin_bgm?id=eq.1&select=*"))
        return rows[0] if rows else None

    def patch(self, import_id: str, status: str, values: dict, extra_filter: str = "") -> bool:
        query = f"id=eq.1&import_id=eq.{urllib.parse.quote(import_id)}&import_status=eq.{status}{extra_filter}&select=id"
        rows = json.loads(self.request("PATCH", f"/rest/v1/admin_bgm?{query}", values, prefer="return=representation"))
        return len(rows) == 1

    def upload(self, path: str, data: bytes):
        self.request("POST", f"/storage/v1/object/{BUCKET}/{path}", data, "audio/mpeg")
        stored = self.request("GET", f"/storage/v1/object/authenticated/{BUCKET}/{path}")
        if stored != data:
            raise RuntimeError("上傳後音檔驗證不一致")

    def remove(self, path: str):
        self.request("DELETE", f"/storage/v1/object/{BUCKET}", {"prefixes": [path]})


def download_and_convert(url: str, destination: pathlib.Path) -> str:
    with tempfile.TemporaryDirectory(prefix="bgm-import-") as folder:
        work = pathlib.Path(folder)
        command = [
            sys.executable, "-m", "yt_dlp", "--no-config", "--no-playlist",
            "--playlist-items", "1",
            # Instagram Reels can omit duration metadata; ffprobe validates the actual file below.
            "--max-filesize", str(MAX_SOURCE_BYTES), "--match-filter", f"duration <=? {MAX_SECONDS}",
            "--socket-timeout", "15", "--retries", "2", "--fragment-retries", "2",
            "--no-simulate", "--print-json", "-o", str(work / "source.%(ext)s"), url,
        ]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=240, check=True)
        except subprocess.CalledProcessError as exc:
            detail = re.sub(r"https?://\S+", "[URL]", (exc.stderr or "").strip().splitlines()[-1] if exc.stderr else "")
            print(f"yt-dlp exit {exc.returncode}: {detail[:300]}", file=sys.stderr)
            raise ImportFailure("來源影片無法擷取、無法公開讀取，或超過 15 分鐘／100 MB。") from exc
        except subprocess.TimeoutExpired as exc:
            raise ImportFailure("來源影片無法擷取、無法公開讀取，或超過 15 分鐘／100 MB。") from exc
        sources = [p for p in work.glob("source.*") if p.is_file() and p.suffix not in {".part", ".json"}]
        if len(sources) != 1 or sources[0].stat().st_size > MAX_SOURCE_BYTES:
            hints = [line for line in (result.stderr + "\n" + result.stdout).splitlines()
                     if "does not pass filter" in line or "WARNING:" in line]
            hint = re.sub(r"https?://\S+", "[URL]", hints[-1])[:300] if hints else "no extractor hint"
            print(f"yt-dlp produced {len(sources)} source files: {hint}", file=sys.stderr)
            raise ImportFailure("沒有取得單一可用影片，或來源超過 100 MB。")
        metadata = next((json.loads(line) for line in reversed(result.stdout.splitlines()) if line.startswith("{")), {})
        try:
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries",
                 "format=duration:stream=codec_type", "-of", "json", str(sources[0])],
                capture_output=True, text=True, timeout=30, check=True)
            details = json.loads(probe.stdout)
            duration = float(details.get("format", {}).get("duration", 0))
            if not any(stream.get("codec_type") == "audio" for stream in details.get("streams", [])):
                raise ImportFailure("影片沒有音軌，無法作為 BGM。")
            if duration <= 0 or duration > MAX_SECONDS:
                raise ImportFailure("影片時長需介於 1 秒與 15 分鐘之間。")
            subprocess.run(
                ["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
                 "-i", str(sources[0]), "-map", "0:a:0", "-vn", "-c:a", "libmp3lame",
                 "-b:a", "128k", "-ar", "44100", "-ac", "2", "-y", str(destination)],
                capture_output=True, text=True, timeout=120, check=True)
        except ImportFailure:
            raise
        except (OSError, ValueError, json.JSONDecodeError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise ImportFailure("音軌檢查或 MP3 轉檔失敗。") from exc
        if not destination.is_file() or not 0 < destination.stat().st_size <= MAX_AUDIO_BYTES:
            raise ImportFailure("轉檔後音檔為空或超過 20 MB。")
        title = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(metadata.get("title") or "BGM")).strip(" ._")[:100]
        return f"{title or 'BGM'}.mp3"


def is_due(record: dict | None) -> bool:
    if not record:
        return False
    if record.get("import_status") == "pending":
        return True
    if record.get("import_status") != "processing":
        return False
    started = dt.datetime.fromisoformat(record["import_started_at"].replace("Z", "+00:00")) if record.get("import_started_at") else dt.datetime.min.replace(tzinfo=dt.timezone.utc)
    return dt.datetime.now(dt.timezone.utc) - started >= dt.timedelta(minutes=20)


def run_once(api: Supabase) -> str:
    record = api.record()
    if not is_due(record):
        return "沒有待處理工作"
    import_id = record["import_id"]
    status = record["import_status"]
    if status == "processing":
        cutoff = urllib.parse.quote((dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=20)).isoformat(), safe="")
        extra = f"&import_started_at=lt.{cutoff}"
    else:
        extra = ""
    if not api.patch(import_id, status, {"import_status": "processing", "import_started_at": now(), "import_error": None}, extra):
        return "工作已由其他執行緒接手"

    path = f"audio/{import_id}.mp3"
    uploaded = False
    switched = False
    try:
        if status == "processing":
            try:
                api.remove(path)
            except RuntimeError:
                pass
        url, platform = validate_source_url(record["import_url"])
        if platform == "Threads":
            url = resolve_threads_share(url)
        with tempfile.TemporaryDirectory(prefix="bgm-output-") as folder:
            output = pathlib.Path(folder) / "bgm.mp3"
            name = download_and_convert(url, output)
            data = output.read_bytes()
        uploaded = True
        api.upload(path, data)
        switched = api.patch(import_id, "processing", {
            "title": name, "audio_path": path, "audio_name": name,
            "audio_mime_type": "audio/mpeg", "audio_size_bytes": len(data),
            "source_url": record["import_url"], "updated_at": now(),
            "import_status": "done", "import_error": None, "import_finished_at": now(),
        })
        if not switched:
            api.remove(path)
            return "工作已被新的管理員操作取代"
        previous = record.get("audio_path")
        if previous and previous != path:
            try:
                api.remove(previous)
            except RuntimeError:
                api.patch(import_id, "done", {"import_error": "新音檔已啟用，但舊物件清理失敗。"})
        return "BGM 匯入完成"
    except ImportFailure as exc:
        message = str(exc)
    except (OSError, RuntimeError) as exc:
        message = "匯入服務暫時失敗，請稍後重試。"
        print(f"BGM 工作失敗：{type(exc).__name__}", file=sys.stderr)
    if uploaded and not switched:
        try:
            api.remove(path)
        except RuntimeError:
            pass
    api.patch(import_id, "processing", {"import_status": "failed", "import_error": message, "import_finished_at": now()})
    return message


if __name__ == "__main__":
    api = Supabase()
    if "--check" in sys.argv:
        due = bool(os.environ.get("BGM_PROBE_URL")) or is_due(api.record())
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write(f"run={'true' if due else 'false'}\n")
        print("有待處理匯入" if due else "沒有待處理匯入")
    elif "--probe" in sys.argv:
        url, platform = validate_source_url(os.environ["BGM_PROBE_URL"])
        if platform == "Threads":
            url = resolve_threads_share(url)
        with tempfile.TemporaryDirectory(prefix="bgm-probe-") as folder:
            destination = pathlib.Path(folder) / "bgm.mp3"
            name = download_and_convert(url, destination)
            print(f"來源探測成功：{platform}，{name}，{destination.stat().st_size} bytes；未寫入資料庫或 Storage。")
    else:
        print(run_once(api))
