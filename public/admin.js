// public/admin.js
const socket = io();
const peerConnections = {};
const iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let localStream;
let sessionId = null;
let listenersBound = false;
let sessionActive = false;

const ui = {
  startBtn: document.getElementById('startSessionBtn'),
  stopBtn: document.getElementById('stopSessionBtn'),
  sessionStatus: document.getElementById('sessionStatus'),
  videoStatus: document.getElementById('videoStatus'),
  sessionUrlInput: document.getElementById('sessionUrlInput'),
  copyBtn: document.getElementById('copySessionBtn'),
  shareCard: document.getElementById('shareCard'),
  participantList: document.getElementById('participantList'),
  localVideo: document.getElementById('localVideo'),
};

function setStatus(element, text, state = 'idle') {
  if (!element) return;
  element.textContent = text;
  element.dataset.state = state;
  element.className = `status status-${state}`;
}

function ensureSocketListeners() {
  if (listenersBound) return;
  listenersBound = true;

  socket.on('student-connected', ({ studentSocketId }) => {
    upsertParticipant(studentSocketId, 'Student connected', 'active');
    setStatus(ui.sessionStatus, 'Student joined the room. Waiting for answer…', 'active');
    createPeerForStudent(studentSocketId).catch((error) => {
      console.error(error);
      upsertParticipant(studentSocketId, 'Connection failed', 'error');
      teardownPeer(studentSocketId);
    });
  });

  socket.on('student-disconnected', ({ studentSocketId }) => {
    teardownPeer(studentSocketId);
    upsertParticipant(studentSocketId, 'Disconnected', 'warning');
  });

  socket.on('answer', async ({ from, sdp }) => {
    const pc = peerConnections[from];
    if (!pc) {
      console.warn('PC not found for', from);
      return;
    }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      upsertParticipant(from, 'Streaming', 'success');
      setStatus(ui.sessionStatus, 'Streaming live to students', 'success');
    } catch (error) {
      console.error('setRemoteDescription failed', error);
      upsertParticipant(from, 'Answer rejected', 'error');
    }
  });

  socket.on('ice-candidate', ({ from, candidate }) => {
    const pc = peerConnections[from];
    if (pc && candidate) {
      pc.addIceCandidate(new RTCIceCandidate(candidate)).catch((error) => {
        console.error('Failed to add ICE candidate', error);
      });
    }
  });

  socket.on('session-ended', () => {
    if (!sessionActive && !sessionId) {
      return;
    }
    handleSessionEnded('Session ended.', 'warning');
  });
}

function upsertParticipant(id, text, state = 'idle') {
  if (!ui.participantList) return;
  let item = ui.participantList.querySelector(`[data-id="${id}"]`);
  if (!item) {
    item = document.createElement('li');
    item.dataset.id = id;
    ui.participantList.appendChild(item);
  }
  item.textContent = text;
  item.className = `participant participant-${state}`;
}

function removeParticipant(id) {
  if (!ui.participantList) return;
  const item = ui.participantList.querySelector(`[data-id="${id}"]`);
  if (item) {
    ui.participantList.removeChild(item);
  }
}

function teardownPeer(studentId) {
  const pc = peerConnections[studentId];
  if (pc) {
    pc.close();
    delete peerConnections[studentId];
  }
  removeParticipant(studentId);
}

async function emitWithAck(event, payload) {
  return new Promise((resolve, reject) => {
    socket.emit(event, payload, (response = { ok: true }) => {
      if (response.ok === false) {
        reject(new Error(response.error || 'Request failed.'));
      } else {
        resolve(response);
      }
    });
  });
}

async function startLocalStream() {
  try {
    setStatus(ui.videoStatus, 'Requesting camera and microphone…', 'active');
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    ui.localVideo.srcObject = localStream;
    setStatus(ui.videoStatus, 'Camera preview active.', 'success');
  } catch (error) {
    console.error('Unable to access media devices', error);
    setStatus(ui.videoStatus, 'Could not access camera or microphone.', 'error');
    throw error;
  }
}

async function createPeerForStudent(studentId) {
  const pc = new RTCPeerConnection(iceConfig);
  peerConnections[studentId] = pc;

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      emitWithAck('ice-candidate', { to: studentId, candidate: event.candidate })
        .catch((error) => {
          console.error('Failed to send ICE candidate', error);
        });
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  await emitWithAck('offer', { to: studentId, sdp: pc.localDescription });
}

async function handleStartSession() {
  if (sessionId) {
    setStatus(ui.sessionStatus, 'Session already active.', 'warning');
    return;
  }

  ui.startBtn.disabled = true;
  setStatus(ui.sessionStatus, 'Creating session…', 'active');

  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      throw new Error('Server returned an error.');
    }
    const data = await res.json();
    sessionId = data.unique_id;

    ui.sessionUrlInput.value = data.userurl;
    ui.shareCard.classList.remove('hidden');
    setStatus(ui.sessionStatus, 'Session created. Invite your students.', 'success');
  } catch (error) {
    console.error('Failed to create session', error);
    setStatus(ui.sessionStatus, 'Unable to create session. Try again.', 'error');
    ui.startBtn.disabled = false;
    return;
  }

  try {
    await startLocalStream();
  } catch (error) {
    setStatus(ui.sessionStatus, 'Grant camera access to continue.', 'error');
    ui.startBtn.disabled = false;
    return;
  }

  ensureSocketListeners();
  try {
    await emitWithAck('admin-join', { unique_id: sessionId });
    setStatus(ui.sessionStatus, 'Waiting for students to join…', 'active');
    sessionActive = true;
    toggleControls();
  } catch (error) {
    console.error('Admin join failed', error);
    setStatus(ui.sessionStatus, error.message || 'Unable to join session.', 'error');
    ui.startBtn.disabled = false;
    sessionId = null;
    sessionActive = false;
    toggleControls();
  }
}

function toggleControls() {
  if (!ui.stopBtn) return;
  ui.stopBtn.classList.toggle('hidden', !sessionActive);
  ui.startBtn.classList.toggle('hidden', sessionActive);
}

function resetUIState({ keepSessionStatus = false } = {}) {
  ui.shareCard.classList.add('hidden');
  ui.sessionUrlInput.value = '';
  if (!keepSessionStatus) {
    setStatus(ui.sessionStatus, 'Ready when you are.', 'idle');
  }
  setStatus(ui.videoStatus, 'Camera inactive.', 'idle');
  if (ui.participantList) {
    ui.participantList.innerHTML = '';
  }
}

async function handleStopSession() {
  if (!sessionActive || !sessionId) {
    return;
  }
  setStatus(ui.sessionStatus, 'Stopping session…', 'active');
  try {
    await emitWithAck('admin-end-session', { unique_id: sessionId });
    handleSessionEnded('Session ended by you.', 'warning');
  } catch (error) {
    console.error('Failed to stop session', error);
    setStatus(ui.sessionStatus, error.message || 'Unable to stop session.', 'error');
  }
}

function endSession() {
  Object.keys(peerConnections).forEach(teardownPeer);
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  sessionId = null;
  sessionActive = false;
  toggleControls();
  ui.startBtn.disabled = false;
}

function handleSessionEnded(message, state) {
  setStatus(ui.sessionStatus, message, state);
  endSession();
  resetUIState({ keepSessionStatus: true });
}

ui.startBtn.addEventListener('click', handleStartSession);

if (ui.stopBtn) {
  ui.stopBtn.addEventListener('click', handleStopSession);
}

ui.copyBtn.addEventListener('click', async () => {
  if (!ui.sessionUrlInput.value) return;
  try {
    await navigator.clipboard.writeText(ui.sessionUrlInput.value);
    ui.copyBtn.textContent = 'Copied!';
    setTimeout(() => { ui.copyBtn.textContent = 'Copy'; }, 2000);
  } catch (error) {
    console.error('Clipboard error', error);
    ui.copyBtn.textContent = 'Copy failed';
    setTimeout(() => { ui.copyBtn.textContent = 'Copy'; }, 2000);
  }
});

window.addEventListener('beforeunload', endSession);

resetUIState();
toggleControls();
