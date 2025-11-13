// public/student.js
const socket = io();
const uniqueId = window.location.pathname.split('/').pop();
const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

const ui = {
  status: document.getElementById('statusText'),
  subtitle: document.getElementById('infoText'),
  remoteVideo: document.getElementById('remoteVideo'),
  loader: document.getElementById('loadingIndicator'),
};

let adminSocketId = null;

function setStatus(text, state = 'idle') {
  if (!ui.status) return;
  ui.status.textContent = text;
  ui.status.dataset.state = state;
  ui.status.className = `status status-${state}`;
}

function setSubtitle(text) {
  if (ui.subtitle) {
    ui.subtitle.textContent = text;
  }
}

function toggleLoader(show) {
  if (!ui.loader) return;
  ui.loader.classList.toggle('hidden', !show);
}

function emitWithAck(event, payload) {
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

async function joinSession() {
  setStatus(`Joining session ${uniqueId}…`, 'active');
  toggleLoader(true);

  try {
    await emitWithAck('student-join', { unique_id: uniqueId });
    setSubtitle('Waiting for the presenter to start streaming.');
  } catch (error) {
    console.error(error);
    setStatus(error.message || 'Unable to join session.', 'error');
    setSubtitle('Check the link or ask the presenter to start the session.');
    toggleLoader(false);
  }
}

pc.ontrack = (event) => {
  const [stream] = event.streams;
  if (!stream) return;
  ui.remoteVideo.srcObject = stream;
  toggleLoader(false);
  setStatus('Connected', 'success');
  setSubtitle('Enjoy the live session.');
};

pc.onconnectionstatechange = () => {
  const state = pc.connectionState;
  if (state === 'connected') {
    setStatus('Connected', 'success');
  } else if (state === 'disconnected' || state === 'failed') {
    setStatus('Connection lost. Attempting to reconnect…', 'warning');
    toggleLoader(true);
  } else if (state === 'closed') {
    setStatus('Session closed.', 'warning');
  }
};

pc.onicecandidate = (event) => {
  if (!event.candidate) return;
  const payload = { candidate: event.candidate };
  if (adminSocketId) {
    payload.to = adminSocketId;
  }
  emitWithAck('ice-candidate', payload).catch((error) => {
    console.error('Failed to send ICE candidate', error);
  });
};

socket.on('offer', async ({ from, sdp }) => {
  try {
    adminSocketId = from;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await emitWithAck('answer', { to: adminSocketId, sdp: pc.localDescription });
    setStatus('Receiving stream…', 'active');
  } catch (error) {
    console.error('Error handling offer', error);
    setStatus('Failed to establish connection.', 'error');
  }
});

socket.on('ice-candidate', ({ candidate }) => {
  if (!candidate) return;
  pc.addIceCandidate(new RTCIceCandidate(candidate)).catch((error) => {
    console.error('Failed to add ICE candidate', error);
  });
});

socket.on('session-ended', () => {
  setStatus('Session has ended.', 'warning');
  setSubtitle('The presenter left the call.');
  toggleLoader(false);
  adminSocketId = null;
  if (pc.connectionState !== 'closed') {
    pc.close();
  }
});

socket.on('connect_error', () => {
  setStatus('Connection error. Retrying…', 'warning');
  toggleLoader(true);
});

socket.on('disconnect', () => {
  setStatus('Disconnected from server.', 'warning');
  toggleLoader(true);
});

joinSession();