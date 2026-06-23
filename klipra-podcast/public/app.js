// Global Application State
let socket = null;
let localStream = null;
let remoteStream = null;
let screenStream = null;
let peerConnection = null;
let activeTunnelUrl = null;
let remoteIceCandidatesQueue = [];

// Recording variables
let mediaRecorder = null;
let recordedChunks = [];
let fileHandle = null;
let fileWritable = null;
let isRecording = false;
let recordingStartTime = 0;
let timerInterval = null;

// IndexedDB database variables for crash recovery
const DB_NAME = 'KlipraPodcastDB';
const STORE_NAME = 'recording_cache';
let db = null;

// Audio variables
let audioContext = null;
let localAnalyser = null;
let remoteAnalyser = null;

// Screen Sharing states
let isScreenSharing = false;
let activeLayout = 'grid'; // grid, theater, pip
let currentRoleHost = true; // Host or Guest

// Annotation/Drawing variables
let drawingActive = false;
let currentTool = 'pen'; // pen, text
let currentColor = '#ff4757';
let lastX = 0;
let lastY = 0;
let isDrawing = false;
let canvasCtx = null;
let annotationCanvas = null;

// Video Processing / Blur Variables
let blurEnabled = false;
let videoElement = null;
let processedCanvas = null;
let processedCtx = null;
let processedStream = null;
let animationFrameId = null;

// Config options
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:relay.metered.ca:80' },
    { urls: 'stun:stun.relay.metered.ca:80' },
    {
      urls: 'turn:relay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:relay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:relay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turns:relay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};

// UI Elements
const lobbyView = document.getElementById('lobby-view');
const studioView = document.getElementById('studio-view');
const videoSource = document.getElementById('video-source');
const audioSource = document.getElementById('audio-source');
const usernameInput = document.getElementById('username');
const roomIdInput = document.getElementById('room-id');
const enterStudioBtn = document.getElementById('enter-studio-btn');
const lobbyPreviewVideo = document.getElementById('lobby-preview-video');
const lobbyPreviewCanvas = document.getElementById('lobby-preview-canvas');
const micTestProgress = document.getElementById('mic-test-progress');
const blurToggle = document.getElementById('blur-background');

const displayRoomName = document.getElementById('display-room-name');
const recordingIndicator = document.getElementById('recording-indicator');
const recordingText = document.getElementById('recording-text');
const recordingTimer = document.getElementById('recording-timer');
const guestSyncStatus = document.getElementById('guest-sync-status');
const localVideo = document.getElementById('local-video');
const localVideoCanvas = document.getElementById('local-video-canvas');
const remoteVideo = document.getElementById('remote-video');
const guestPlaceholder = document.getElementById('guest-placeholder');
const localName = document.getElementById('local-name');
const remoteName = document.getElementById('remote-name');
const localRecBadge = document.getElementById('local-rec-badge');
const remoteRecBadge = document.getElementById('remote-rec-badge');

let dynamicRtcConfig = null;

const recordBtn = document.getElementById('record-btn');
const muteMicBtn = document.getElementById('mute-mic-btn');
const muteVideoBtn = document.getElementById('mute-video-btn');
const screenShareBtn = document.getElementById('screen-share-btn');
const tracksList = document.getElementById('tracks-list');
const consoleOutput = document.getElementById('console-output');

// Crash Recovery elements
const recoveryOverlay = document.getElementById('recovery-overlay');
const recoverDownloadBtn = document.getElementById('recover-download-btn');
const recoverDiscardBtn = document.getElementById('recover-discard-btn');

// Grid & Drawing Card elements
const mainVideoGrid = document.getElementById('main-video-grid');
const cardScreen = document.getElementById('card-screen');
const screenVideo = document.getElementById('screen-video');

// Initial Setup
window.addEventListener('load', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  const roleParam = urlParams.get('role');

  if (roomParam) {
    roomIdInput.value = roomParam;
  }
  if (roleParam === 'guest') {
    setRole(false);
    usernameInput.value = "Guest User";
    // Hide the tab selector so the guest cannot switch role to Host
    const tabSelector = document.querySelector('.tab-selector');
    if (tabSelector) {
      tabSelector.style.display = 'none';
    }
  } else {
    setRole(true);
  }



  // Enumerate inputs
  await requestMediaPermissions();
  await getDevices();
  
  // Initialize IndexedDB database for crash backup
  initIndexedDB();

  // Bind Listeners
  videoSource.addEventListener('change', startLobbyPreview);
  audioSource.addEventListener('change', startLobbyPreview);
  blurToggle.addEventListener('change', toggleLobbyBlur);
  enterStudioBtn.addEventListener('click', enterStudio);
  recordBtn.addEventListener('click', toggleRecording);
  muteMicBtn.addEventListener('click', toggleLocalMuteMic);
  muteVideoBtn.addEventListener('click', toggleLocalMuteVideo);
  screenShareBtn.addEventListener('click', toggleScreenShare);

  // Initialize Lobby preview
  startLobbyPreview();
  setupAnnotationDrawingListeners();
});

// Initialize IndexedDB
function initIndexedDB() {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = (e) => {
    db = e.target.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME, { autoIncrement: true });
    }
  };
  request.onsuccess = (e) => {
    db = e.target.result;
    logToConsole("IndexedDB initialized.", "green");
    checkForCrashedSession();
  };
  request.onerror = () => {
    logToConsole("IndexedDB failed to load. Crash backup unavailable.", "red");
  };
}

// Check if unsaved recording chunks exist in database
function checkForCrashedSession() {
  if (!db) return;
  const transaction = db.transaction([STORE_NAME], 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  const countRequest = store.count();

  countRequest.onsuccess = () => {
    if (countRequest.result > 0) {
      logToConsole("Unsaved recording cache detected!", "yellow");
      recoveryOverlay.classList.remove('hidden');

      // Bind recovery action handlers
      recoverDownloadBtn.onclick = downloadRecoveredRecording;
      recoverDiscardBtn.onclick = discardRecoveredRecording;
    }
  };
}

// Download recovered chunks
function downloadRecoveredRecording() {
  const transaction = db.transaction([STORE_NAME], 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  const getAllRequest = store.getAll();

  getAllRequest.onsuccess = () => {
    const chunks = getAllRequest.result;
    if (chunks.length > 0) {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      a.download = `recovered_recording_${Date.now()}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      logToConsole("Recording recovered and downloaded successfully.", "green");
      discardRecoveredRecording();
    }
  };
}

// Discard recovered chunks
function discardRecoveredRecording() {
  const transaction = db.transaction([STORE_NAME], 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const clearRequest = store.clear();

  clearRequest.onsuccess = () => {
    logToConsole("Recovery cache cleared.", "blue");
    recoveryOverlay.classList.add('hidden');
  };
}

// Set Host/Guest role status in Lobby
function setRole(isUserHost) {
  currentRoleHost = isUserHost;
  const hostTab = document.getElementById('tab-host');
  const guestTab = document.getElementById('tab-guest');
  
  if (currentRoleHost) {
    hostTab.classList.add('active');
    guestTab.classList.remove('active');
    document.body.classList.add('role-host');
    if (usernameInput.value === "Guest User") {
      usernameInput.value = "Host User";
    }
    logToConsole("Switched role to: HOST", "blue");
  } else {
    hostTab.classList.remove('active');
    guestTab.classList.add('active');
    document.body.classList.remove('role-host');
    if (usernameInput.value === "Host User") {
      usernameInput.value = "Guest User";
    }
    logToConsole("Switched role to: GUEST", "blue");
  }
}

// Request Initial permissions
async function requestMediaPermissions() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    stream.getTracks().forEach(track => track.stop());
    logToConsole("Camera & Microphone permissions granted.", "green");
  } catch (err) {
    logToConsole("Permissions denied or media devices missing: " + err.message, "red");
  }
}

// Enumerate Devices
async function getDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoSource.innerHTML = '';
    audioSource.innerHTML = '';

    devices.forEach(device => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      if (device.kind === 'videoinput') {
        option.text = device.label || `Camera ${videoSource.length + 1}`;
        videoSource.appendChild(option);
      } else if (device.kind === 'audioinput') {
        option.text = device.label || `Microphone ${audioSource.length + 1}`;
        audioSource.appendChild(option);
      }
    });
  } catch (err) {
    logToConsole("Error listing devices: " + err.message, "red");
  }
}

// Lobby Preview Stream
async function startLobbyPreview() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  const videoId = videoSource.value;
  const audioId = audioSource.value;

  const constraints = {
    video: videoId ? { deviceId: { exact: videoId } } : true,
    audio: audioId ? { deviceId: { exact: audioId } } : true
  };

  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    videoElement = lobbyPreviewVideo;
    videoElement.srcObject = localStream;
    
    toggleLobbyBlur();
    setupLobbyAudioMonitor(localStream);
  } catch (err) {
    logToConsole("Lobby Preview capture failed: " + err.message, "red");
  }
}

// Toggle background blur on lobby camera preview
function toggleLobbyBlur() {
  blurEnabled = blurToggle.checked;
  
  if (blurEnabled) {
    lobbyPreviewVideo.style.display = 'none';
    lobbyPreviewCanvas.style.display = 'block';
    
    processedCanvas = lobbyPreviewCanvas;
    processedCtx = processedCanvas.getContext('2d');
    
    applyBackgroundBlurLoop();
  } else {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    lobbyPreviewCanvas.style.display = 'none';
    lobbyPreviewVideo.style.display = 'block';
  }
}

// Simulated background blur via vignette blur shaders on canvas context
function applyBackgroundBlurLoop() {
  if (!blurEnabled) return;

  function renderFrame() {
    if (!blurEnabled || !videoElement) return;

    if (videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
      processedCanvas.width = videoElement.videoWidth || 640;
      processedCanvas.height = videoElement.videoHeight || 360;
      
      const w = processedCanvas.width;
      const h = processedCanvas.height;

      // Draw original webcam frame
      processedCtx.filter = 'none';
      processedCtx.drawImage(videoElement, 0, 0, w, h);

      // Create a blur vignette layer
      processedCtx.save();
      processedCtx.filter = 'blur(16px)';
      
      processedCtx.beginPath();
      processedCtx.arc(w / 2, h / 2, Math.min(w, h) * 0.38, 0, Math.PI * 2);
      processedCtx.rect(w, 0, -w, h);
      processedCtx.clip();
      
      processedCtx.drawImage(videoElement, 0, 0, w, h);
      processedCtx.restore();
    }
    animationFrameId = requestAnimationFrame(renderFrame);
  }

  animationFrameId = requestAnimationFrame(renderFrame);
}

// Lobby audio visual progress bar
let lobbyAudioInterval = null;
function setupLobbyAudioMonitor(stream) {
  if (lobbyAudioInterval) clearInterval(lobbyAudioInterval);

  try {
    const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = tempCtx.createMediaStreamSource(stream);
    const analyser = tempCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    lobbyAudioInterval = setInterval(() => {
      analyser.getByteFrequencyData(dataArray);
      let total = 0;
      for (let i = 0; i < bufferLength; i++) {
        total += dataArray[i];
      }
      const average = total / bufferLength;
      const progressPercent = Math.min(100, (average / 128) * 100);
      micTestProgress.style.width = `${progressPercent}%`;
    }, 100);

    stream.getAudioTracks()[0].addEventListener('ended', () => {
      clearInterval(lobbyAudioInterval);
      tempCtx.close();
    });
  } catch (e) {
    // Ignore context errors
  }
}

// System logger
function logToConsole(text, type = "blue") {
  const line = document.createElement('div');
  line.className = `log-line text-${type}`;
  const now = new Date().toLocaleTimeString();
  line.innerText = `[${now}] ${text}`;
  consoleOutput.appendChild(line);
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

// Copy helper with iframe fallback support
function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  
  // Fallback for iframe sandboxing and insecure contexts
  return new Promise((resolve, reject) => {
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      
      // Keep offscreen
      textArea.style.top = "0";
      textArea.style.left = "0";
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      
      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);
      
      if (successful) {
        resolve();
      } else {
        reject(new Error("document.execCommand('copy') failed"));
      }
    } catch (err) {
      reject(err);
    }
  });
}

// Create Invite Link
function copyInviteLink() {
  const room = roomIdInput.value;
  // Use activeTunnelUrl if provided by server, fallback to host origin
  const baseOrigin = activeTunnelUrl || window.location.origin;
  const inviteUrl = `${baseOrigin}/?room=${room}&role=guest`;
  
  copyTextToClipboard(inviteUrl).then(() => {
    alert("Guest invite link copied to clipboard!\n\nLink: " + inviteUrl);
    logToConsole("Copied invite link: " + inviteUrl, "green");
  }).catch((err) => {
    console.error("Clipboard copy failed:", err);
    // Final user-prompted fallback
    window.prompt("Could not copy automatically due to browser safety. Please copy this URL manually:", inviteUrl);
    logToConsole("Clipboard write blocked. Displayed manual fallback prompt.", "yellow");
  });
}

// Enter Studio Room
async function enterStudio() {
  const username = usernameInput.value.trim();
  const roomId = roomIdInput.value.trim();

  if (!username || !roomId) {
    alert("Please enter both username and studio room name!");
    return;
  }

  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  if (lobbyAudioInterval) clearInterval(lobbyAudioInterval);

  // Configure constraints
  const constraints = {
    audio: {
      deviceId: audioSource.value ? { exact: audioSource.value } : undefined,
      echoCancellation: document.getElementById('echo-cancellation').checked,
      noiseSuppression: document.getElementById('noise-suppression').checked,
      autoGainControl: document.getElementById('auto-gain').checked
    },
    video: {
      deviceId: videoSource.value ? { exact: videoSource.value } : undefined,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 }
    }
  };

  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    
    if (blurEnabled) {
      localVideo.style.display = 'none';
      localVideoCanvas.style.display = 'block';
      
      videoElement = document.createElement('video');
      videoElement.srcObject = localStream;
      videoElement.autoplay = true;
      videoElement.playsInline = true;
      videoElement.muted = true;
      
      processedCanvas = localVideoCanvas;
      processedCtx = processedCanvas.getContext('2d');
      
      applyBackgroundBlurLoop();
      
      await new Promise(resolve => setTimeout(resolve, 500));
      processedStream = processedCanvas.captureStream(30);
      processedStream.addTrack(localStream.getAudioTracks()[0]);
      
      localVideoCanvas.srcObject = processedStream;
    } else {
      localVideoCanvas.style.display = 'none';
      localVideo.style.display = 'block';
      localVideo.srcObject = localStream;
    }

    localName.innerText = `${username} (${currentRoleHost ? 'Host' : 'Guest'})`;
    displayRoomName.innerText = roomId;
    lobbyView.style.display = 'none';
    studioView.style.display = 'flex';

    initializeSocket(roomId, username);

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    setupAudioVisualizer(localStream, 'local-waveform', true);

    logToConsole(`Entered studio room: ${roomId} as ${currentRoleHost ? 'Host' : 'Guest'}`, "green");
  } catch (err) {
    alert("Failed to access media devices with selected options: " + err.message);
    logToConsole("Studio entry failed: " + err.message, "red");
    startLobbyPreview();
  }
}

// Initialize Socket.io
function initializeSocket(roomId, username) {
  socket = io();

  const indicator = document.getElementById('connection-indicator');
  const indicatorLabel = indicator.querySelector('.label');

  socket.on('connect', () => {
    indicator.className = "connection-badge connected";
    indicatorLabel.innerText = "Connected";
    logToConsole("Signaling server connected.", "green");

    socket.emit('join-room', { 
      roomId, 
      username, 
      isHost: currentRoleHost,
      customIceServers: dynamicRtcConfig ? dynamicRtcConfig.iceServers : null
    });
  });

  socket.on('tunnel-url', (url) => {
    activeTunnelUrl = url;
    logToConsole("Active public guest tunnel URL: " + url, "blue");
  });

  socket.on('disconnect', () => {
    indicator.className = "connection-badge disconnected";
    indicatorLabel.innerText = "Disconnected";
    logToConsole("Signaling server disconnected.", "red");
  });

  socket.on('room-state', ({ users, hostId, guestId, customIceServers }) => {
    logToConsole(`Room state loaded. Participants: ${Object.keys(users).length}`, "blue");
    
    if (customIceServers) {
      dynamicRtcConfig = { iceServers: customIceServers };
      logToConsole("Loaded secure TURN servers dynamically.", "green");
    }
    
    const otherId = Object.keys(users).find(id => id !== socket.id);
    if (otherId) {
      const otherUser = users[otherId];
      remoteName.innerText = otherUser.username;
      guestPlaceholder.style.display = 'none';
      remoteRecBadge.innerText = "Ready";
      remoteRecBadge.className = "track-rec-badge idle";
      
      if (currentRoleHost) {
        logToConsole(`Initiating call to guest: ${otherUser.username}`, "blue");
        createPeerConnection(otherId);
      }
    }
  });

  socket.on('user-joined', ({ id, username, isHost: otherIsHost }) => {
    logToConsole(`${otherIsHost ? 'Host' : 'Guest'} joined: ${username}`, "green");
    remoteName.innerText = username;
    guestPlaceholder.style.display = 'none';
    remoteRecBadge.innerText = "Ready";
    remoteRecBadge.className = "track-rec-badge idle";

    if (currentRoleHost) {
      createPeerConnection(id);
    }
  });

  socket.on('user-left', ({ username }) => {
    logToConsole(`Participant left: ${username}`, "yellow");
    remoteName.innerText = "Guest";
    guestPlaceholder.style.display = 'flex';
    remoteVideo.srcObject = null;
    remoteRecBadge.className = "track-rec-badge idle";
    remoteRecBadge.innerText = "Guest Offline";
    
    if (isScreenSharing && !currentRoleHost) {
      stopScreenSharingLocally();
    }
    
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    remoteIceCandidatesQueue = [];
  });

  // Helper to process queued remote candidates once SDP remote description is stable
  async function processQueuedCandidates() {
    if (!peerConnection || !peerConnection.remoteDescription) return;
    if (remoteIceCandidatesQueue.length === 0) return;
    
    logToConsole(`Processing ${remoteIceCandidatesQueue.length} queued ICE candidates...`, "blue");
    const candidates = [...remoteIceCandidatesQueue];
    remoteIceCandidatesQueue = [];
    
    for (const cand of candidates) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
        const type = cand.candidate.includes("typ relay") ? "relay (TURN)" : 
                     cand.candidate.includes("typ srflx") ? "reflexive (STUN)" : "host (local)";
        logToConsole(`Added queued remote ICE candidate: ${type}`, "green");
      } catch (e) {
        logToConsole(`Failed to add queued remote candidate: ${e.message}`, "red");
      }
    }
  }

  // WebRTC Signaling Relay events
  socket.on('webrtc-offer', async ({ offer, senderId }) => {
    logToConsole("WebRTC offer received.", "blue");
    if (!peerConnection) {
      createPeerConnection(senderId);
    }
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('webrtc-answer', { answer, targetId: senderId });
      logToConsole("WebRTC answer sent.", "blue");
      await processQueuedCandidates();
    } catch (e) {
      logToConsole("SDP offer processing failed: " + e.message, "red");
    }
  });

  socket.on('webrtc-answer', async ({ answer }) => {
    logToConsole("WebRTC answer received.", "blue");
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      await processQueuedCandidates();
    } catch (e) {
      logToConsole("SDP answer processing failed: " + e.message, "red");
    }
  });

  socket.on('webrtc-candidate', async ({ candidate }) => {
    try {
      if (peerConnection && peerConnection.remoteDescription) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        const type = candidate.candidate.includes("typ relay") ? "relay (TURN)" : 
                     candidate.candidate.includes("typ srflx") ? "reflexive (STUN)" : "host (local)";
        logToConsole(`Added remote ICE candidate: ${type}`, "green");
      } else {
        logToConsole("Queueing remote ICE candidate (remote description not set yet).", "blue");
        remoteIceCandidatesQueue.push(candidate);
      }
    } catch (e) {
      logToConsole(`Failed to add remote candidate: ${e.message}`, "red");
    }
  });

  socket.on('start-recording', () => {
    startLocalRecording();
  });

  socket.on('stop-recording', () => {
    stopLocalRecording();
  });

  socket.on('guest-recording-status', (status) => {
    guestSyncStatus.innerText = status.state;
    if (status.state === "Recording...") {
      guestSyncStatus.className = "sync-status text-red";
      remoteRecBadge.innerText = "Recording...";
      remoteRecBadge.className = "track-rec-badge recording";
    } else if (status.state === "Saving...") {
      guestSyncStatus.className = "sync-status text-yellow";
      remoteRecBadge.innerText = "Saving Local File...";
      remoteRecBadge.className = "track-rec-badge saving";
    } else if (status.state === "Saved") {
      guestSyncStatus.className = "sync-status text-green";
      remoteRecBadge.innerText = "Saved / Disk Streamed";
      remoteRecBadge.className = "track-rec-badge saved";
    } else {
      guestSyncStatus.className = "sync-status text-yellow";
      remoteRecBadge.innerText = "Ready";
      remoteRecBadge.className = "track-rec-badge idle";
    }
  });

  socket.on('screen-share-started', ({ senderName }) => {
    logToConsole(`${senderName} started screen sharing.`, "green");
    cardScreen.classList.remove('hidden');
    screenVideo.srcObject = remoteStream;
    switchLayout('theater');
  });

  socket.on('screen-share-stopped', () => {
    logToConsole("Screen sharing stopped.", "blue");
    cardScreen.classList.add('hidden');
    screenVideo.srcObject = null;
    switchLayout('grid');
  });

  socket.on('layout-changed', ({ layout }) => {
    applyLayoutClass(layout);
  });

  socket.on('draw-stroke', ({ x0, y0, x1, y1, color }) => {
    drawOnCanvasLocally(x0, y0, x1, y1, color);
  });

  socket.on('draw-text', ({ x, y, text, color }) => {
    drawTextOnCanvasLocally(x, y, text, color);
  });

  socket.on('clear-drawings', () => {
    clearCanvasLocally();
  });
}

// Create RTCPeerConnection
function createPeerConnection(targetId) {
  peerConnection = new RTCPeerConnection(dynamicRtcConfig || rtcConfig);
  logToConsole("RTCPeerConnection instantiated.", "blue");
  const usedConfig = dynamicRtcConfig || rtcConfig;
  console.log("[ICE] Using iceServers:", JSON.stringify(usedConfig.iceServers.map(s => s.urls || s)));

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      const type = event.candidate.candidate.includes("typ relay") ? "relay (TURN)" : 
                   event.candidate.candidate.includes("typ srflx") ? "reflexive (STUN)" : "host (local)";
      logToConsole(`Gathered ICE candidate: ${type}`, "blue");
      socket.emit('webrtc-candidate', {
        candidate: event.candidate,
        targetId
      });
    } else {
      logToConsole("ICE candidate gathering complete.", "green");
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    logToConsole(`ICE Connection State: ${peerConnection.iceConnectionState.toUpperCase()}`, "blue");
  };

  peerConnection.onconnectionstatechange = () => {
    logToConsole(`Connection State: ${peerConnection.connectionState.toUpperCase()}`, "blue");
  };

  peerConnection.ontrack = (event) => {
    logToConsole(`Remote media track added: ${event.track.kind}`, "green");
    
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
    }
    remoteStream.addTrack(event.track);

    // Update status badge to Ready
    remoteRecBadge.innerText = "Ready";
    remoteRecBadge.className = "track-rec-badge idle";

    // Explicitly play remote stream to bypass browser autoplay blocker
    remoteVideo.play().then(() => {
      logToConsole("Remote media playback started.", "green");
    }).catch(err => {
      console.warn("Autoplay blocked. Click anywhere to play remote media:", err);
      logToConsole("Playback blocked by browser. Click anywhere in the studio to see/hear your guest.", "yellow");
      
      const playOnGesture = () => {
        remoteVideo.play().then(() => {
          logToConsole("Remote media playback started on user gesture.", "green");
        }).catch(e => console.error("Playback failed on gesture:", e));
        document.removeEventListener('click', playOnGesture);
      };
      document.addEventListener('click', playOnGesture);
    });

    if (event.track.kind === 'video') {
      const videoTracks = remoteStream.getVideoTracks();
      if (videoTracks.length > 1) {
        cardScreen.classList.remove('hidden');
        screenVideo.srcObject = remoteStream;
        screenVideo.play().catch(() => {});
        switchLayout('theater');
      }
    }

    if (event.track.kind === 'audio') {
      setupAudioVisualizer(remoteStream, 'remote-waveform', false);
    }
  };

  const streamToSend = blurEnabled ? processedStream : localStream;
  streamToSend.getTracks().forEach(track => {
    peerConnection.addTrack(track, streamToSend);
  });

  if (currentRoleHost) {
    peerConnection.onnegotiationneeded = async () => {
      try {
        logToConsole("Creating SDP offer...", "blue");
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('webrtc-offer', { offer, targetId });
      } catch (err) {
        logToConsole("SDP offer creation failed: " + err.message, "red");
      }
    };
  }
}

// Web Audio API Visualizer Setup
function setupAudioVisualizer(stream, canvasId, isLocal) {
  try {
    const sourceNode = audioContext.createMediaStreamSource(stream);
    const analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    sourceNode.connect(analyserNode);

    if (isLocal) {
      localAnalyser = analyserNode;
    } else {
      remoteAnalyser = analyserNode;
    }

    drawWaveform(canvasId, analyserNode);
  } catch (e) {
    logToConsole("Visualizer setup failed: " + e.message, "yellow");
  }
}

// Draw Waveform on Canvas
function drawWaveform(canvasId, analyser) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const canvasCtx = canvas.getContext('2d');
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    requestAnimationFrame(draw);

    analyser.getByteFrequencyData(dataArray);

    canvasCtx.fillStyle = 'rgba(0, 0, 0, 0)';
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

    const barWidth = (canvas.width / bufferLength) * 1.5;
    let barHeight;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      barHeight = (dataArray[i] / 255) * canvas.height;

      const gradient = canvasCtx.createLinearGradient(0, canvas.height, 0, 0);
      if (canvasId.includes('local')) {
        gradient.addColorStop(0, '#6366f1'); // Indigo
        gradient.addColorStop(1, '#8b5cf6'); // Violet
      } else {
        gradient.addColorStop(0, '#10b981'); // Emerald
        gradient.addColorStop(1, '#6366f1'); // Indigo
      }

      canvasCtx.fillStyle = gradient;
      canvasCtx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);

      x += barWidth;
    }
  }

  draw();
}

// Toggle Recording (Host Controls)
function toggleRecording() {
  if (!isRecording) {
    socket.emit('start-recording');
    startLocalRecording();
  } else {
    socket.emit('stop-recording');
    stopLocalRecording();
  }
}

// Start MediaRecorder (Crash-Proof Local Disk Streaming)
async function startLocalRecording() {
  if (isRecording) return;
  recordedChunks = [];
  fileHandle = null;
  fileWritable = null;

  if (db) {
    db.transaction([STORE_NAME], 'readwrite').objectStore(STORE_NAME).clear();
  }

  const supportsFileSystemAccess = 'showSaveFilePicker' in window;
  if (supportsFileSystemAccess) {
    try {
      logToConsole("Requesting direct disk file destination...", "blue");
      fileHandle = await window.showSaveFilePicker({
        suggestedName: `podcast_session_${Date.now()}.webm`,
        types: [{
          description: 'High-Fidelity Podcast Track',
          accept: { 'video/webm': ['.webm'] }
        }]
      });
      fileWritable = await fileHandle.createWritable();
      logToConsole("File handle acquired. Stream will write directly to disk.", "green");
    } catch (err) {
      logToConsole("Disk permission denied. Falling back to IndexedDB database backup.", "yellow");
      fileHandle = null;
      fileWritable = null;
    }
  } else {
    logToConsole("Direct-to-Disk API not supported in this browser. Falling back to IndexedDB database backup.", "yellow");
  }

  let options = { mimeType: 'video/webm;codecs=vp9,opus', videoBitsPerSecond: 4000000, audioBitsPerSecond: 256000 };
  
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 3000000, audioBitsPerSecond: 256000 };
  }
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = { mimeType: 'video/webm', videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 };
  }
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = { mimeType: 'video/mp4', videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 };
  }

  try {
    const recordingStream = blurEnabled ? processedStream : localStream;
    mediaRecorder = new MediaRecorder(recordingStream, options);

    mediaRecorder.ondataavailable = async (event) => {
      if (event.data && event.data.size > 0) {
        if (fileWritable) {
          try {
            await fileWritable.write(event.data);
          } catch (writeErr) {
            logToConsole("Disk stream write failed: " + writeErr.message + ". Appending to memory instead.", "red");
            recordedChunks.push(event.data);
          }
        } else {
          recordedChunks.push(event.data);
        }

        if (db) {
          try {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            tx.objectStore(STORE_NAME).add(event.data);
          } catch (dbErr) {
            // Ignore database write failures
          }
        }
      }
    };

    mediaRecorder.onstop = finalizeLocalTrack;

    mediaRecorder.start(2000);
    isRecording = true;
    recordingStartTime = Date.now();
    
    recordBtn.innerHTML = '<i class="fa-solid fa-square"></i> Stop Recording';
    recordBtn.className = "btn btn-secondary btn-large full-width";
    recordingIndicator.className = "recording-badge recording";
    recordingText.innerText = "RECORDING LIVE";
    localRecBadge.className = "track-rec-badge recording";
    localRecBadge.innerText = "Recording...";

    startTimer();
    logToConsole("Local recording active.", "green");
    reportRecordingStatus("Recording...");
  } catch (err) {
    logToConsole("Failed to start MediaRecorder: " + err.message, "red");
    alert("Recording failed to start: " + err.message);
  }
}

// Stop Local MediaRecorder
function stopLocalRecording() {
  if (!isRecording) return;

  try {
    mediaRecorder.stop();
    isRecording = false;
    stopTimer();

    recordBtn.innerHTML = '<i class="fa-solid fa-circle"></i> Start Recording';
    recordBtn.className = "btn btn-danger btn-large full-width host-only";
    recordingIndicator.className = "recording-badge idle";
    recordingText.innerText = "NOT RECORDING";
    localRecBadge.className = "track-rec-badge saving";
    localRecBadge.innerText = "Saving File...";

    logToConsole("Recording stopped. Finalizing file tracks...", "yellow");
    reportRecordingStatus("Saving...");
  } catch (e) {
    logToConsole("Error stopping recording: " + e.message, "red");
  }
}

// Finalize and save track
async function finalizeLocalTrack() {
  const ext = mediaRecorder.mimeType.includes('mp4') ? 'mp4' : 'webm';
  const username = usernameInput.value;
  const duration = recordingTimer.innerText;

  if (tracksList.classList.contains('empty')) {
    tracksList.innerHTML = '';
    tracksList.classList.remove('empty');
  }

  const trackId = `track-${Date.now()}`;
  const trackItem = document.createElement('div');
  trackItem.className = 'track-item';
  trackItem.id = trackId;

  if (fileWritable) {
    try {
      await fileWritable.close();
      fileWritable = null;
      logToConsole("Direct-to-Disk stream closed. File successfully saved on your hard drive.", "green");

      trackItem.innerHTML = `
        <div class="track-meta">
          <span class="track-name"><i class="fa-solid fa-file-shield"></i> ${username} - Local Disk Saved</span>
          <span class="track-size">Direct Saved</span>
        </div>
        <div class="track-meta" style="margin-top:-4px; font-size:11px; color:var(--text-muted);">
          <span>Duration: ${duration}</span>
          <span>Location: Choose on startup</span>
        </div>
        <div class="track-actions">
          <button class="btn btn-secondary btn-sm" disabled><i class="fa-solid fa-circle-check"></i> Already Saved to Disk</button>
        </div>
      `;
    } catch (err) {
      logToConsole("Failed to close file handle: " + err.message + ". Falling back to memory download.", "red");
    }
  }

  if (!fileWritable) {
    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
    const url = URL.createObjectURL(blob);
    const sizeMb = (blob.size / (1024 * 1024)).toFixed(2);

    trackItem.innerHTML = `
      <div class="track-meta">
        <span class="track-name"><i class="fa-solid fa-video"></i> ${username} - Local RAM Track</span>
        <span class="track-size">${sizeMb} MB</span>
      </div>
      <div class="track-meta" style="margin-top:-4px; font-size:11px; color:var(--text-muted);">
        <span>Duration: ${duration}</span>
        <span>Codec: ${mediaRecorder.mimeType.split(';')[0]}</span>
      </div>
      <div class="track-actions">
        <a href="${url}" download="${username}_local_track_${Date.now()}.${ext}" class="btn btn-primary btn-sm">
          <i class="fa-solid fa-download"></i> Save / Download
        </a>
      </div>
    `;
  }

  tracksList.appendChild(trackItem);

  if (db) {
    db.transaction([STORE_NAME], 'readwrite').objectStore(STORE_NAME).clear();
  }

  localRecBadge.className = "track-rec-badge saved";
  localRecBadge.innerText = "Saved";
  logToConsole("Track finalized.", "green");
  reportRecordingStatus("Saved");
}

// Send Status messages to the host
function reportRecordingStatus(stateStr) {
  if (socket && !currentRoleHost) {
    socket.emit('recording-status-update', {
      state: stateStr
    });
  }
}

// Toggle Screen Share
async function toggleScreenShare() {
  if (!isScreenSharing) {
    try {
      logToConsole("Acquiring screen capture stream...", "blue");
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      screenVideo.srcObject = screenStream;
      
      cardScreen.classList.remove('hidden');
      isScreenSharing = true;
      screenShareBtn.classList.add('active');
      
      document.getElementById('annotation-toolbar').classList.remove('hidden');

      const videoTrack = screenStream.getVideoTracks()[0];
      if (peerConnection) {
        peerConnection.addTrack(videoTrack, screenStream);
      }

      socket.emit('screen-share-started', { senderName: usernameInput.value });
      
      if (currentRoleHost) {
        switchLayout('theater');
      }

      videoTrack.addEventListener('ended', () => {
        stopScreenSharingLocally();
      });

      logToConsole("Screen sharing active.", "green");
    } catch (err) {
      logToConsole("Screen share acquisition failed: " + err.message, "red");
    }
  } else {
    stopScreenSharingLocally();
  }
}

// Stop screen share
function stopScreenSharingLocally() {
  if (!isScreenSharing) return;

  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }

  cardScreen.classList.add('hidden');
  screenVideo.srcObject = null;
  isScreenSharing = false;
  screenShareBtn.classList.remove('active');
  document.getElementById('annotation-toolbar').classList.add('hidden');

  socket.emit('screen-share-stopped');

  if (currentRoleHost) {
    switchLayout('grid');
  }

  logToConsole("Screen sharing stopped.", "blue");
}

// Host Layout Controls
function switchLayout(layoutName) {
  if (!currentRoleHost) return;
  
  activeLayout = layoutName;
  applyLayoutClass(layoutName);

  if (socket) {
    socket.emit('layout-changed', { layout: layoutName });
  }
}

// Apply Layout configuration CSS class
function applyLayoutClass(layoutName) {
  mainVideoGrid.className = 'video-grid';
  mainVideoGrid.classList.add(`layout-${layoutName}`);

  const buttons = ['grid', 'theater', 'pip', 'host-solo', 'guest-solo'];
  buttons.forEach(bName => {
    const btn = document.getElementById(`layout-btn-${bName}`);
    if (btn) {
      if (bName === layoutName) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    }
  });

  logToConsole(`Studio layout set to: ${layoutName.toUpperCase()}`, "blue");
}

// ================= ANNOTATION & DRAWING ENGINE =================

function setupAnnotationDrawingListeners() {
  annotationCanvas = document.getElementById('drawing-board');
  canvasCtx = annotationCanvas.getContext('2d');

  const resizeObserver = new ResizeObserver(() => {
    annotationCanvas.width = annotationCanvas.offsetWidth;
    annotationCanvas.height = annotationCanvas.offsetHeight;
    clearCanvasLocally();
  });
  resizeObserver.observe(annotationCanvas);

  annotationCanvas.addEventListener('mousedown', startDrawing);
  annotationCanvas.addEventListener('mousemove', draw);
  annotationCanvas.addEventListener('mouseup', stopDrawing);
  annotationCanvas.addEventListener('mouseleave', stopDrawing);

  document.getElementById('tool-pen').onclick = () => selectDrawingTool('pen');
  document.getElementById('tool-text').onclick = () => selectDrawingTool('text');
  document.getElementById('tool-clear').onclick = clearDrawings;

  const colorSwatches = document.querySelectorAll('.color-swatch');
  colorSwatches.forEach(swatch => {
    swatch.onclick = (e) => {
      colorSwatches.forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      currentColor = swatch.getAttribute('data-color');
    };
  });
}

function selectDrawingTool(toolName) {
  currentTool = toolName;
  document.getElementById('tool-pen').classList.remove('active');
  document.getElementById('tool-text').classList.remove('active');
  document.getElementById(`tool-${toolName}`).classList.add('active');
}

function startDrawing(e) {
  isDrawing = true;
  const rect = annotationCanvas.getBoundingClientRect();
  lastX = e.clientX - rect.left;
  lastY = e.clientY - rect.top;

  if (currentTool === 'text') {
    promptTextInput(lastX, lastY);
  }
}

function draw(e) {
  if (!isDrawing || currentTool !== 'pen') return;

  const rect = annotationCanvas.getBoundingClientRect();
  const currentX = e.clientX - rect.left;
  const currentY = e.clientY - rect.top;

  drawOnCanvasLocally(lastX, lastY, currentX, currentY, currentColor);

  if (socket) {
    socket.emit('draw-stroke', {
      x0: lastX / annotationCanvas.width,
      y0: lastY / annotationCanvas.height,
      x1: currentX / annotationCanvas.width,
      y1: currentY / annotationCanvas.height,
      color: currentColor
    });
  }

  lastX = currentX;
  lastY = currentY;
}

function stopDrawing() {
  isDrawing = false;
}

function drawOnCanvasLocally(x0, y0, x1, y1, color) {
  const px0 = x0 <= 1 ? x0 * annotationCanvas.width : x0;
  const py0 = y0 <= 1 ? y0 * annotationCanvas.height : y0;
  const px1 = x1 <= 1 ? x1 * annotationCanvas.width : x1;
  const py1 = y1 <= 1 ? y1 * annotationCanvas.height : y1;

  canvasCtx.beginPath();
  canvasCtx.moveTo(px0, py0);
  canvasCtx.lineTo(px1, py1);
  canvasCtx.strokeStyle = color;
  canvasCtx.lineWidth = 3;
  canvasCtx.lineCap = 'round';
  canvasCtx.stroke();
  canvasCtx.closePath();
}

function promptTextInput(x, y) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'canvas-text-input';
  input.style.left = `${x}px`;
  input.style.top = `${y - 12}px`;
  input.style.color = currentColor;

  cardScreen.querySelector('.video-wrapper').appendChild(input);
  input.focus();

  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      const textVal = input.value.trim();
      if (textVal) {
        drawTextOnCanvasLocally(x, y, textVal, currentColor);

        if (socket) {
          socket.emit('draw-text', {
            x: x / annotationCanvas.width,
            y: y / annotationCanvas.height,
            text: textVal,
            color: currentColor
          });
        }
      }
      input.remove();
    } else if (e.key === 'Escape') {
      input.remove();
    }
  };

  input.onblur = () => input.remove();
}

function drawTextOnCanvasLocally(x, y, text, color) {
  const px = x <= 1 ? x * annotationCanvas.width : x;
  const py = y <= 1 ? y * annotationCanvas.height : y;

  canvasCtx.font = 'bold 20px Outfit, sans-serif';
  canvasCtx.fillStyle = color;
  canvasCtx.fillText(text, px, py);
}

function clearDrawings() {
  clearCanvasLocally();
  if (socket) {
    socket.emit('clear-drawings');
  }
}

function clearCanvasLocally() {
  if (canvasCtx && annotationCanvas) {
    canvasCtx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
  }
}

// Mute controls
function toggleLocalMuteMic() {
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;

  audioTrack.enabled = !audioTrack.enabled;
  if (audioTrack.enabled) {
    muteMicBtn.classList.remove('active');
    muteMicBtn.innerHTML = '<i class="fa-solid fa-microphone"></i>';
    logToConsole("Microphone unmuted.", "blue");
  } else {
    muteMicBtn.classList.add('active');
    muteMicBtn.innerHTML = '<i class="fa-solid fa-microphone-slash"></i>';
    logToConsole("Microphone muted.", "yellow");
  }
}

function toggleLocalMuteVideo() {
  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) return;

  videoTrack.enabled = !videoTrack.enabled;
  if (videoTrack.enabled) {
    muteVideoBtn.classList.remove('active');
    muteVideoBtn.innerHTML = '<i class="fa-solid fa-video"></i>';
    logToConsole("Camera enabled.", "blue");
  } else {
    muteVideoBtn.classList.add('active');
    muteVideoBtn.innerHTML = '<i class="fa-solid fa-video-slash"></i>';
    logToConsole("Camera disabled.", "yellow");
  }
}

// Timer management
function startTimer() {
  recordingStartTime = Date.now();
  timerInterval = setInterval(() => {
    const diff = Date.now() - recordingStartTime;
    const hrs = Math.floor(diff / 3600000).toString().padStart(2, '0');
    const mins = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
    const secs = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
    recordingTimer.innerText = `${hrs}:${mins}:${secs}`;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}
