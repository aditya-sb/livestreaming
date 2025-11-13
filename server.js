// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const Session = require('./models/Session');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connect to MongoDB
const MONGO = process.env.MONGO || 'mongodb://localhost:27017/live_sessions';
mongoose.connect(MONGO, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(()=>console.log('Mongo connected'))
  .catch(console.error);

// API to create session (admin calls this)
app.post('/api/session', async (req, res) => {
  // type fixed 'admin' for this task
  const unique_id = randomUUID();
  const userurl = `${req.protocol}://${req.get('host')}/session/${unique_id}`;
  try {
    const session = new Session({ type: 'admin', unique_id, userurl });
    await session.save();
    res.json({ unique_id, userurl });
  } catch (error) {
    console.error('Failed to create session', error);
    res.status(500).json({ error: 'Unable to create session, please try again.' });
  }
});

// Simple route to serve student/admin pages by URL
app.get('/session/:id', (req, res) => {
  // student page - public/student.html detects if it's admin or student by param or another route
  res.sendFile(path.join(__dirname, 'public', 'student.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

/*
Socket.IO signaling:
- Admin emits 'admin-join' with unique_id.
- Student emits 'student-join' with unique_id.
- When student connects, server notifies admin (server forwards messages).
- Signaling messages:
  'offer' - admin -> student (server forwards)
  'answer' - student -> admin (server forwards)
  'ice-candidate' - either direction -> forwarded
*/

io.on('connection', (socket) => {
  console.log('Socket connected', socket.id);

  socket.on('admin-join', async (data = {}, callback = () => {}) => {
    const { unique_id } = data;
    if (!unique_id) {
      callback({ ok: false, error: 'Missing session id.' });
      return;
    }

    try {
      const session = await Session.findOne({ unique_id });
      if (!session) {
        callback({ ok: false, error: 'Session not found.' });
        return;
      }

      socket.join(unique_id);
      socket.role = 'admin';
      socket.unique_id = unique_id;
      console.log(`Admin joined room ${unique_id}`);
      callback({ ok: true, socketId: socket.id });
    } catch (error) {
      console.error('admin-join error', error);
      callback({ ok: false, error: 'Unable to join session.' });
    }
  });

  socket.on('student-join', async (data = {}, callback = () => {}) => {
    const { unique_id } = data;
    if (!unique_id) {
      callback({ ok: false, error: 'Missing session id.' });
      return;
    }

    try {
      const session = await Session.findOne({ unique_id, active: true });
      if (!session) {
        callback({ ok: false, error: 'Session not found or inactive.' });
        return;
      }

      socket.join(unique_id);
      socket.role = 'student';
      socket.unique_id = unique_id;
      console.log(`Student ${socket.id} joined room ${unique_id}`);
      socket.to(unique_id).emit('student-connected', { studentSocketId: socket.id });
      callback({ ok: true, socketId: socket.id });
    } catch (error) {
      console.error('student-join error', error);
      callback({ ok: false, error: 'Unable to join session.' });
    }
  });

  // forward offer from admin to a specific student
  socket.on('offer', (payload = {}, callback = () => {}) => {
    const { to } = payload;
    if (!to) {
      callback({ ok: false, error: 'Missing target socket id.' });
      return;
    }

    io.to(to).emit('offer', { ...payload, from: socket.id });
    callback({ ok: true });
  });

  // forward answer from student to admin (to admin socket id)
  socket.on('answer', (payload = {}, callback = () => {}) => {
    const { to } = payload;
    if (!to) {
      callback({ ok: false, error: 'Missing target socket id.' });
      return;
    }
    io.to(to).emit('answer', { ...payload, from: socket.id });
    callback({ ok: true });
  });

  // forward ICE candidates
  socket.on('ice-candidate', (payload = {}, callback = () => {}) => {
    const message = { ...payload, from: socket.id };
    if (payload.to) {
      io.to(payload.to).emit('ice-candidate', message);
      callback({ ok: true });
      return;
    }

    if (socket.unique_id) {
      socket.to(socket.unique_id).emit('ice-candidate', message);
      callback({ ok: true });
      return;
    }

    callback({ ok: false, error: 'No target specified.' });
  });

  socket.on('admin-end-session', async (payload = {}, callback = () => {}) => {
    const { unique_id } = payload;
    if (socket.role !== 'admin' || !socket.unique_id || socket.unique_id !== unique_id) {
      callback({ ok: false, error: 'Not authorized.' });
      return;
    }

    try {
      await Session.findOneAndUpdate({ unique_id }, { active: false });
      socket.to(unique_id).emit('session-ended');

      const peers = await io.in(unique_id).fetchSockets();
      await Promise.all(peers.map((peer) => peer.leave(unique_id)));
      socket.leave(unique_id);
      socket.unique_id = null;

      callback({ ok: true });
    } catch (error) {
      console.error('admin-end-session error', error);
      callback({ ok: false, error: 'Failed to end session.' });
    }
  });

  socket.on('disconnect', async () => {
    console.log('Socket disconnected', socket.id, socket.unique_id, socket.role);
    // If admin disconnected, mark session inactive
    if (socket.role === 'admin' && socket.unique_id) {
      try {
        await Session.findOneAndUpdate({ unique_id: socket.unique_id }, { active: false });
        socket.to(socket.unique_id).emit('session-ended');
      } catch (e) { console.error(e); }
    }

    if (socket.role === 'student' && socket.unique_id) {
      socket.to(socket.unique_id).emit('student-disconnected', { studentSocketId: socket.id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
