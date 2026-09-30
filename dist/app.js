const $ = (selector) => document.querySelector(selector);
const route = window.location.pathname.replace(/\/+$/, '') || '/';
const peerConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const statusEl = $('#connectionStatus');
const statusText = $('#statusText');
const toast = $('#toast');
let toastTimer;

function setStatus(text, state = 'idle') {
  statusText.textContent = text;
  statusEl.dataset.state = state;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `通信エラー (${response.status})`);
  }
  return response.json();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeMediaError(error) {
  if (error.name === 'NotAllowedError') return 'カメラの使用が許可されていません。Safari/Chromeの設定を確認してください。';
  if (error.name === 'NotFoundError') return '利用できるカメラが見つかりませんでした。';
  if (error.name === 'NotReadableError') return 'カメラを開けません。他のアプリが使用していないか確認してください。';
  return `カメラを開始できませんでした: ${error.message}`;
}

if (route === '/' || route === '/camera') {
  initDirectCamera();
} else if (route === '/broadcast') {
  initBroadcaster();
} else if (route === '/viewer') {
  initViewer();
} else {
  window.location.replace('/');
}

async function initBroadcaster() {
  $('#broadcastPanel').hidden = false;
  const startButton = $('#startBroadcast');
  const empty = $('#broadcastEmpty');
  const localVideo = $('#localVideo');
  const viewerCount = $('#viewerCount');
  const viewerUrl = $('#viewerUrl');
  const remoteCursor = $('#remoteCursor');
  const controllerState = $('#macControllerState');
  const cameraSelect = $('#broadcastCameraSelect');
  const peers = new Map();
  let localStream = null;
  let polling = false;

  let questUrl = `http://${location.hostname}:5324/viewer`;
  api('/api/health')
    .then(({ addresses }) => {
      const preferred =
        addresses.find(({ name }) => name === 'en0') ||
        addresses.find(({ address }) => !address.startsWith('169.254.'));
      if (preferred) questUrl = `http://${preferred.address}:5324/viewer`;
      viewerUrl.textContent = questUrl;
    })
    .catch(() => {
      viewerUrl.textContent = questUrl;
    });

  $('#copyUrl').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(questUrl);
      showToast('Quest用URLをコピーしました');
    } catch {
      showToast('URLを長押ししてコピーしてください');
    }
  });

  async function refreshBroadcastCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(({ kind }) => kind === 'videoinput');
    const previous = cameraSelect.value;
    cameraSelect.innerHTML = '<option value="">自動選択（Insta360優先）</option>';
    cameras.forEach((camera, index) => {
      const option = document.createElement('option');
      option.value = camera.deviceId;
      option.textContent = camera.label || `カメラ ${index + 1}`;
      cameraSelect.append(option);
    });
    const insta360 = cameras.find(({ label }) => /insta\s*360|x4/i.test(label));
    cameraSelect.value = cameras.some(({ deviceId }) => deviceId === previous)
      ? previous
      : (insta360?.deviceId || '');
  }

  refreshBroadcastCameras().catch(() => {});

  startButton.addEventListener('click', async () => {
    startButton.disabled = true;
    setStatus('カメラを準備中');
    try {
      if (!cameraSelect.value) {
        const permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        permissionStream.getTracks().forEach((track) => track.stop());
        await refreshBroadcastCameras();
      }
      const deviceId = cameraSelect.value || undefined;
      localStream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          width: { ideal: 2880 },
          height: { ideal: 1440 },
          aspectRatio: { ideal: 2 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      });
      localVideo.srcObject = localStream;
      empty.hidden = true;
      setStatus('配信待機中', 'live');
      polling = true;
      pollForViewers();
    } catch (error) {
      console.error(error);
      setStatus('カメラエラー', 'error');
      showToast(describeMediaError(error));
      startButton.disabled = false;
    }
  });

  async function pollForViewers() {
    while (polling) {
      try {
        const { sessions } = await api('/api/sessions');
        for (const session of sessions) {
          if (!peers.has(session.id)) await acceptViewer(session);
        }
      } catch (error) {
        console.error(error);
        setStatus('サーバー再接続中', 'error');
      }
      await delay(900);
    }
  }

  async function acceptViewer(session) {
    const pc = new RTCPeerConnection(peerConfig);
    const state = { pc, appliedCandidates: new Set(), candidateTimer: null };
    peers.set(session.id, state);
    viewerCount.textContent = peers.size;

    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    pc.ondatachannel = ({ channel }) => {
      if (channel.label !== 'quest-controls') return;
      state.controlChannel = channel;
      channel.onopen = () => {
        controllerState.textContent = '入力待機中';
      };
      channel.onmessage = ({ data }) => {
        try {
          applyQuestControl(JSON.parse(data));
        } catch (error) {
          console.error('Controller data error', error);
        }
      };
      channel.onclose = () => {
        remoteCursor.hidden = true;
        controllerState.textContent = '未接続';
      };
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        api(`/api/sessions/${session.id}/candidate`, {
          method: 'POST',
          body: JSON.stringify({ role: 'broadcaster', candidate: candidate.toJSON() }),
        }).catch(console.error);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setStatus('配信中', 'live');
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        clearInterval(state.candidateTimer);
        pc.close();
        peers.delete(session.id);
        viewerCount.textContent = peers.size;
        if (peers.size === 0) setStatus('配信待機中', 'live');
      }
    };

    try {
      await pc.setRemoteDescription(session.offer);
      await applyRemoteCandidates(session.id, state, 'broadcaster');
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await api(`/api/sessions/${session.id}/answer`, {
        method: 'POST',
        body: JSON.stringify({ answer: pc.localDescription }),
      });
      state.candidateTimer = setInterval(
        () => applyRemoteCandidates(session.id, state, 'broadcaster'),
        700,
      );
    } catch (error) {
      console.error(error);
      pc.close();
      peers.delete(session.id);
      viewerCount.textContent = peers.size;
    }
  }

  function applyQuestControl(input) {
    if (input.type !== 'control') return;
    remoteCursor.hidden = false;
    remoteCursor.style.left = `${Math.max(0, Math.min(1, input.x)) * 100}%`;
    remoteCursor.style.top = `${Math.max(0, Math.min(1, input.y)) * 100}%`;
    remoteCursor.classList.toggle('pressed', Boolean(input.buttons?.trigger));
    controllerState.textContent = input.source || 'Questコントローラー';
    $('#lampTrigger').classList.toggle('active', Boolean(input.buttons?.trigger));
    $('#lampPrimary').classList.toggle('active', Boolean(input.buttons?.primary));
    $('#lampSecondary').classList.toggle('active', Boolean(input.buttons?.secondary));
  }

  window.addEventListener('beforeunload', () => {
    polling = false;
    localStream?.getTracks().forEach((track) => track.stop());
    peers.forEach(({ pc, candidateTimer }) => {
      clearInterval(candidateTimer);
      pc.close();
    });
  });
}

async function applyRemoteCandidates(sessionId, state, role) {
  const session = await api(`/api/sessions/${sessionId}?role=${role}`);
  for (const candidate of session.candidates || []) {
    const key = `${candidate.candidate}|${candidate.sdpMid}|${candidate.sdpMLineIndex}`;
    if (state.appliedCandidates.has(key)) continue;
    try {
      await state.pc.addIceCandidate(candidate);
      state.appliedCandidates.add(key);
    } catch (error) {
      if (role === 'viewer') console.error('ICE candidate error', error);
    }
  }
  return session;
}

function createWebXR360Renderer(canvas, video, button, hint) {
  let session = null;
  let gl = null;
  let program = null;
  let texture = null;
  let vertexCount = 0;
  let referenceSpace = null;
  let supported = false;
  let videoReady = false;

  const multiply = (a, b) => {
    const out = new Float32Array(16);
    for (let column = 0; column < 4; column += 1) {
      for (let row = 0; row < 4; row += 1) {
        for (let k = 0; k < 4; k += 1) {
          out[row + column * 4] += a[row + k * 4] * b[k + column * 4];
        }
      }
    }
    return out;
  };

  async function checkSupport() {
    if (!window.isSecureContext) {
      hint.textContent = 'WebXRにはHTTPSが必要です。QuestではHTTPSのURLを開いてください。';
      button.textContent = 'HTTPSが必要です';
      return;
    }
    if (!navigator.xr) {
      hint.textContent = 'このブラウザはWebXR immersive-vrに対応していません。Quest Browserで開いてください。';
      button.textContent = 'WebXR非対応';
      return;
    }
    supported = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
    hint.textContent = supported
      ? '映像接続後、「VRで見る」を押すとヘッドトラッキングが始まります。'
      : 'immersive-vrを利用できません。Quest Browserの設定を確認してください。';
    updateButton();
  }

  function updateButton() {
    button.disabled = !supported || !videoReady || Boolean(session);
    button.textContent = session ? 'VR表示中' : (supported && videoReady ? 'VRで見る' : '映像接続後にVRへ入る');
  }

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  function initializeGL() {
    gl = canvas.getContext('webgl', { alpha: false, antialias: true, xrCompatible: true });
    if (!gl) throw new Error('WebGLを初期化できません。');
    const vertexShader = compile(gl.VERTEX_SHADER, 'attribute vec3 p; attribute vec2 uv; uniform mat4 mvp; varying vec2 v; void main(){gl_Position=mvp*vec4(p,1.0);v=uv;}');
    const fragmentShader = compile(gl.FRAGMENT_SHADER, 'precision mediump float; uniform sampler2D tex; varying vec2 v; void main(){gl_FragColor=texture2D(tex,vec2(v.x,1.0-v.y));}');
    program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('WebXRシェーダーを初期化できません。');

    const vertices = [];
    const rows = 64;
    const columns = 128;
    const point = (azimuth, latitude) => [
      -10 * Math.cos(latitude) * Math.sin(azimuth),
      10 * Math.sin(latitude),
      -10 * Math.cos(latitude) * Math.cos(azimuth),
    ];
    for (let y = 0; y < rows; y += 1) {
      const v0 = y / rows;
      const v1 = (y + 1) / rows;
      const latitude0 = (v0 - 0.5) * Math.PI;
      const latitude1 = (v1 - 0.5) * Math.PI;
      for (let x = 0; x < columns; x += 1) {
        const u0 = x / columns;
        const u1 = (x + 1) / columns;
        const a = point(u0 * Math.PI * 2, latitude0);
        const b = point(u1 * Math.PI * 2, latitude0);
        const c = point(u1 * Math.PI * 2, latitude1);
        const d = point(u0 * Math.PI * 2, latitude1);
        vertices.push(...a, u0, v0, ...b, u1, v0, ...c, u1, v1, ...a, u0, v0, ...c, u1, v1, ...d, u0, v1);
      }
    }
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    gl.useProgram(program);
    const position = gl.getAttribLocation(program, 'p');
    const uv = gl.getAttribLocation(program, 'uv');
    gl.enableVertexAttribArray(position);
    gl.enableVertexAttribArray(uv);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 20, 0);
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 20, 12);
    vertexCount = vertices.length / 5;
    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
  }

  function renderXRFrame(time, frame) {
    const currentSession = frame.session;
    currentSession.requestAnimationFrame(renderXRFrame);
    const pose = frame.getViewerPose(referenceSpace);
    if (!pose || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const layer = currentSession.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    for (const view of pose.views) {
      const viewport = layer.getViewport(view);
      gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
      const mvp = multiply(view.projectionMatrix, view.transform.inverse.matrix);
      gl.uniformMatrix4fv(gl.getUniformLocation(program, 'mvp'), false, mvp);
      gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
    }
  }

  async function enterVR() {
    try {
      session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
      if (!gl) initializeGL();
      await gl.makeXRCompatible();
      session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
      referenceSpace = await session.requestReferenceSpace('local');
      session.addEventListener('end', () => { session = null; updateButton(); });
      updateButton();
      session.requestAnimationFrame(renderXRFrame);
    } catch (error) {
      session = null;
      updateButton();
      hint.textContent = `VRを開始できませんでした: ${error.message}`;
    }
  }

  button.addEventListener('click', enterVR);
  checkSupport();
  return {
    setVideoReady(ready) { videoReady = ready; updateButton(); },
    end() { session?.end().catch(() => {}); },
  };
}

function initViewer() {
  $('#viewerPanel').hidden = false;
  const connectButton = $('#connectViewer');
  const reconnectButton = $('#reconnectButton');
  const empty = $('#viewerEmpty');
  const remoteVideo = $('#remoteVideo');
  const leftEye = $('#leftEye');
  const rightEye = $('#rightEye');
  const stage = $('#viewerStage');
  const xrRenderer = createWebXR360Renderer(
    $('#xrCanvas'),
    remoteVideo,
    $('#enterVrButton'),
    $('#webxrHint'),
  );
  let pc = null;
  let sessionId = null;
  let pollTimer = null;
  let appliedCandidates = new Set();
  let pendingLocalCandidates = [];
  let controlChannel = null;
  let controlFrame = null;
  let pointerX = 0.5;
  let pointerY = 0.5;
  let lastSentAt = 0;
  let inputSource = 'Questポインター';
  const controlButtons = { trigger: false, primary: false, secondary: false };

  connectButton.addEventListener('click', connect);
  reconnectButton.addEventListener('click', connect);
  $('#fullscreenButton').addEventListener('click', enterFullscreen);
  $('#monoButton').addEventListener('click', () => setViewMode(false));
  $('#stereoButton').addEventListener('click', () => setViewMode(true));
  setupControllerInput();

  async function connect() {
    cleanup();
    connectButton.disabled = true;
    reconnectButton.hidden = true;
    setStatus('Macを検索中');
    try {
      pc = new RTCPeerConnection(peerConfig);
      pc.addTransceiver('video', { direction: 'recvonly' });
      controlChannel = pc.createDataChannel('quest-controls', {
        ordered: false,
        maxRetransmits: 0,
      });
      controlChannel.onopen = () => {
        $('#questControllerStatus').dataset.active = 'true';
        $('#questControllerText').textContent = 'Macへ入力送信中';
        sendControl(true);
      };
      controlChannel.onclose = () => {
        $('#questControllerStatus').dataset.active = 'false';
        $('#questControllerText').textContent = '入力が切断されました';
      };

      pc.ontrack = async ({ streams }) => {
        const [stream] = streams;
        remoteVideo.srcObject = stream;
        leftEye.srcObject = stream;
        rightEye.srcObject = stream;
        empty.hidden = true;
        await Promise.allSettled([remoteVideo.play(), leftEye.play(), rightEye.play()]);
        xrRenderer.setVideoReady(true);
      };

      pc.onicecandidate = ({ candidate }) => {
        if (!candidate) return;
        const serialized = candidate.toJSON();
        if (!sessionId) {
          pendingLocalCandidates.push(serialized);
          return;
        }
        sendViewerCandidate(serialized);
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setStatus('接続済み', 'live');
          connectButton.disabled = false;
        }
        if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
          setStatus('切断されました', 'error');
          reconnectButton.hidden = false;
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const created = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ offer: pc.localDescription }),
      });
      sessionId = created.id;
      pendingLocalCandidates.forEach(sendViewerCandidate);
      pendingLocalCandidates = [];
      setStatus('Macの応答待ち');
      await waitForAnswer();
    } catch (error) {
      console.error(error);
      setStatus('接続できません', 'error');
      showToast(error.message);
      connectButton.disabled = false;
      reconnectButton.hidden = false;
    }
  }

  function setupControllerInput() {
    const pad = $('#controlPad');

    const updatePointer = (event) => {
      const rect = pad.getBoundingClientRect();
      pointerX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      pointerY = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      inputSource = event.pointerType === 'touch' ? 'Questタッチ操作' : 'Questコントローラー';
      sendControl();
    };

    pad.addEventListener('pointerenter', () => pad.classList.add('active'));
    pad.addEventListener('pointerleave', () => pad.classList.remove('active'));
    pad.addEventListener('pointermove', updatePointer);
    pad.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      pad.setPointerCapture?.(event.pointerId);
      updatePointer(event);
      controlButtons.trigger = true;
      sendControl(true);
    });
    const releaseTrigger = () => {
      controlButtons.trigger = false;
      sendControl(true);
    };
    pad.addEventListener('pointerup', releaseTrigger);
    pad.addEventListener('pointercancel', releaseTrigger);

    document.querySelectorAll('[data-quest-button]').forEach((button) => {
      const name = button.dataset.questButton;
      const press = (event) => {
        event.preventDefault();
        controlButtons[name] = true;
        button.classList.add('active');
        inputSource = 'Questボタン';
        sendControl(true);
      };
      const release = (event) => {
        event.preventDefault();
        controlButtons[name] = false;
        button.classList.remove('active');
        sendControl(true);
      };
      button.addEventListener('pointerdown', press);
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
      button.addEventListener('pointerleave', (event) => {
        if (controlButtons[name]) release(event);
      });
    });

    document.addEventListener('keydown', (event) => {
      const movement = { ArrowLeft: [-0.04, 0], ArrowRight: [0.04, 0], ArrowUp: [0, -0.04], ArrowDown: [0, 0.04] }[event.key];
      if (movement) {
        event.preventDefault();
        pointerX = Math.max(0, Math.min(1, pointerX + movement[0]));
        pointerY = Math.max(0, Math.min(1, pointerY + movement[1]));
        inputSource = 'Quest方向キー';
        sendControl(true);
      }
      if (event.key === 'Enter' || event.key === ' ') {
        controlButtons.trigger = true;
        sendControl(true);
      }
    });
    document.addEventListener('keyup', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        controlButtons.trigger = false;
        sendControl(true);
      }
    });

    controlFrame = requestAnimationFrame(pollGamepads);
  }

  function pollGamepads(timestamp) {
    const gamepads = navigator.getGamepads?.() || [];
    const gamepad = [...gamepads].find(Boolean);
    if (gamepad) {
      const axes = gamepad.axes || [];
      const axisX = axes.length >= 2 ? axes[axes.length - 2] : 0;
      const axisY = axes.length >= 2 ? axes[axes.length - 1] : 0;
      const deadzone = (value) => (Math.abs(value) > 0.16 ? value : 0);
      const dt = Math.min(40, Math.max(0, timestamp - (pollGamepads.lastTime || timestamp)));
      pointerX = Math.max(0, Math.min(1, pointerX + deadzone(axisX) * dt * 0.00055));
      pointerY = Math.max(0, Math.min(1, pointerY + deadzone(axisY) * dt * 0.00055));
      controlButtons.trigger = Boolean(gamepad.buttons?.[0]?.pressed);
      controlButtons.primary = Boolean(gamepad.buttons?.[4]?.pressed);
      controlButtons.secondary = Boolean(gamepad.buttons?.[5]?.pressed);
      inputSource = gamepad.mapping === 'xr-standard' ? 'Questスティック' : 'ゲームパッド';
      sendControl();
    }
    pollGamepads.lastTime = timestamp;
    controlFrame = requestAnimationFrame(pollGamepads);
  }

  function sendControl(force = false) {
    if (!controlChannel || controlChannel.readyState !== 'open') return;
    const now = performance.now();
    if (!force && now - lastSentAt < 32) return;
    lastSentAt = now;
    controlChannel.send(JSON.stringify({
      type: 'control',
      x: pointerX,
      y: pointerY,
      buttons: controlButtons,
      source: inputSource,
    }));
  }

  function sendViewerCandidate(candidate) {
    api(`/api/sessions/${sessionId}/candidate`, {
      method: 'POST',
      body: JSON.stringify({ role: 'viewer', candidate }),
    }).catch(console.error);
  }

  async function waitForAnswer() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && pc) {
      const session = await applyRemoteCandidates(sessionId, { pc, appliedCandidates }, 'viewer');
      if (session.answer && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription(session.answer);
      }
      if (pc.currentRemoteDescription) {
        pollTimer = setInterval(
          () => applyRemoteCandidates(sessionId, { pc, appliedCandidates }, 'viewer').catch(console.error),
          700,
        );
        return;
      }
      await delay(600);
    }
    throw new Error('Macから応答がありません。Mac側で配信が開始されているか確認してください。');
  }

  function setViewMode(stereo) {
    $('#monoView').hidden = stereo;
    $('#stereoView').hidden = !stereo;
    $('#monoButton').classList.toggle('active', !stereo);
    $('#stereoButton').classList.toggle('active', stereo);
    $('#monoButton').setAttribute('aria-pressed', String(!stereo));
    $('#stereoButton').setAttribute('aria-pressed', String(stereo));
  }

  async function enterFullscreen() {
    try {
      if (!document.fullscreenElement) await stage.requestFullscreen();
      if (screen.orientation?.lock) await screen.orientation.lock('landscape').catch(() => {});
    } catch (error) {
      showToast('ブラウザのメニューから全画面表示を選んでください');
    }
  }

  function cleanup() {
    clearInterval(pollTimer);
    pollTimer = null;
    if (sessionId) {
      fetch(`/api/sessions/${sessionId}/close`, { method: 'POST' }).catch(() => {});
    }
    pc?.close();
    pc = null;
    controlChannel = null;
    sessionId = null;
    appliedCandidates = new Set();
    pendingLocalCandidates = [];
    xrRenderer.setVideoReady(false);
    xrRenderer.end();
  }

  window.addEventListener('beforeunload', cleanup);
  window.addEventListener('beforeunload', () => cancelAnimationFrame(controlFrame));
}

// Direct local-camera mode for Insta360 X4. The renderer deliberately uses raw WebGL
// so the app works offline and does not need a three.js CDN.
function initDirectCamera() {
  const panel = $('#cameraPanel');
  panel.hidden = false;
  const canvas = $('#sphereCanvas');
  const video = $('#cameraVideo');
  const stage = $('#cameraStage');
  const empty = $('#cameraEmpty');
  const select = $('#cameraSelect');
  const start = $('#startCamera');
  const connect = $('#startSelectedCamera');
  let stream = null;
  let gl = null;
  let program = null;
  let texture = null;
  let raf = 0;
  let yaw = 0;
  let pitch = 0;
  let fov = 75;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const setDiag = (id, value) => { const el = $(`#${id}`); if (el) el.textContent = value; };
  const setError = (message) => {
    setStatus('カメラエラー', 'error');
    setDiag('diagState', 'エラー');
    $('#cameraHint').textContent = message;
    showToast(message);
  };
  const mediaError = (error) => {
    if (error.name === 'NotAllowedError') return 'カメラの使用が拒否されました。ブラウザのサイト設定で許可してください。';
    if (error.name === 'NotFoundError') return 'カメラが見つかりません。X4のUSBモードを確認してください。';
    if (error.name === 'OverconstrainedError') return '2880×1440を指定できませんでした。通常解像度で再試行してください。';
    if (error.name === 'NotReadableError') return 'カメラを開けません。他のアプリが使用していないか確認してください。';
    return `カメラを開始できませんでした: ${error.message || error.name}`;
  };

  function initGL() {
    gl = canvas.getContext('webgl', { alpha: false, antialias: true });
    if (!gl) throw new Error('このブラウザはWebGLに対応していません。');
    const vs = `attribute vec3 p; attribute vec2 uv; uniform mat4 m; varying vec2 v; void main(){gl_Position=m*vec4(p,1.0);v=uv;}`;
    // Browser video frames use a top-left origin, while the sphere UVs use a
    // bottom-left origin. Flip V so the equirectangular image is upright.
    const fs = `precision mediump float; uniform sampler2D tex; varying vec2 v; void main(){gl_FragColor=texture2D(tex,vec2(v.x,1.0-v.y));}`;
    const compile = (type, source) => { const s=gl.createShader(type); gl.shaderSource(s,source); gl.compileShader(s); if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    program = gl.createProgram(); gl.attachShader(program, compile(gl.VERTEX_SHADER,vs)); gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fs)); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('360°表示の初期化に失敗しました。');
    const verts=[]; const rows=48; const cols=96;
    for(let y=0;y<rows;y++){const v0=y/rows,v1=(y+1)/rows, p0=(v0-.5)*Math.PI,p1=(v1-.5)*Math.PI; for(let x=0;x<cols;x++){const u0=x/cols,u1=(x+1)/cols,a0=u0*Math.PI*2,a1=u1*Math.PI*2; const q=(a,p)=>[-Math.cos(p)*Math.sin(a),Math.sin(p),-Math.cos(p)*Math.cos(a)]; const a=q(a0,p0),b=q(a1,p0),c=q(a1,p1),d=q(a0,p1); verts.push(...a,u0,v0,...b,u1,v0,...c,u1,v1,...a,u0,v0,...c,u1,v1,...d,u0,v1);}}
    const buffer=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buffer); gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(verts),gl.STATIC_DRAW);
    gl.useProgram(program); const p=gl.getAttribLocation(program,'p'), uv=gl.getAttribLocation(program,'uv'); gl.enableVertexAttribArray(p); gl.enableVertexAttribArray(uv); gl.vertexAttribPointer(p,3,gl.FLOAT,false,20,0); gl.vertexAttribPointer(uv,2,gl.FLOAT,false,20,12); gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); texture=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,texture); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE); canvas._count=verts.length/5;
  }
  const mat = (a) => { const c=Math.cos(a),s=Math.sin(a); return [c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1]; };
  function render() { if(!gl || video.readyState<2){raf=requestAnimationFrame(render);return;} const d=window.devicePixelRatio||1,w=canvas.clientWidth*d,h=canvas.clientHeight*d; if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;gl.viewport(0,0,w,h);} const aspect=w/h, near=.01, far=10, t=1/Math.tan(fov*Math.PI/360), proj=[t/aspect,0,0,0,0,t,0,0,0,0,(far+near)/(near-far),-1,0,0,2*far*near/(near-far),0]; const ry=mat(yaw), cp=Math.cos(pitch),sp=Math.sin(pitch), rx=[1,0,0,0,0,cp,-sp,0,0,sp,cp,0,0,0,0,1]; const mul=(a,b)=>{const o=new Array(16).fill(0);for(let i=0;i<4;i++)for(let j=0;j<4;j++)for(let k=0;k<4;k++)o[i+j*4]+=a[i+k*4]*b[k+j*4];return o;}; gl.useProgram(program); gl.uniformMatrix4fv(gl.getUniformLocation(program,'m'),false,new Float32Array(mul(proj,mul(rx,ry)))); gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,video);gl.drawArrays(gl.TRIANGLES,0,canvas._count);raf=requestAnimationFrame(render); }
  async function listCameras() { if(!navigator.mediaDevices?.enumerateDevices) throw new Error('このブラウザはカメラAPIに対応していません。'); const devices=await navigator.mediaDevices.enumerateDevices(); const cams=devices.filter(d=>d.kind==='videoinput'); select.innerHTML=''; cams.forEach((cam,i)=>{const o=document.createElement('option');o.value=cam.deviceId;o.textContent=cam.label||`カメラ ${i+1}`;select.append(o);}); if(!cams.length) select.innerHTML='<option>カメラが見つかりません</option>'; }
  async function startCamera() { connect.disabled=true; setStatus('カメラを準備中'); setDiag('diagState','接続中'); try { stream?.getTracks().forEach(t=>t.stop()); const deviceId=select.value && select.value!=='未選択' ? select.value : undefined; stream=await navigator.mediaDevices.getUserMedia({video:{...(deviceId?{deviceId:{exact:deviceId}}:{}),width:{ideal:2880},height:{ideal:1440},frameRate:{ideal:30,max:30}},audio:false}); video.srcObject=stream; await video.play(); const track=stream.getVideoTracks()[0], settings=track.getSettings(); setDiag('diagState','ライブ'); setDiag('diagResolution',`${settings.width||'—'} × ${settings.height||'—'}`); setDiag('diagFrameRate',settings.frameRate?`${settings.frameRate.toFixed(1)} fps`:'—'); setDiag('diagFormat',(settings.width&&settings.height&&Math.abs(settings.width/settings.height-2)<.08)?'2:1 equirectangular':'通常映像（要確認）'); $('#cameraHint').textContent='映像をドラッグして見回せます。2:1以外の場合は360°にならないことがあります。'; $('#cameraLiveDot').classList.add('live'); $('#cameraHudText').textContent='LIVE'; empty.hidden=true; setStatus('配信中','live'); await listCameras(); } catch(e) { console.error(e); setError(mediaError(e)); } finally { connect.disabled=false; } }
  start.addEventListener('click',async()=>{try{await navigator.mediaDevices.getUserMedia({video:true,audio:false}).then(s=>s.getTracks().forEach(t=>t.stop())); await listCameras(); startCamera();}catch(e){setError(mediaError(e));}}); connect.addEventListener('click',startCamera); $('#cameraFullscreen').addEventListener('click',async()=>{try{await stage.requestFullscreen();}catch{showToast('ブラウザのメニューから全画面表示を選んでください');}});
  stage.addEventListener('pointerdown',e=>{dragging=true;lastX=e.clientX;lastY=e.clientY;stage.setPointerCapture?.(e.pointerId);}); stage.addEventListener('pointermove',e=>{if(!dragging)return; yaw+=(e.clientX-lastX)*.006; pitch=Math.max(-1.45,Math.min(1.45,pitch+(e.clientY-lastY)*.006));lastX=e.clientX;lastY=e.clientY;}); stage.addEventListener('pointerup',()=>{dragging=false;}); stage.addEventListener('wheel',e=>{e.preventDefault();fov=Math.max(35,Math.min(105,fov+e.deltaY*.04));},{passive:false});
  try { initGL(); render(); listCameras().catch(()=>{}); } catch(e) { setError(e.message); }
  window.addEventListener('beforeunload',()=>{cancelAnimationFrame(raf);stream?.getTracks().forEach(t=>t.stop());});
}
