"""Local recorder tests; synthetic profiles and videos, no real account or permission bypass."""

import http.client
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import MagicMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import job_capture as capture
import job_recorder as recorder


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="job-profile-tests-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "User Data"

    def profile(self, label, directory="Profile 9", root=None):
        root = root or self.root
        (root / directory).mkdir(parents=True)
        state = root / "Local State"
        profiles = json.loads(state.read_text())["profile"]["info_cache"] if state.exists() else {}
        profiles[directory] = {"name": label, "user_name": "PRIVATE_ACCOUNT"}
        state.write_text(json.dumps({"profile": {"info_cache": profiles},
                                     "os_crypt": {"encrypted_key": "PRIVATE_VALUE"}}), encoding="utf-8")
        return root

    def test_uses_only_exact_unique_existing_profile_metadata(self):
        root = self.profile("Research")
        self.profile("Research", root=self.base / "Other User Data")
        original_read = Path.read_text

        def only_local_state(path, *args, **kwargs):
            self.assertEqual(path, root / "Local State")
            return original_read(path, *args, **kwargs)

        with patch.object(Path, "iterdir", side_effect=AssertionError("must not scan users")), \
                patch.object(Path, "read_text", new=only_local_state):
            result = recorder.chrome_profile("research", root)
        self.assertEqual(result, {"label": "Research", "directory": "Profile 9", "root": root})
        self.assertNotIn("PRIVATE", repr(result))
        self.assertEqual(recorder.chrome_profile("profile 9", root), result)

    def test_no_match_or_multiple_matches_never_substitutes_or_creates(self):
        root = self.profile("Personal")
        before = sorted(path.relative_to(root) for path in root.rglob("*"))
        with self.assertRaisesRegex(capture.CaptureError, "0 个"):
            recorder.chrome_profile("Research", root)
        self.assertEqual(sorted(path.relative_to(root) for path in root.rglob("*")), before)
        self.profile("Research", "Profile 10")
        self.profile("Research", "Profile 11")
        with self.assertRaisesRegex(capture.CaptureError, "2 个"):
            recorder.chrome_profile("Research", root)

    def test_invalid_explicit_root_or_local_state_fails_without_private_details(self):
        for root in (self.base / "missing", self.base):
            with self.subTest(root=root), self.assertRaises(capture.CaptureError) as error:
                recorder.chrome_profile("Research", root)
            self.assertNotIn(str(root), str(error.exception))
        root = self.profile("Research")
        for payload in ("PRIVATE_INVALID_JSON", "null", '{"profile": {"info_cache": []}}'):
            (root / "Local State").write_text(payload, encoding="utf-8")
            with self.subTest(payload=payload), self.assertRaises(capture.CaptureError) as error:
                recorder.chrome_profile("Research", root)
            self.assertNotIn("PRIVATE", str(error.exception))
        self.assertFalse((self.base / "missing").exists())

    def test_metadata_never_creates_missing_profile_or_uses_escaped_directory(self):
        self.root.mkdir()
        for directory in ("Missing Profile", "../outside", "..\\outside", "C:\\outside"):
            (self.root / "Local State").write_text(json.dumps({
                "profile": {"info_cache": {directory: {"name": "Research"}}}}), encoding="utf-8")
            with self.subTest(directory=directory), self.assertRaisesRegex(capture.CaptureError, "0 个"):
                recorder.chrome_profile("Research", self.root)
        self.assertEqual(list(self.root.iterdir()), [self.root / "Local State"])

    def test_windows_path_mapping_does_not_use_shell(self):
        self.assertEqual(recorder.windows_path(Path("/mnt/c/Users/example/Profile Space")),
                         "C:\\Users\\example\\Profile Space")
        for value in ("/home/example", "/mnt/12/example", "/mnt/1/example"):
            with self.subTest(value=value), self.assertRaises(capture.CaptureError):
                recorder.windows_path(Path(value))


class ServeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="job-recorder-serve-tests-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.output = self.base / "output"

    def args(self, *extra):
        return capture.parser().parse_args(["record", "--output", str(self.output), *extra])

    def completed_server(self, session):
        server = MagicMock()
        server.__enter__.return_value = server
        server.origin = "http://127.0.0.1:12345"

        def finish():
            session.state("ready", "Synthetic completed session")
            session.ready_at = time.monotonic() - 61

        server.handle_request.side_effect = finish
        return server

    def test_open_missing_any_required_option_fails_before_side_effects(self):
        options = (("--profile", "Research"), ("--chrome", "/synthetic/chrome.exe"),
                   ("--user-data-dir", "/synthetic/User Data"))
        for mask in range(7):
            args = self.args("--open", *(value for index, pair in enumerate(options)
                                        if mask & (1 << index) for value in pair))
            with self.subTest(mask=mask), patch.object(Path, "mkdir") as mkdir, \
                    patch.object(recorder, "chrome_profile") as profile, \
                    patch.object(capture, "tools") as tools, \
                    patch.object(recorder, "RecorderServer") as server, \
                    patch.object(recorder.subprocess, "Popen") as popen:
                with self.assertRaisesRegex(capture.CaptureError, "--open.*--profile.*--chrome.*--user-data-dir"):
                    recorder.serve(args)
                for call in (mkdir, profile, tools, server, popen):
                    call.assert_not_called()
            self.assertFalse(self.output.exists())

    def test_profile_without_user_data_dir_is_not_treated_as_verified(self):
        with patch.object(recorder, "chrome_profile") as profile, \
                patch.object(recorder.subprocess, "Popen") as popen:
            with self.assertRaisesRegex(capture.CaptureError, "--user-data-dir"):
                recorder.serve(self.args("--profile", "Research"))
            profile.assert_not_called()
            popen.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_manual_mode_does_not_find_or_launch_chrome_and_marks_unverified(self):
        with patch.object(recorder, "chrome_profile") as profile, \
                patch.object(recorder, "windows_path") as windows_path, \
                patch.object(recorder, "RecorderServer", side_effect=self.completed_server) as server, \
                patch.object(capture, "tools", return_value={}), \
                patch.object(recorder.subprocess, "Popen") as popen, patch("builtins.print"):
            self.assertEqual(recorder.serve(self.args()), 0)
            profile.assert_not_called()
            windows_path.assert_not_called()
            popen.assert_not_called()
        session = server.call_args.args[0]
        self.assertFalse(session.data["profile_verified"])
        self.assertIsNone(session.data["profile"])
        self.assertIsNone(session.data["profile_directory"])
        self.assertEqual(session.review_options, {"context": [], "known_jobs": None})

    def test_manual_profile_metadata_can_match_without_chrome(self):
        root = self.base / "User Data"
        (root / "Default").mkdir(parents=True)
        (root / "Local State").write_text(json.dumps({
            "profile": {"info_cache": {"Default": {"name": "Research"}}}}), encoding="utf-8")
        with patch.object(recorder, "RecorderServer", side_effect=self.completed_server) as server, \
                patch.object(recorder, "windows_path") as windows_path, \
                patch.object(capture, "tools", return_value={}), \
                patch.object(recorder.subprocess, "Popen") as popen, patch("builtins.print"):
            self.assertEqual(recorder.serve(self.args("--profile", "Research", "--user-data-dir", str(root))), 0)
            windows_path.assert_not_called()
            popen.assert_not_called()
        self.assertTrue(server.call_args.args[0].data["profile_verified"])
        self.assertEqual(server.call_args.args[0].data["profile"], "Research")

    def test_review_inputs_are_validated_and_resolved_before_serving(self):
        context = self.base / "rules with spaces.md"
        context.write_text("SYNTHETIC_CONTEXT_ONLY", encoding="utf-8")
        known = self.base / "known jobs.json"
        known.write_text('[{"company": "Synthetic", "role": "Fixture"}]', encoding="utf-8")
        # Real relative inputs, without changing the process cwd shared with other work.
        context_arg = recorder.os.path.relpath(context)
        known_arg = recorder.os.path.relpath(known)
        args = self.args("--context", context_arg, "--known-jobs", known_arg)
        with patch.object(capture, "load_review_inputs", wraps=capture.load_review_inputs) as load, \
                patch.object(recorder, "RecorderServer", side_effect=self.completed_server) as server, \
                patch.object(capture, "tools", return_value={}), patch("builtins.print"):
            self.assertEqual(recorder.serve(args), 0)
            load.assert_called_once_with(args)
        self.assertEqual(server.call_args.args[0].review_options,
                         {"context": [str(context)], "known_jobs": str(known)})

    def test_invalid_review_inputs_stop_before_output_or_server(self):
        invalid = self.base / "bad.json"
        invalid.write_text("PRIVATE_BAD_JSON", encoding="utf-8")
        for options in (("--context", str(self.base / "missing.md")), ("--known-jobs", str(invalid))):
            with self.subTest(options=options), patch.object(recorder, "RecorderServer") as server, \
                    patch.object(capture, "tools") as tools:
                with self.assertRaises(capture.CaptureError) as error:
                    recorder.serve(self.args(*options))
                self.assertNotIn("PRIVATE", str(error.exception))
                server.assert_not_called()
                tools.assert_not_called()
                self.assertFalse(self.output.exists())

    def test_open_outside_wsl_is_rejected_before_profile_or_output(self):
        with patch.object(recorder.os, "uname", return_value=Mock(release="generic-linux")), \
                patch.object(recorder, "chrome_profile") as profile, \
                patch.object(recorder.subprocess, "Popen") as popen:
            with self.assertRaisesRegex(capture.CaptureError, "仅支持WSL"):
                recorder.serve(self.args("--open", "--profile", "Research", "--chrome", "/synthetic/chrome.exe",
                                        "--user-data-dir", "/synthetic/User Data"))
            profile.assert_not_called()
            popen.assert_not_called()
        self.assertFalse(self.output.exists())


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="job-recorder-session-tests-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def test_prepare_receives_only_explicit_review_options_and_notes(self):
        for supplied in (False, True):
            with self.subTest(supplied=supplied):
                contexts = [str(self.base / "rules with spaces.md"), str(self.base / "capabilities.md")]
                known = str(self.base / "known jobs.json")
                options = {"context": contexts, "known_jobs": known} if supplied else None
                session = recorder.Session(self.base / str(supplied), None, review_options=options)
                (session.output / "notes.txt").write_text("Synthetic notes", encoding="utf-8")
                session.process = Mock()
                session.process.poll.return_value = 0
                session.process_deadline = time.monotonic() + 10
                session.data["state"] = "normalizing"
                expected = [sys.executable, "-B", str(Path(capture.__file__).resolve()), "prepare",
                            str(session.output / "recording.mkv"), "--output", str(session.output / "analysis")]
                if supplied:
                    for context in contexts:
                        expected += ["--context", context]
                    expected += ["--known-jobs", known]
                expected += ["--notes", str(session.output / "notes.txt")]
                with patch.object(capture, "tools", return_value={}), \
                        patch.object(capture, "probe", return_value=(1280, 720, 3)), \
                        patch.object(recorder.subprocess, "Popen") as popen:
                    session.tick()
                    popen.assert_called_once_with(expected, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                                  stdin=subprocess.DEVNULL, start_new_session=True)
                self.assertEqual(session.data["state"], "processing")
                self.assertLessEqual(session.process_deadline, session.deadline)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="job-recorder-tests-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.session = recorder.Session(self.base / "output", {"label": "job", "directory": "Profile 9"})
        self.addCleanup(self.session.stop_process)
        self.server = recorder.RecorderServer(self.session)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, method, path, body=None, headers=None, authorized=True):
        client = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        self.addCleanup(client.close)
        fields = {}
        if method == "POST" and authorized:
            fields = {"Origin": self.server.origin, "X-Capture-Token": self.session.token,
                      "Content-Type": "application/json"}
        fields.update(headers or {})
        client.request(method, path, body=body, headers=fields)
        response = client.getresponse()
        return response.status, response.read(), dict(response.getheaders())

    def test_page_assets_and_security_headers(self):
        code, html, headers = self.request("GET", "/")
        self.assertEqual(code, 200)
        self.assertIn("岗位标签页录制".encode(), html)
        self.assertIn("未核验".encode(), html)
        self.assertNotIn(b"BOSS", html)
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        for asset in ("/recorder.mjs", "/recorder.css"):
            self.assertEqual(self.request("GET", asset)[0], 200)
        self.assertEqual(self.request("GET", "/recording.webm")[0], 404)
        self.assertEqual(self.request("GET", "/../job_capture.py")[0], 404)

    def test_host_origin_and_session_nonce_are_required(self):
        self.assertEqual(self.request("GET", "/", headers={"Host": "untrusted.test"})[0], 403)
        payload = json.dumps({"notes": "public fixture"})
        for headers in ({"Origin": "https://evil.test"}, {"X-Capture-Token": "wrong"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request("POST", "/notes", payload, headers)[0], 403)
        self.assertEqual(self.request("POST", "/notes", payload, authorized=False)[0], 403)
        self.assertFalse((self.session.output / "notes.txt").exists())

    def test_notes_and_client_diagnostics_use_allowlisted_fields(self):
        code, _, _ = self.request("POST", "/notes", json.dumps({"notes": "岗位URL\n检索：青岛"}))
        self.assertEqual(code, 200)
        self.assertIn("青岛", (self.session.output / "notes.txt").read_text())
        report = {key: True for key in ("secure_context", "capture_api", "recorder_api",
                                      "module_loaded", "controls_labeled", "no_horizontal_overflow")}
        report["do_not_copy"] = "PRIVATE_VALUE"
        self.assertEqual(self.request("POST", "/client", json.dumps(report))[0], 200)
        self.assertNotIn("PRIVATE_VALUE", (self.session.output / "session.json").read_text())
        self.assertNotIn("token", json.loads(self.request("GET", "/status")[1]))
        self.assertEqual(json.loads(self.request("GET", "/session")[1])["token"], self.session.token)
        self.assertNotIn(self.session.token, (self.session.output / "session.json").read_text())

    def test_malformed_json_and_wrong_shapes_do_not_crash_server(self):
        for endpoint in ("/notes", "/client"):
            for body in ("[]", "null", "not json"):
                with self.subTest(endpoint=endpoint, body=body):
                    self.assertEqual(self.request("POST", endpoint, body)[0], 400)
        self.assertEqual(self.request("GET", "/status")[0], 200)

    def test_upload_size_and_type_limits_are_checked_before_processing(self):
        with patch.object(self.session, "normalize") as normalize:
            self.assertEqual(self.request("POST", "/recording", b"", {"Content-Length": str(recorder.MAX_UPLOAD + 1)})[0], 400)
            self.assertEqual(self.request("POST", "/recording", b"bad", {"Content-Type": "text/plain"})[0], 400)
            normalize.assert_not_called()
        self.assertFalse((self.session.output / "recording.webm").exists())
        self.assertEqual(self.session.data["state"], "waiting")

    def test_one_upload_only_never_overwrites_or_automatically_retries(self):
        def normalized():
            self.session.state("normalizing", "fixture")
        with patch.object(self.session, "normalize", side_effect=normalized) as normalize:
            self.assertEqual(self.request("POST", "/recording", b"synthetic", {"Content-Type": "video/webm"})[0], 202)
            self.assertEqual(self.request("POST", "/recording", b"replace", {"Content-Type": "video/webm"})[0], 409)
            self.assertEqual(normalize.call_count, 1)
        self.assertEqual((self.session.output / "recording.webm").read_bytes(), b"synthetic")

    def test_overlong_normalized_video_is_rejected_not_truncated(self):
        process = unittest.mock.Mock()
        process.poll.return_value = 0
        self.session.process = process
        self.session.process_deadline = time.monotonic() + 10
        self.session.data["state"] = "normalizing"
        with patch.object(capture, "tools", return_value={}), patch.object(capture, "probe", return_value=(1280, 720, 186)):
            self.session.tick()
        self.assertEqual(self.session.data["state"], "failed")
        self.assertFalse((self.session.output / "analysis").exists())


FONT = Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")


class RecorderIntegrationTests(unittest.TestCase):
    @unittest.skipUnless(FONT.is_file() and all(shutil.which(x) for x in ("ffmpeg", "ffprobe", "tesseract")),
                         "requires installed local media tools and CJK font")
    def test_streaming_webm_without_duration_is_remuxed_and_processed(self):
        try:
            capture.tools()
        except capture.CaptureError as exc:
            self.skipTest(str(exc))
        with tempfile.TemporaryDirectory(prefix="recorder-pipeline-tests-") as folder:
            root = Path(folder)
            note = root / "fixture.txt"
            note.write_text("合成示例公司 Google SEO\n青岛 双休\nWordPress GSC GA4\n测试素材，不是真实岗位", encoding="utf-8")
            context = root / "synthetic rules.md"
            context_text = "SYNTHETIC_REVIEW_CONTEXT：仅依据本次合成材料判断，不读取个人规则。"
            context.write_text(context_text, encoding="utf-8")
            known = root / "synthetic known jobs.json"
            known.write_text(json.dumps([{"company": "SYNTHETIC_KNOWN_COMPANY",
                                          "role": "SYNTHETIC_KNOWN_ROLE", "links": []}]), encoding="utf-8")
            session = recorder.Session(root / "capture", None,
                                       review_options={"context": [str(context)], "known_jobs": str(known)})
            filters = f"drawtext=fontfile={FONT}:textfile={note}:fontcolor=black:fontsize=36:x=60:y=60:line_spacing=24"
            result = subprocess.run(["ffmpeg", "-hide_banner", "-v", "error", "-f", "lavfi", "-i",
                                     "color=white:s=1280x720:r=5:d=3", "-vf", filters, "-c:v", "libvpx",
                                     "-threads:v", "1", "-deadline", "realtime", "-f", "webm", "pipe:1"],
                                    capture_output=True, check=True, timeout=30)
            (session.output / "recording.webm").write_bytes(result.stdout)
            raw = capture.probe(session.output / "recording.webm", capture.tools(), time.monotonic() + 15)
            self.assertEqual(raw[2], 0)  # Like MediaRecorder's streaming WebM, no duration header.
            try:
                session.normalize()
                cutoff = time.monotonic() + 30
                while session.process is not None and time.monotonic() < cutoff:
                    time.sleep(0.05)
                    session.tick()
                self.assertEqual(session.data["state"], "ready", session.data["message"])
                self.assertTrue((session.output / "analysis/review.md").is_file())
                context_output = (session.output / "analysis/context.md").read_text(encoding="utf-8")
                self.assertIn(context_text, context_output)
                self.assertIn(str(context), context_output)
                known_output = json.loads((session.output / "analysis/known-jobs.json").read_text(encoding="utf-8"))
                self.assertEqual(len(known_output), 1)
                self.assertEqual(known_output[0]["company"], "SYNTHETIC_KNOWN_COMPANY")
                self.assertEqual(known_output[0]["role"], "SYNTHETIC_KNOWN_ROLE")
                manifest = json.loads((session.output / "analysis/manifest.json").read_text(encoding="utf-8"))
                self.assertEqual([item["path"] for item in manifest["context"]], [str(context)])
                self.assertEqual(session.data["sampled_frames"], 2)
                self.assertNotIn("token", json.loads((session.output / "session.json").read_text()))
            finally:
                session.stop_process()


if __name__ == "__main__":
    unittest.main()
