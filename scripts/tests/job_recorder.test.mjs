import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertTab, chooseMime, profileLabel, recordingWithinLimits, secondsLeft } from "../job-recorder/recorder.mjs";

test("monotonic timer reaches zero and never becomes negative", () => {
  assert.equal(secondsLeft(1000, 1000, 180), 180);
  assert.equal(secondsLeft(1000, 179500, 180), 2);
  assert.equal(secondsLeft(1000, 181000, 180), 0);
  assert.equal(secondsLeft(1000, 999999, 180), 0);
});

test("explicit native codec negotiation never switches to a remote recorder", () => {
  assert.equal(chooseMime(type => type.includes("vp9")), "video/webm;codecs=vp9");
  assert.equal(chooseMime(type => type.includes("vp8")), "video/webm;codecs=vp8");
  assert.equal(chooseMime(type => type === "video/webm"), "video/webm");
  assert.equal(chooseMime(() => false), null);
});

function stream(surface, audio = false) {
  let stopped = 0;
  const video = { getSettings: () => ({ displaySurface: surface }), stop: () => stopped++ };
  const sound = { stop: () => stopped++ };
  return { getVideoTracks: () => [video], getAudioTracks: () => audio ? [sound] : [],
    getTracks: () => audio ? [video, sound] : [video], stopped: () => stopped };
}

test("only a single browser tab without audio is accepted", () => {
  const selected = stream("browser");
  assert.doesNotThrow(() => assertTab(selected));
  assert.equal(selected.stopped(), 0);
});

test("windows, whole screens and unknown capture surfaces immediately stop", () => {
  for (const surface of ["monitor", "window", undefined]) {
    const selected = stream(surface);
    assert.throws(() => assertTab(selected));
    assert.equal(selected.stopped(), 1);
  }
});

test("unexpected audio is rejected and all tracks stop", () => {
  const selected = stream("browser", true);
  assert.throws(() => assertTab(selected));
  assert.equal(selected.stopped(), 2);
});

test("empty, oversized and overlong recordings cannot be submitted", () => {
  const config = { max_bytes: 96 * 1024 * 1024, max_seconds: 180 };
  assert.equal(recordingWithinLimits(1000, 3, config), true);
  for (const [size, elapsed] of [[0, 3], [1000, 0], [config.max_bytes + 1, 3], [1000, 186]]) {
    assert.equal(recordingWithinLimits(size, elapsed, config), false);
  }
});

test("missing verification never implies the current browser profile is known", () => {
  for (const config of [{}, { profile: null, profile_directory: null, profile_verified: false },
    { profile: "Unconfirmed", profile_directory: "Default" }]) {
    assert.match(profileLabel(config), /未核验/);
    assert.doesNotMatch(profileLabel(config), /已匹配/);
  }
});

test("matched metadata names the configured profile and still asks the user to open it", () => {
  const label = profileLabel({ profile: "Research", profile_directory: "Profile 9", profile_verified: true });
  assert.match(label, /配置已匹配/);
  assert.match(label, /Research \/ Profile 9/);
  assert.match(label, /请在该配置中打开录制页并确认所选标签页/);
  assert.doesNotMatch(label, /当前浏览器已核验/);
});

test("page copy describes generic job tabs and uses a real placeholder newline", async () => {
  const html = await readFile(new URL("../job-recorder/index.html", import.meta.url), "utf8");
  assert.match(html, /岗位标签页录制/);
  assert.doesNotMatch(html, /BOSS|<strong>job<\/strong>/);
  const placeholder = html.match(/<textarea[^>]*placeholder="([^"]*)"/)[1];
  assert.ok(placeholder.includes("\n"));
  assert.ok(!placeholder.includes("\\n"));
});
