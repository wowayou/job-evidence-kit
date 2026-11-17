// Native Screen Capture + MediaRecorder APIs. No extension, remote endpoint or model API.
export function secondsLeft(started, now, maximum) {
  return Math.max(0, Math.ceil(maximum - (now - started) / 1000));
}

export function chooseMime(supported) {
  return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(supported) || null;
}

export function assertTab(stream) {
  const tracks = stream.getVideoTracks();
  if (tracks.length !== 1 || tracks[0].getSettings().displaySurface !== "browser" || stream.getAudioTracks().length) {
    stream.getTracks().forEach(track => track.stop());
    throw new Error("只允许共享单个浏览器标签页，且不包含音频；请重新选择岗位标签页。");
  }
}

export function recordingWithinLimits(size, elapsed, config) {
  return size > 0 && size <= config.max_bytes && elapsed > 0 && elapsed <= config.max_seconds + 5;
}

export function profileLabel(config) {
  return config.profile_verified === true
    ? `配置已匹配（profile）：${config.profile} / ${config.profile_directory}；请在该配置中打开录制页并确认所选标签页。`
    : "浏览器配置（profile）未核验；请自行确认所用窗口与岗位标签页。";
}

export async function boot() {
  const get = id => document.getElementById(id);
  const startButton = get("start");
  const stopButton = get("stop");
  const status = get("status");
  const error = get("error");
  const preview = get("preview");
  const timer = get("timer");
  let config, stream, recorder, clock, hardStop, started;
  let recording = false, busy = false, terminal = false, attempts = 0;
  let parts = [], bytes = 0, discarded = false, elapsed = 0;

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
    error.focus();
  }

  async function send(path, body, contentType) {
    const result = await fetch(path, { method: "POST", headers: {
      "Content-Type": contentType, "X-Capture-Token": config.token,
    }, body, signal: AbortSignal.timeout(60000) });
    const data = await result.json();
    if (!result.ok) throw new Error(data.error || "本机服务未接受请求，不会自动重传。");
    return data;
  }

  function release() {
    clearInterval(clock);
    clearTimeout(hardStop);
    if (stream) stream.getTracks().forEach(track => track.stop());
    preview.srcObject = null;
    preview.hidden = true;
    stopButton.disabled = true;
  }

  function stop() {
    if (!recording) return;
    recording = false;
    elapsed = (performance.now() - started) / 1000;
    stopButton.disabled = true;
    status.textContent = "录制已停止，正在保存最后一段画面…";
    if (recorder.state !== "inactive") recorder.stop();
    release();
  }

  async function poll() {
    const result = await fetch("/status", { signal: AbortSignal.timeout(5000) });
    if (!result.ok) throw new Error("无法读取本机处理状态。");
    const data = await result.json();
    status.textContent = data.message;
    if (data.state === "ready") {
      get("result-path").textContent = `${data.output_dir}/${data.review_file}`;
      get("result").hidden = false;
      timer.textContent = `录制 ${data.recorded_seconds} 秒 · 采样 ${data.sampled_frames} 帧`;
      busy = false;
      terminal = true;
      return;
    }
    if (["failed", "expired", "interrupted"].includes(data.state)) throw new Error(data.message);
    setTimeout(() => { poll().catch(fail); }, 1000);
  }

  function fail(exception) {
    busy = false;
    terminal = true;
    release();
    status.textContent = "本次未完成，不会自动重试。";
    showError(exception.message || "本地录制或处理未完成。");
  }

  async function save() {
    release();
    if (discarded || !recordingWithinLimits(bytes, elapsed, config)) {
      parts = [];
      fail(new Error("录像为空、超过96 MiB或超过180秒容差；已停止，不上传不完整/超限录像。"));
      return;
    }
    busy = true;
    timer.textContent = `已录制 ${elapsed.toFixed(1)} 秒`;
    const blob = new Blob(parts, { type: recorder.mimeType });
    parts = [];
    try {
      status.textContent = "正在保存到本机；不上传外部服务…";
      await send("/notes", JSON.stringify({ notes: get("notes").value }), "application/json");
      await send("/recording", blob, "video/webm");
      await poll();
    } catch (exception) { fail(exception); }
  }

  startButton.addEventListener("click", async () => {
    if (recording || busy || terminal || !config || attempts >= 3) return;
    attempts++;
    startButton.disabled = true;
    error.hidden = true;
    try {
      // Must be the direct result of this user gesture, not an automated permission bypass.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser", frameRate: { ideal: 5, max: 10 } },
        audio: false, monitorTypeSurfaces: "exclude", selfBrowserSurface: "exclude",
        surfaceSwitching: "exclude", systemAudio: "exclude",
      });
      assertTab(stream);
      const mimeType = chooseMime(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error("当前浏览器不支持WebM录像；不会改用云端录制。");
      parts = []; bytes = 0; discarded = false;
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2000000 });
      recorder.addEventListener("dataavailable", event => {
        if (event.data.size) {
          bytes += event.data.size;
          if (bytes > config.max_bytes) { discarded = true; parts = []; stop(); return; }
          if (!discarded) parts.push(event.data);
        }
        if (recording && secondsLeft(started, performance.now(), config.max_seconds) === 0) stop();
      });
      recorder.addEventListener("stop", save, { once: true });
      recorder.addEventListener("error", () => { discarded = true; stop(); }, { once: true });
      stream.getVideoTracks()[0].addEventListener("ended", stop, { once: true });
      preview.srcObject = stream;
      preview.hidden = false;
      recorder.start(1000);
      started = performance.now();
      recording = true;
      stopButton.disabled = false;
      get("notes").disabled = true;
      status.textContent = `正在录制所选标签页（${mimeType}），请切到所选标签页查看岗位；可随时停止。`;
      clock = setInterval(() => {
        const left = secondsLeft(started, performance.now(), config.max_seconds);
        timer.textContent = `剩余 ${left} 秒`;
        if (!left) stop();
      }, 250);
      hardStop = setTimeout(stop, config.max_seconds * 1000);
    } catch (exception) {
      release();
      status.textContent = "没有开始录制，没有保存或上传画面。";
      const permission = ["NotAllowedError", "InvalidStateError", "AbortError"].includes(exception.name);
      showError(permission ? "共享已取消或未获允许；需要你点击按钮并亲自选择标签页。" : exception.message);
      startButton.disabled = attempts >= 3;
    }
  });
  stopButton.addEventListener("click", stop);
  window.addEventListener("beforeunload", event => {
    if (recording || busy) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("pagehide", () => { if (stream) stream.getTracks().forEach(track => track.stop()); });

  try {
    const response = await fetch("/session", { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("无法连接本机录制服务。");
    config = await response.json();
    get("profile").textContent = profileLabel(config);
    await send("/client", JSON.stringify({
      secure_context: window.isSecureContext,
      capture_api: Boolean(navigator.mediaDevices?.getDisplayMedia),
      recorder_api: typeof MediaRecorder !== "undefined",
      module_loaded: true,
      controls_labeled: Boolean(startButton.textContent.trim() && stopButton.textContent.trim() && document.querySelector('label[for="notes"]')),
      no_horizontal_overflow: document.documentElement.scrollWidth <= window.innerWidth,
    }), "application/json");
    if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === "undefined") {
      throw new Error("当前浏览器或页面环境不支持本地标签页录制；不会静默替换方案。");
    }
    if (config.state !== "waiting") {
      busy = true;
      await poll();
      return;
    }
    startButton.disabled = false;
    status.textContent = "就绪。请先在准备录制的浏览器窗口登录，再点击按钮选择岗位标签页；最多录制180秒。";
  } catch (exception) { fail(exception); }
}

if (typeof document !== "undefined") boot();
