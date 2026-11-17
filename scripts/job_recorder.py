"""One-shot localhost tab recorder; browser-native capture, no browser automation."""

from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import time

import job_capture as capture

ASSETS = Path(__file__).with_name("job-recorder")
MAX_RECORD_SECONDS = 180
MAX_UPLOAD = 96 * 1024 * 1024
SESSION_SECONDS = 900


def chrome_profile(label, user_data_dir):
    """Read only names/directories from the explicitly supplied Local State."""
    if not isinstance(label, str) or not label.strip() or not user_data_dir:
        raise capture.CaptureError("核验Chrome配置须同时指定 --profile 与 --user-data-dir。")
    try:
        root = Path(user_data_dir).expanduser().resolve(strict=True)
        profiles = json.loads((root / "Local State").read_text(encoding="utf-8"))["profile"]["info_cache"]
        if not isinstance(profiles, dict):
            raise ValueError("invalid profile metadata")
        matches = []
        for directory, info in profiles.items():
            if (not isinstance(directory, str) or not isinstance(info, dict)
                    or not isinstance(info.get("name"), str)):
                continue
            if info["name"].casefold() != label.casefold() and directory.casefold() != label.casefold():
                continue
            if (not directory or directory in (".", "..")
                    or any(char in directory for char in "/\\:\0")):
                continue
            location = root / directory
            if location.is_dir() and location.resolve().parent == root:
                matches.append({"label": info["name"], "directory": directory, "root": root})
    except (OSError, ValueError, TypeError, KeyError, RuntimeError):
        raise capture.CaptureError("无法读取指定User Data目录的Local State名称与目录信息；请检查路径、格式及权限。") from None
    if len(matches) != 1:
        raise capture.CaptureError(f"指定的Chrome profile有 {len(matches)} 个可确认匹配；停止，不创建或替换profile。")
    return matches[0]


def windows_path(path):
    try:
        parts = path.expanduser().resolve().parts
    except (OSError, ValueError, RuntimeError):
        raise capture.CaptureError("无法解析Windows Chrome路径；请检查显式指定的WSL路径。") from None
    if (len(parts) < 4 or parts[1] != "mnt" or len(parts[2]) != 1
            or parts[2].lower() not in "abcdefghijklmnopqrstuvwxyz"):
        raise capture.CaptureError("自动启动仅支持WSL与Windows Chrome；路径须为 /mnt/<盘符>/...。")
    return parts[2].upper() + ":\\" + "\\".join(parts[3:])


class Session:
    def __init__(self, output, profile, review_options=None):
        self.output = capture.outside_repo(output)
        self.profile = profile
        options = review_options or {}
        self.review_options = {"context": list(options.get("context", [])),
                               "known_jobs": options.get("known_jobs")}
        self.token = secrets.token_urlsafe(32)
        self.started = time.monotonic()
        self.deadline = self.started + SESSION_SECONDS
        self.process = None
        self.process_deadline = None
        self.ready_at = None
        self.data = {"state": "waiting", "message": "请在浏览器中完成登录，再选择岗位标签页。",
                     "profile": profile["label"] if profile else None,
                     "profile_directory": profile["directory"] if profile else None,
                     "profile_verified": profile is not None,  # Metadata match, not active browser identity.
                     "max_seconds": MAX_RECORD_SECONDS, "max_bytes": MAX_UPLOAD,
                     "created_at": datetime.now(timezone.utc).isoformat(),
                     "output_dir": str(self.output), "frontend": None}
        self.output.mkdir(parents=True, exist_ok=False, mode=0o700)
        self.save()

    def save(self):
        capture.save_json(self.output / "session.json", self.data)

    def state(self, name, message):
        self.data.update(state=name, message=message)
        self.save()

    def spawn(self, command, state, timeout):
        self.process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                        stdin=subprocess.DEVNULL, start_new_session=True)
        self.process_deadline = min(self.deadline, time.monotonic() + timeout)
        self.state(state, "正在本机封装录像。" if state == "normalizing" else "正在本机抽帧与识字。")

    def normalize(self):
        ffmpeg = capture.tools()["ffmpeg"]
        self.spawn([ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-n",
                    "-protocol_whitelist", "file,pipe", "-i", str(self.output / "recording.webm"),
                    "-map", "0:v:0", "-an", "-sn", "-dn", "-c:v", "copy",
                    str(self.output / "recording.mkv")], "normalizing", 90)

    def stop_process(self):
        if self.process is not None:
            # Only a process group created by this session; never touch the user's Chrome.
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.process.wait(timeout=3)
            self.process = None

    def tick(self):
        if self.process is None:
            return
        if time.monotonic() > self.process_deadline:
            self.stop_process()
            self.state("failed", "本地处理超时；已停止，不自动重试。原始材料仍在输出目录。")
            return
        code = self.process.poll()
        if code is None:
            return
        self.process = None
        if code:
            self.state("failed", "本地媒体处理失败；请检查原始材料和analysis/manifest.json，不保存底层日志。")
            return
        if self.data["state"] == "normalizing":
            _, _, duration = capture.probe(self.output / "recording.mkv", capture.tools(), self.deadline)
            if not 0 < duration <= MAX_RECORD_SECONDS + 5:
                self.state("failed", "录屏时长无效或超过180秒容差；不截断、不提交分析。")
                return
            self.data["recorded_seconds"] = round(duration, 3)
            command = [sys.executable, "-B", str(Path(capture.__file__).resolve()), "prepare",
                       str(self.output / "recording.mkv"), "--output", str(self.output / "analysis")]
            for context in self.review_options["context"]:
                command += ["--context", context]
            if self.review_options["known_jobs"] is not None:
                command += ["--known-jobs", self.review_options["known_jobs"]]
            if (self.output / "notes.txt").exists():
                command += ["--notes", str(self.output / "notes.txt")]
            self.spawn(command, "processing", 610)
        else:
            manifest = json.loads((self.output / "analysis/manifest.json").read_text(encoding="utf-8"))
            if manifest.get("status") != "ready_for_review":
                self.state("failed", "分析子进程未生成完整材料包。")
                return
            self.data["review_file"] = "analysis/review.md"
            self.data["sampled_frames"] = len(manifest["frames"])
            self.ready_at = time.monotonic()
            self.state("ready", "材料包已生成，尚未筛岗或投递。助手可读取analysis/review.md。")


class RecorderServer(HTTPServer):
    allow_reuse_address = False

    def __init__(self, session):
        super().__init__(("127.0.0.1", 0), RecorderHandler)
        self.timeout = 0.5
        self.session = session
        self.origin = f"http://127.0.0.1:{self.server_port}"


class RecorderHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *args):
        pass  # Do not log headers, bodies, query strings or browser/account information.

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def reply(self, code, body=b"", content_type="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; "
                         "connect-src 'self'; media-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def json_reply(self, value, code=200):
        self.reply(code, json.dumps(value, ensure_ascii=False).encode())

    def valid_host(self):
        return self.headers.get("Host") == self.server.origin.removeprefix("http://")

    def authorized(self):
        return (self.valid_host() and self.headers.get("Origin") == self.server.origin
                and secrets.compare_digest(self.headers.get("X-Capture-Token", ""), self.server.session.token))

    def do_GET(self):
        if not self.valid_host():
            self.reply(403)
            return
        assets = {"/": ("index.html", "text/html; charset=utf-8"),
                  "/recorder.mjs": ("recorder.mjs", "text/javascript; charset=utf-8"),
                  "/recorder.css": ("recorder.css", "text/css; charset=utf-8")}
        if self.path in assets:
            name, mime = assets[self.path]
            self.reply(200, (ASSETS / name).read_bytes(), mime)
        elif self.path == "/session":
            self.json_reply(dict(self.server.session.data, token=self.server.session.token))
        elif self.path == "/status":
            self.json_reply(self.server.session.data)
        else:
            self.reply(404)

    def length(self, maximum):
        value = self.headers.get("Content-Length", "")
        if not value.isdigit() or not 0 < int(value) <= maximum or self.headers.get("Transfer-Encoding"):
            raise capture.CaptureError("请求体为空、未声明长度或超过限制。")
        return int(value)

    def do_POST(self):
        if not self.authorized():
            self.reply(403)
            return
        session = self.server.session
        try:
            if self.path == "/client":
                incoming = json.loads(self.rfile.read(self.length(4096)))
                allowed = ("secure_context", "capture_api", "recorder_api", "module_loaded",
                           "controls_labeled", "no_horizontal_overflow")
                if not isinstance(incoming, dict) or any(type(incoming.get(key)) is not bool for key in allowed):
                    raise capture.CaptureError("客户端诊断格式无效。")
                session.data["frontend"] = {key: incoming[key] for key in allowed}
                session.save()
                self.json_reply({"ok": True})
                return
            if session.data["state"] != "waiting":
                self.json_reply({"error": "每个服务仅接收一批录制；当前状态不接受重传。"}, 409)
                return
            if self.path == "/notes":
                incoming = json.loads(self.rfile.read(self.length(65536)))
                notes = incoming.get("notes") if isinstance(incoming, dict) else None
                if not isinstance(notes, str) or len(notes.encode()) > 60000:
                    raise capture.CaptureError("补充文字过长或不是文本。")
                if notes.strip():
                    (session.output / "notes.txt").write_text(notes, encoding="utf-8")
                self.json_reply({"ok": True})
                return
            if self.path != "/recording":
                self.reply(404)
                return
            length = self.length(MAX_UPLOAD)
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "video/webm":
                raise capture.CaptureError("仅接收浏览器WebM录像。")
            session.state("uploading", "正在接收本机标签页录像。")
            cutoff = time.monotonic() + 45
            partial = session.output / "recording.webm.part"
            with partial.open("xb") as target:
                remaining = length
                while remaining:
                    if time.monotonic() > cutoff:
                        raise capture.CaptureError("本机接收录像超时。")
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise capture.CaptureError("录像传输中断；不处理不完整文件。")
                    target.write(chunk)
                    remaining -= len(chunk)
            partial.rename(session.output / "recording.webm")
            session.normalize()
            self.json_reply({"ok": True}, 202)
        except (capture.CaptureError, OSError, ValueError, TypeError) as exc:
            message = str(exc) if isinstance(exc, capture.CaptureError) else "本地接收或处理失败。"
            if session.data["state"] != "waiting":
                session.state("failed", message)
            self.json_reply({"error": message}, 400)


def serve(args):
    if os.name != "posix":
        raise capture.CaptureError("本地录屏服务当前在WSL/Linux运行；不隐式更换进程控制方式。")
    if args.open and not all((args.profile, args.chrome, args.user_data_dir)):
        raise capture.CaptureError("--open 必须同时指定 --profile、--chrome 和 --user-data-dir；不创建或替换配置。")
    if args.profile and not args.user_data_dir:
        raise capture.CaptureError("指定 --profile 时必须提供 --user-data-dir；不会自动查找或假定配置已核验。")
    if args.open and "microsoft" not in os.uname().release.casefold():
        raise capture.CaptureError("自动启动仅支持WSL与Windows Chrome；请去掉 --open 后手动打开本机录制页。")
    try:
        profile = chrome_profile(args.profile, args.user_data_dir) if args.profile else None
        chrome = None
        user_data_windows = None
        if args.open:
            chrome = Path(args.chrome).expanduser().resolve(strict=True)
            if not chrome.is_file() or chrome.suffix.casefold() != ".exe" or not os.access(chrome, os.X_OK):
                raise capture.CaptureError("--chrome 必须是现有且可执行的Windows Chrome .exe路径；不安装或替换浏览器。")
            windows_path(chrome)
            user_data_windows = windows_path(profile["root"])
        _, contexts = capture.load_review_inputs(args)
        review_options = {"context": [path for path, _ in contexts],
                          "known_jobs": str(Path(args.known_jobs).expanduser().resolve()) if args.known_jobs else None}
        output = capture.outside_repo(Path(args.output))
        if output.exists():
            raise capture.CaptureError("输出目录必须是仓库外的新目录；不覆盖已有录制。")
    except (OSError, ValueError, TypeError, RuntimeError):
        raise capture.CaptureError("无法读取显式配置或输出路径；请检查文件是否存在、格式及访问权限。") from None
    capture.tools()
    old_umask = os.umask(0o077)
    session = None
    try:
        session = Session(output, profile, review_options=review_options)
        with RecorderServer(session) as server:
            print(f"本地录屏页：{server.origin}", flush=True)
            profile_status = (f"配置名称与目录已匹配：{profile['label']} / {profile['directory']}"
                              if profile else "浏览器配置（profile）未核验；请自行确认所用窗口与岗位标签页")
            print(f"{profile_status}；单次最多180秒，不录音。", flush=True)
            print(f"保存目录：{output}", flush=True)
            if args.open:
                subprocess.Popen([str(chrome), f"--user-data-dir={user_data_windows}",
                                  f"--profile-directory={profile['directory']}", "--new-window", server.origin],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 stdin=subprocess.DEVNULL)
            while time.monotonic() < session.deadline:
                server.handle_request()
                session.tick()
                if session.ready_at and time.monotonic() - session.ready_at > 60:
                    break
            if session.data["state"] not in {"ready", "failed"}:
                session.state("expired", "本次服务达到15分钟时限；未完成，不自动重启。")
            print(f"服务结束：{session.data['state']}", flush=True)
            return 0 if session.data["state"] == "ready" else 2
    except KeyboardInterrupt:
        if session:
            session.state("interrupted", "本人中断了本次服务；结果未完成。")
        return 130
    except (OSError, ValueError, capture.CaptureError) as exc:
        if session:
            session.state("failed", str(exc) if isinstance(exc, capture.CaptureError) else "本地服务启动或处理失败。")
        raise capture.CaptureError("本地录屏服务未完成；请检查session.json，不保存底层日志。") from exc
    finally:
        if session:
            session.stop_process()
        os.umask(old_umask)
