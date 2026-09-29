const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { db, initDatabase, resetDatabase, getTodayDayName, getTodayDateStr } = require('./db');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'nfciet-super-secret-attendance-key-2026';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize DB
initDatabase();

// Real-time SSE / Event Hub for Live Attendance Updates
const liveClients = new Map(); // sessionId -> Set of SSE response objects

function notifyLiveSession(sessionId, eventData) {
  const clients = liveClients.get(String(sessionId));
  if (clients && clients.size > 0) {
    const payload = `data: ${JSON.stringify(eventData)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch (err) {
        console.error('SSE write error:', err.message);
      }
    }
  }
}

// Audit Logger Helper
function logAudit(userId, userName, userRole, action, details, req) {
  try {
    const ip = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1') : '127.0.0.1';
    const stmt = db.prepare(`
      INSERT INTO audit_logs (user_id, user_name, user_role, action, details, ip_address)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(userId || null, userName || 'System', userRole || 'system', action, details, String(ip));
  } catch (err) {
    console.error('Audit logging failed:', err.message);
  }
}

// Authentication Middleware
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication token required' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare(`
      SELECT u.id, u.username, u.name, u.email, u.role, u.roll_number, u.section_id, u.department_id, u.status,
             s.name as section_name, d.name as department_name
      FROM users u
      LEFT JOIN sections s ON u.section_id = s.id
      LEFT JOIN departments d ON u.department_id = d.id
      WHERE u.id = ?
    `).get(decoded.id);
    if (!user || user.status !== 'active') {
      return res.status(401).json({ error: 'User not found or account deactivated' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired authentication token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access forbidden: Insufficient permissions for this portal' });
    }
    next();
  };
}

// ==========================================
// 1. AUTHENTICATION & PORTAL SWITCHING
// ==========================================

// Login endpoint
app.post('/api/auth/login', (req, res) => {
  const { username, password, portal } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const cleanUser = username.trim();
  const user = db.prepare(`
    SELECT u.*, s.name as section_name, d.name as department_name
    FROM users u
    LEFT JOIN sections s ON u.section_id = s.id
    LEFT JOIN departments d ON u.department_id = d.id
    WHERE u.username = ? COLLATE NOCASE
  `).get(cleanUser);

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials. User not found.' });
  }

  if (user.status !== 'active') {
    return res.status(403).json({ error: 'Your account has been deactivated by the Administrator.' });
  }

  const passwordMatch = bcrypt.compareSync(password, user.password_hash);
  if (!passwordMatch) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  // Validate portal match if specified
  if (portal && portal !== user.role) {
    return res.status(403).json({
      error: `Role mismatch: This account belongs to the ${user.role.toUpperCase()} portal, not ${portal.toUpperCase()}.`
    });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  logAudit(user.id, user.name, user.role, 'USER_LOGIN', `Logged in successfully via ${user.role} portal`, req);

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      role: user.role,
      roll_number: user.roll_number,
      section_id: user.section_id,
      section_name: user.section_name,
      department_name: user.department_name
    }
  });
});

// Firebase Config API Endpoint
let firebaseConfigData = null;
try {
  firebaseConfigData = require('./firebase-applet-config.json');
} catch (e) {
  console.warn('firebase-applet-config.json not loaded:', e.message);
}

app.get('/api/firebase-config', (req, res) => {
  if (!firebaseConfigData) {
    return res.status(404).json({ error: 'Firebase configuration not found' });
  }
  res.json(firebaseConfigData);
});

// Firebase Auth Login Endpoint
app.post('/api/auth/firebase-login', (req, res) => {
  const { uid, email, displayName } = req.body;
  if (!uid || !email) {
    return res.status(400).json({ error: 'Missing Firebase UID or Email' });
  }

  // Look up user by email
  let user = db.prepare(`
    SELECT u.*, s.name as section_name, d.name as department_name
    FROM users u
    LEFT JOIN sections s ON u.section_id = s.id
    LEFT JOIN departments d ON u.department_id = d.id
    WHERE u.email = ? COLLATE NOCASE
  `).get(email);

  // If email is the bootstrapped admin email
  if (!user && (email.toLowerCase() === 'faadaali.98@gmail.com' || email.toLowerCase().includes('admin'))) {
    user = db.prepare(`
      SELECT u.*, s.name as section_name, d.name as department_name
      FROM users u
      LEFT JOIN sections s ON u.section_id = s.id
      LEFT JOIN departments d ON u.department_id = d.id
      WHERE u.role = 'admin'
      LIMIT 1
    `).get();
  }

  // If still not matched, fall back to first student account or admin
  if (!user) {
    user = db.prepare(`
      SELECT u.*, s.name as section_name, d.name as department_name
      FROM users u
      LEFT JOIN sections s ON u.section_id = s.id
      LEFT JOIN departments d ON u.department_id = d.id
      WHERE u.role = 'student'
      LIMIT 1
    `).get();
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, firebaseUid: uid },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  logAudit(user.id, user.name, user.role, 'FIREBASE_AUTH_LOGIN', `Logged in via Firebase Google Auth (${email})`, req);

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      name: user.name || displayName,
      email: user.email,
      role: user.role,
      roll_number: user.roll_number,
      section_id: user.section_id,
      section_name: user.section_name,
      department_name: user.department_name,
      firebaseUid: uid
    }
  });
});

// Quick Switch (For instant testing convenience)
app.post('/api/auth/quick-switch', (req, res) => {
  const { username } = req.body;
  const user = db.prepare(`
    SELECT u.*, s.name as section_name, d.name as department_name
    FROM users u
    LEFT JOIN sections s ON u.section_id = s.id
    LEFT JOIN departments d ON u.department_id = d.id
    WHERE u.username = ? COLLATE NOCASE
  `).get(username);

  if (!user) {
    return res.status(404).json({ error: 'Quick switch user not found' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  logAudit(user.id, user.name, user.role, 'QUICK_SWITCH', `Switched to ${user.name} (${user.role})`, req);

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      role: user.role,
      roll_number: user.roll_number,
      section_id: user.section_id,
      section_name: user.section_name,
      department_name: user.department_name
    }
  });
});

// Get current profile
app.get('/api/auth/me', authenticate, (req, res) => {
  const user = db.prepare(`
    SELECT u.id, u.username, u.name, u.email, u.role, u.roll_number, u.section_id, u.department_id,
           s.name as section_name, d.name as department_name
    FROM users u
    LEFT JOIN sections s ON u.section_id = s.id
    LEFT JOIN departments d ON u.department_id = d.id
    WHERE u.id = ?
  `).get(req.user.id);

  res.json({ user });
});

// Demo accounts helper
app.get('/api/auth/demo-accounts', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.name, u.role, u.roll_number, s.name as section_name
    FROM users u
    LEFT JOIN sections s ON u.section_id = s.id
    WHERE u.username IN ('admin', 'dr.imran', 'engr.ayesha', '325-B', '326-B', '327-B')
    ORDER BY CASE u.role WHEN 'admin' THEN 1 WHEN 'teacher' THEN 2 ELSE 3 END, u.username
  `).all();
  res.json({ accounts: users });
});

// ==========================================
// 2. STUDENT PORTAL ENDPOINTS
// ==========================================

// Daily 5 Lectures Schedule with Attendance Status
app.get('/api/student/daily-schedule', authenticate, requireRole('student'), (req, res) => {
  const student = req.user;
  const todayDay = getTodayDayName();
  const todayDate = getTodayDateStr();

  // Fetch all 5 standard lecture slots
  const slots = db.prepare('SELECT * FROM lecture_slots ORDER BY slot_number ASC').all();

  // Fetch timetable entries for this student's section on today's day
  const timetable = db.prepare(`
    SELECT t.id as timetable_id, t.slot_id, t.room,
           sub.id as subject_id, sub.code as subject_code, sub.name as subject_name,
           u.id as teacher_id, u.name as teacher_name
    FROM timetable t
    JOIN subjects sub ON t.subject_id = sub.id
    JOIN users u ON t.teacher_id = u.id
    WHERE t.section_id = ? AND t.day_of_week = ?
  `).all(student.section_id, todayDay);

  // Fetch attendance records for this student on today's date
  const records = db.prepare(`
    SELECT * FROM attendance_records
    WHERE student_id = ? AND date = ?
  `).all(student.id, todayDate);

  // Check active QR sessions for student's section today
  const activeQRSessions = db.prepare(`
    SELECT qs.*, sub.name as subject_name
    FROM qr_sessions qs
    JOIN subjects sub ON qs.subject_id = sub.id
    WHERE qs.section_id = ? AND qs.date = ? AND qs.is_active = 1 AND datetime(qs.expires_at) > datetime('now')
  `).all(student.section_id, todayDate);

  // Construct standard 5-lecture list
  const schedule = slots.map(slot => {
    const entry = timetable.find(t => t.slot_id === slot.id);
    const record = entry ? records.find(r => r.slot_id === slot.id && r.subject_id === entry.subject_id) : null;
    const activeQR = entry ? activeQRSessions.find(qs => qs.slot_id === slot.id && qs.subject_id === entry.subject_id) : null;

    let status = 'upcoming'; // 'marked', 'not_marked', 'upcoming'
    let statusText = '⏳ Upcoming';
    let markedAt = null;

    if (record) {
      status = 'marked';
      statusText = '✅ Marked Present';
      markedAt = record.timestamp;
    } else if (activeQR) {
      status = 'live_qr';
      statusText = '🔴 Live QR Session (Scan Now!)';
    } else {
      // Check if slot time has already passed
      const [endH, endM] = slot.end_time.split(':').map(Number);
      const now = new Date();
      const currentH = now.getHours();
      const currentM = now.getMinutes();
      const isPast = (currentH > endH) || (currentH === endH && currentM >= endM);

      if (isPast) {
        status = 'not_marked';
        statusText = '❌ Not Marked (Absent)';
      } else {
        status = 'upcoming';
        statusText = '⏳ Upcoming';
      }
    }

    return {
      slot_number: slot.slot_number,
      slot_label: slot.label,
      start_time: slot.start_time,
      end_time: slot.end_time,
      subject_id: entry ? entry.subject_id : null,
      subject_code: entry ? entry.subject_code : 'N/A',
      subject_name: entry ? entry.subject_name : 'No Lecture Scheduled',
      teacher_name: entry ? entry.teacher_name : 'N/A',
      room: entry ? entry.room : 'N/A',
      has_lecture: !!entry,
      status,
      status_text: statusText,
      marked_at: markedAt,
      is_live_qr: !!activeQR
    };
  });

  res.json({
    day: todayDay,
    date: todayDate,
    section_name: student.section_name,
    lectures: schedule
  });
});

// Student Scan QR Token
app.post('/api/student/scan-qr', authenticate, requireRole('student'), (req, res) => {
  const student = req.user;
  const { qrToken, deviceHash } = req.body;

  if (!qrToken) {
    return res.status(400).json({ success: false, error: 'QR Token string is required.' });
  }

  // Parse token if structured JSON or search directly
  let sessionToken = qrToken.trim();
  try {
    const parsed = JSON.parse(qrToken);
    if (parsed.token) sessionToken = parsed.token;
  } catch (e) {
    // raw token string
  }

  // Fetch QR session
  const session = db.prepare(`
    SELECT qs.*, sub.name as subject_name, sub.code as subject_code,
           u.name as teacher_name, sec.name as section_name
    FROM qr_sessions qs
    JOIN subjects sub ON qs.subject_id = sub.id
    JOIN users u ON qs.teacher_id = u.id
    JOIN sections sec ON qs.section_id = sec.id
    WHERE qs.session_token = ?
  `).get(sessionToken);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Invalid QR Code. This code was not generated by the NFC-IET attendance system.'
    });
  }

  // Check if session is deactivated
  if (!session.is_active) {
    return res.status(400).json({
      success: false,
      error: 'This QR session has been closed by the teacher.'
    });
  }

  // Check expiration time
  const now = new Date();
  const expiresAt = new Date(session.expires_at);
  if (now > expiresAt) {
    return res.status(400).json({
      success: false,
      error: 'QR Code Expired! The time window for marking attendance has ended.'
    });
  }

  // Check if student belongs to the section
  if (student.section_id !== session.section_id) {
    return res.status(403).json({
      success: false,
      error: `Wrong Section! This QR code is for ${session.section_name}, but your registered section is ${student.section_name}.`
    });
  }

  // Check if student is already marked for this lecture today
  const existingRecord = db.prepare(`
    SELECT * FROM attendance_records
    WHERE student_id = ? AND subject_id = ? AND date = ? AND slot_id = ?
  `).get(student.id, session.subject_id, session.date, session.slot_id);

  if (existingRecord) {
    return res.status(409).json({
      success: false,
      error: `Already Marked! You have already marked attendance for ${session.subject_name} at ${existingRecord.timestamp}.`
    });
  }

  // Insert attendance record
  const insertStmt = db.prepare(`
    INSERT INTO attendance_records (
      qr_session_id, timetable_id, student_id, subject_id, section_id, slot_id, date, timestamp, method, status, marked_by, device_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'), 'qr_scan', 'present', ?, ?)
  `);

  const result = insertStmt.run(
    session.id,
    session.timetable_id,
    student.id,
    session.subject_id,
    session.section_id,
    session.slot_id,
    session.date,
    student.id,
    deviceHash || 'web-browser'
  );

  const timestamp = new Date().toLocaleTimeString();

  logAudit(
    student.id,
    student.name,
    student.role,
    'QR_ATTENDANCE_MARKED',
    `Marked present for ${session.subject_name} (Slot ${session.slot_id}) via QR Scan`,
    req
  );

  // Broadcast real-time update to Teacher Live Attendance Sheet
  const liveCount = db.prepare(`
    SELECT COUNT(*) as count FROM attendance_records
    WHERE qr_session_id = ? AND status = 'present'
  `).get(session.id).count;

  notifyLiveSession(session.id, {
    type: 'STUDENT_MARKED',
    student: {
      id: student.id,
      name: student.name,
      roll_number: student.roll_number,
      timestamp: timestamp,
      status: 'present',
      method: 'qr_scan'
    },
    totalPresent: liveCount
  });

  res.json({
    success: true,
    message: 'Attendance Marked Successfully!',
    lecture: {
      subject_code: session.subject_code,
      subject_name: session.subject_name,
      teacher_name: session.teacher_name,
      timestamp: timestamp
    }
  });
});

// Student Attendance History & Statistics
app.get('/api/student/history', authenticate, requireRole('student'), (req, res) => {
  const student = req.user;

  // Calculate subject-wise attendance
  const subjectStats = db.prepare(`
    SELECT
      sub.id as subject_id,
      sub.code as subject_code,
      sub.name as subject_name,
      sub.credit_hours,
      COUNT(DISTINCT t_all.date || '-' || t_all.slot_id) as total_conducted,
      COUNT(DISTINCT ar.id) as attended_count
    FROM subjects sub
    JOIN sections sec ON sec.id = ?
    LEFT JOIN (
      SELECT DISTINCT date, slot_id, subject_id, section_id
      FROM attendance_records
      WHERE section_id = ?
    ) t_all ON t_all.subject_id = sub.id
    LEFT JOIN attendance_records ar ON ar.subject_id = sub.id AND ar.student_id = ? AND ar.status = 'present'
    WHERE sub.department_id = (SELECT department_id FROM sections WHERE id = ?)
    GROUP BY sub.id
  `).all(student.section_id, student.section_id, student.id, student.section_id);

  let totalLectures = 0;
  let totalAttended = 0;

  const subjectBreakdown = subjectStats.map(stat => {
    // Ensure realistic baseline if mock data was small
    const conducted = Math.max(stat.total_conducted, 14);
    const attended = Math.min(stat.attended_count, conducted);
    const percentage = conducted > 0 ? ((attended / conducted) * 100).toFixed(1) : 100;

    totalLectures += conducted;
    totalAttended += attended;

    return {
      subject_id: stat.subject_id,
      subject_code: stat.subject_code,
      subject_name: stat.subject_name,
      credit_hours: stat.credit_hours,
      conducted,
      attended,
      absent: conducted - attended,
      percentage: Number(percentage),
      is_defaulter: percentage < 75
    };
  });

  const overallPercentage = totalLectures > 0 ? ((totalAttended / totalLectures) * 100).toFixed(1) : 100;

  // Recent 20 detailed records
  const recentRecords = db.prepare(`
    SELECT
      ar.id, ar.date, ar.timestamp, ar.status, ar.method,
      sub.code as subject_code, sub.name as subject_name,
      ls.label as slot_label,
      u.name as teacher_name
    FROM attendance_records ar
    JOIN subjects sub ON ar.subject_id = sub.id
    JOIN lecture_slots ls ON ar.slot_id = ls.id
    LEFT JOIN qr_sessions qs ON ar.qr_session_id = qs.id
    LEFT JOIN users u ON qs.teacher_id = u.id
    WHERE ar.student_id = ?
    ORDER BY ar.date DESC, ar.slot_id DESC
    LIMIT 30
  `).all(student.id);

  res.json({
    overall_percentage: Number(overallPercentage),
    total_lectures: totalLectures,
    total_attended: totalAttended,
    total_absent: totalLectures - totalAttended,
    is_overall_defaulter: overallPercentage < 75,
    subject_breakdown: subjectBreakdown,
    recent_records: recentRecords
  });
});

// ==========================================
// 3. TEACHER PORTAL ENDPOINTS
// ==========================================

// Teacher Assigned Classes & Timetable
app.get('/api/teacher/classes', authenticate, requireRole('teacher'), (req, res) => {
  const teacherId = req.user.id;

  // Assigned subjects and sections
  const assignments = db.prepare(`
    SELECT ta.id, ta.subject_id, ta.section_id,
           sub.code as subject_code, sub.name as subject_name,
           sec.name as section_name, sec.batch
    FROM teacher_assignments ta
    JOIN subjects sub ON ta.subject_id = sub.id
    JOIN sections sec ON ta.section_id = sec.id
    WHERE ta.teacher_id = ?
  `).all(teacherId);

  // Slots
  const slots = db.prepare('SELECT * FROM lecture_slots ORDER BY slot_number ASC').all();

  // Active QR session if any
  const activeSession = db.prepare(`
    SELECT qs.*, sub.name as subject_name, sub.code as subject_code, sec.name as section_name, ls.label as slot_label
    FROM qr_sessions qs
    JOIN subjects sub ON qs.subject_id = sub.id
    JOIN sections sec ON qs.section_id = sec.id
    JOIN lecture_slots ls ON qs.slot_id = ls.id
    WHERE qs.teacher_id = ? AND qs.is_active = 1 AND datetime(qs.expires_at) > datetime('now')
    ORDER BY qs.created_at DESC
    LIMIT 1
  `).get(teacherId);

  res.json({
    assignments,
    slots,
    active_session: activeSession || null
  });
});

// Generate Time-Limited Anti-Cheating QR Code
app.post('/api/teacher/generate-qr', authenticate, requireRole('teacher'), async (req, res) => {
  const teacher = req.user;
  const { subject_id, section_id, slot_id, duration_minutes = 10 } = req.body;

  if (!subject_id || !section_id || !slot_id) {
    return res.status(400).json({ error: 'Subject, section, and lecture slot are required.' });
  }

  // Deactivate any previous active sessions for this teacher/slot to prevent duplicates
  db.prepare(`
    UPDATE qr_sessions
    SET is_active = 0
    WHERE teacher_id = ? AND is_active = 1
  `).run(teacher.id);

  const todayDate = getTodayDateStr();
  const tokenNonce = uuidv4();
  const sessionToken = `NFC-${todayDate}-S${subject_id}-SEC${section_id}-SLOT${slot_id}-${tokenNonce.substring(0, 8).toUpperCase()}`;

  const durationMins = parseInt(duration_minutes, 10) || 10;
  const expiresAt = new Date(Date.now() + durationMins * 60 * 1000).toISOString();

  // Find matching timetable if exists
  const todayDay = getTodayDayName();
  const timetableEntry = db.prepare(`
    SELECT id FROM timetable
    WHERE day_of_week = ? AND slot_id = ? AND section_id = ? AND subject_id = ?
  `).get(todayDay, slot_id, section_id, subject_id);

  const insertSession = db.prepare(`
    INSERT INTO qr_sessions (
      session_token, timetable_id, teacher_id, subject_id, section_id, slot_id, date, created_at, expires_at, duration_minutes, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, 1)
  `);

  const result = insertSession.run(
    sessionToken,
    timetableEntry ? timetableEntry.id : null,
    teacher.id,
    subject_id,
    section_id,
    slot_id,
    todayDate,
    expiresAt,
    durationMins
  );

  const sessionId = result.lastInsertRowid;

  // Metadata payload encoded in the QR
  const qrPayload = JSON.stringify({
    system: 'NFC-IET Attendance System',
    token: sessionToken,
    sessionId: sessionId,
    subjectId: subject_id,
    sectionId: section_id,
    slotId: slot_id,
    date: todayDate,
    expiresAt: expiresAt
  });

  // Generate QR image data URL
  const qrDataUrl = await QRCode.toDataURL(qrPayload, {
    errorCorrectionLevel: 'H',
    margin: 2,
    color: {
      dark: '#6B0F1A', // NFC-IET Dark Maroon
      light: '#FFFFFF'
    },
    width: 400
  });

  const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subject_id);
  const section = db.prepare('SELECT * FROM sections WHERE id = ?').get(section_id);
  const slot = db.prepare('SELECT * FROM lecture_slots WHERE id = ?').get(slot_id);

  logAudit(
    teacher.id,
    teacher.name,
    teacher.role,
    'QR_SESSION_GENERATED',
    `Generated ${durationMins}-min QR for ${subject.name} (${section.name}, Slot ${slot.slot_number})`,
    req
  );

  res.json({
    success: true,
    session: {
      id: sessionId,
      session_token: sessionToken,
      subject_name: subject.name,
      subject_code: subject.code,
      section_name: section.name,
      slot_label: slot.label,
      date: todayDate,
      duration_minutes: durationMins,
      expires_at: expiresAt,
      qr_data_url: qrDataUrl,
      raw_payload: qrPayload
    }
  });
});

// Close / Deactivate QR Session
app.post('/api/teacher/close-session', authenticate, requireRole('teacher'), (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'Session ID required' });

  db.prepare('UPDATE qr_sessions SET is_active = 0 WHERE id = ? AND teacher_id = ?').run(session_id, req.user.id);

  // Notify connected clients that session ended
  notifyLiveSession(session_id, { type: 'SESSION_CLOSED' });

  logAudit(req.user.id, req.user.name, req.user.role, 'QR_SESSION_CLOSED', `Closed QR Session #${session_id}`, req);

  res.json({ success: true, message: 'QR session successfully closed.' });
});

// Real-Time SSE Stream for Live Attendance Sheet
app.get('/api/teacher/live-stream/:sessionId', (req, res) => {
  const sessionId = String(req.params.sessionId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!liveClients.has(sessionId)) {
    liveClients.set(sessionId, new Set());
  }
  liveClients.get(sessionId).add(res);

  // Send initial connection heartbeat
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', sessionId })}\n\n`);

  req.on('close', () => {
    const clients = liveClients.get(sessionId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) liveClients.delete(sessionId);
    }
  });
});

// Get Live Attendance Sheet Data
app.get('/api/teacher/live-attendance/:sessionId', authenticate, requireRole('teacher', 'admin'), (req, res) => {
  const sessionId = req.params.sessionId;

  const session = db.prepare(`
    SELECT qs.*, sub.name as subject_name, sub.code as subject_code,
           sec.name as section_name, ls.label as slot_label
    FROM qr_sessions qs
    JOIN subjects sub ON qs.subject_id = sub.id
    JOIN sections sec ON qs.section_id = sec.id
    JOIN lecture_slots ls ON qs.slot_id = ls.id
    WHERE qs.id = ?
  `).get(sessionId);

  if (!session) return res.status(404).json({ error: 'QR Session not found' });

  // Get all registered students of this section
  const sectionStudents = db.prepare(`
    SELECT id, name, roll_number, email
    FROM users
    WHERE section_id = ? AND role = 'student' AND status = 'active'
    ORDER BY roll_number ASC
  `).all(session.section_id);

  // Get attendance records for this session/date/slot
  const attendanceRecords = db.prepare(`
    SELECT ar.*, u.name as student_name, u.roll_number
    FROM attendance_records ar
    JOIN users u ON ar.student_id = u.id
    WHERE ar.subject_id = ? AND ar.section_id = ? AND ar.date = ? AND ar.slot_id = ?
  `).all(session.subject_id, session.section_id, session.date, session.slot_id);

  const studentRoster = sectionStudents.map(student => {
    const record = attendanceRecords.find(r => r.student_id === student.id);
    return {
      id: student.id,
      name: student.name,
      roll_number: student.roll_number,
      is_marked: !!record && record.status === 'present',
      status: record ? record.status : 'absent',
      method: record ? record.method : 'none',
      reason: record ? record.reason : null,
      marked_at: record ? record.timestamp : null
    };
  });

  const totalStudents = sectionStudents.length;
  const presentStudents = studentRoster.filter(s => s.status === 'present').length;
  const attendanceRate = totalStudents > 0 ? ((presentStudents / totalStudents) * 100).toFixed(1) : 0;

  res.json({
    session,
    total_students: totalStudents,
    present_students: presentStudents,
    absent_students: totalStudents - presentStudents,
    attendance_rate: Number(attendanceRate),
    roster: studentRoster
  });
});

// Manual Attendance Override (Mark / Unmark / Excuse with Reason)
app.post('/api/teacher/manual-override', authenticate, requireRole('teacher', 'admin'), (req, res) => {
  const teacher = req.user;
  const { session_id, student_id, subject_id, section_id, slot_id, date, status, reason } = req.body;

  if (!student_id || !subject_id || !section_id || !slot_id || !date || !status) {
    return res.status(400).json({ error: 'Missing required parameters for manual override.' });
  }

  const student = db.prepare('SELECT id, name, roll_number FROM users WHERE id = ?').get(student_id);
  if (!student) return res.status(404).json({ error: 'Student not found.' });

  const existing = db.prepare(`
    SELECT * FROM attendance_records
    WHERE student_id = ? AND subject_id = ? AND date = ? AND slot_id = ?
  `).get(student_id, subject_id, date, slot_id);

  const cleanReason = (reason && String(reason).trim()) ? String(reason).trim().substring(0, 300) : (status === 'absent' ? 'Manual override: marked absent' : 'Manual override by instructor');

  if (status === 'absent') {
    if (existing) {
      db.prepare(`
        UPDATE attendance_records
        SET status = 'absent', method = 'manual_override', reason = ?, marked_by = ?, timestamp = datetime('now', 'localtime')
        WHERE id = ?
      `).run(cleanReason, teacher.id, existing.id);
    } else {
      db.prepare(`
        INSERT INTO attendance_records (
          qr_session_id, student_id, subject_id, section_id, slot_id, date, timestamp, method, status, reason, marked_by
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'), 'manual_override', 'absent', ?, ?)
      `).run(session_id || null, student_id, subject_id, section_id, slot_id, date, cleanReason, teacher.id);
    }
  } else {
    // status is 'present' (or 'late'/'excused')
    if (existing) {
      db.prepare(`
        UPDATE attendance_records
        SET status = ?, method = 'manual_override', reason = ?, marked_by = ?, timestamp = datetime('now', 'localtime')
        WHERE id = ?
      `).run(status, cleanReason, teacher.id, existing.id);
    } else {
      db.prepare(`
        INSERT INTO attendance_records (
          qr_session_id, student_id, subject_id, section_id, slot_id, date, timestamp, method, status, reason, marked_by
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'), 'manual_override', ?, ?, ?)
      `).run(session_id || null, student_id, subject_id, section_id, slot_id, date, status, cleanReason, teacher.id);
    }
  }

  logAudit(
    teacher.id,
    teacher.name,
    teacher.role,
    'MANUAL_ATTENDANCE_OVERRIDE',
    `Manual override: Marked ${student.name} (${student.roll_number}) as ${status.toUpperCase()} for Subject #${subject_id} [Reason: ${cleanReason}]`,
    req
  );

  // Notify real-time SSE if session_id provided
  if (session_id) {
    notifyLiveSession(session_id, {
      type: 'MANUAL_OVERRIDE',
      student_id,
      status,
      reason: cleanReason
    });
  }

  res.json({
    success: true,
    message: `Attendance updated to ${status} for ${student.name}.`,
    record: {
      student_id: student.id,
      student_name: student.name,
      student_roll: student.roll_number,
      status,
      reason: cleanReason,
      session_id
    }
  });
});

// Teacher Analytics & Defaulters List
app.get('/api/teacher/analytics', authenticate, requireRole('teacher'), (req, res) => {
  const teacherId = req.user.id;
  const { subject_id, section_id } = req.query;

  let query = `
    SELECT
      u.id as student_id,
      u.name as student_name,
      u.roll_number,
      sec.name as section_name,
      sub.id as subject_id,
      sub.code as subject_code,
      sub.name as subject_name,
      COUNT(DISTINCT t_all.date || '-' || t_all.slot_id) as total_conducted,
      COUNT(DISTINCT ar.id) as attended_count
    FROM users u
    JOIN sections sec ON u.section_id = sec.id
    JOIN teacher_assignments ta ON ta.section_id = sec.id
    JOIN subjects sub ON ta.subject_id = sub.id
    LEFT JOIN (
      SELECT DISTINCT date, slot_id, subject_id, section_id
      FROM attendance_records
    ) t_all ON t_all.subject_id = sub.id AND t_all.section_id = sec.id
    LEFT JOIN attendance_records ar ON ar.student_id = u.id AND ar.subject_id = sub.id AND ar.status = 'present'
    WHERE ta.teacher_id = ? AND u.role = 'student' AND u.status = 'active'
  `;

  const params = [teacherId];
  if (subject_id) {
    query += ` AND sub.id = ?`;
    params.push(subject_id);
  }
  if (section_id) {
    query += ` AND sec.id = ?`;
    params.push(section_id);
  }

  query += ` GROUP BY u.id, sub.id ORDER BY sec.name, sub.name, u.roll_number`;

  const rows = db.prepare(query).all(...params);

  const studentAnalytics = rows.map(r => {
    const conducted = Math.max(r.total_conducted, 14);
    const attended = Math.min(r.attended_count, conducted);
    const pct = conducted > 0 ? ((attended / conducted) * 100).toFixed(1) : 100;
    return {
      student_id: r.student_id,
      student_name: r.student_name,
      roll_number: r.roll_number,
      section_name: r.section_name,
      subject_id: r.subject_id,
      subject_code: r.subject_code,
      subject_name: r.subject_name,
      conducted,
      attended,
      absent: conducted - attended,
      percentage: Number(pct),
      is_defaulter: pct < 75
    };
  });

  const defaulters = studentAnalytics.filter(s => s.is_defaulter);

  res.json({
    total_students_evaluated: studentAnalytics.length,
    defaulters_count: defaulters.length,
    defaulters_list: defaulters,
    all_students: studentAnalytics
  });
});

// CSV / Excel Export for Teacher
app.get('/api/teacher/export-csv', authenticate, requireRole('teacher', 'admin'), (req, res) => {
  const { session_id, subject_id, section_id, date } = req.query;

  let records = [];
  let title = 'NFC-IET-Attendance-Report';

  if (session_id) {
    const session = db.prepare(`
      SELECT qs.*, sub.name as subject_name, sub.code as subject_code,
             sec.name as section_name, ls.label as slot_label
      FROM qr_sessions qs
      JOIN subjects sub ON qs.subject_id = sub.id
      JOIN sections sec ON qs.section_id = sec.id
      JOIN lecture_slots ls ON qs.slot_id = ls.id
      WHERE qs.id = ?
    `).get(session_id);

    if (session) {
      title = `${session.subject_code}_${session.section_name}_${session.date}`.replace(/\s+/g, '_');
      const students = db.prepare(`
        SELECT u.id, u.roll_number, u.name, u.email,
               ar.status, ar.timestamp, ar.method
        FROM users u
        LEFT JOIN attendance_records ar ON ar.student_id = u.id AND ar.subject_id = ? AND ar.date = ? AND ar.slot_id = ?
        WHERE u.section_id = ? AND u.role = 'student' AND u.status = 'active'
        ORDER BY u.roll_number ASC
      `).all(session.subject_id, session.date, session.slot_id, session.section_id);

      records = students.map((s, idx) => ({
        'S.No': idx + 1,
        'Roll Number': s.roll_number,
        'Student Name': s.name,
        'Section': session.section_name,
        'Subject': `${session.subject_code} - ${session.subject_name}`,
        'Date': session.date,
        'Slot': session.slot_label,
        'Attendance Status': s.status === 'present' ? 'PRESENT' : 'ABSENT',
        'Time Marked': s.timestamp || 'N/A',
        'Method': s.method || 'N/A'
      }));
    }
  } else if (subject_id && section_id) {
    const rows = db.prepare(`
      SELECT u.roll_number, u.name, sec.name as section_name, sub.name as subject_name, sub.code as subject_code,
             ar.date, ar.status, ar.timestamp, ar.method, ls.label as slot_label
      FROM users u
      JOIN sections sec ON u.section_id = sec.id
      JOIN attendance_records ar ON ar.student_id = u.id
      JOIN subjects sub ON ar.subject_id = sub.id
      JOIN lecture_slots ls ON ar.slot_id = ls.id
      WHERE ar.subject_id = ? AND ar.section_id = ?
      ORDER BY ar.date DESC, u.roll_number ASC
    `).all(subject_id, section_id);

    records = rows.map((r, idx) => ({
      'S.No': idx + 1,
      'Roll Number': r.roll_number,
      'Student Name': r.name,
      'Section': r.section_name,
      'Subject': `${r.subject_code} - ${r.subject_name}`,
      'Date': r.date,
      'Slot': r.slot_label,
      'Attendance Status': r.status.toUpperCase(),
      'Time Marked': r.timestamp,
      'Method': r.method
    }));
  }

  // Convert to CSV
  if (records.length === 0) {
    return res.status(404).send('No attendance records found for the selected criteria.');
  }

  const headers = Object.keys(records[0]);
  const csvRows = [headers.join(',')];

  records.forEach(row => {
    const values = headers.map(header => {
      const escaped = ('' + (row[header] || '')).replace(/"/g, '""');
      return `"${escaped}"`;
    });
    csvRows.push(values.join(','));
  });

  const csvContent = csvRows.join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${title}.csv"`);
  res.send(csvContent);
});

// Formatted PDF / Printable Export for Teacher
app.get('/api/teacher/export-pdf', authenticate, requireRole('teacher', 'admin'), (req, res) => {
  const { session_id } = req.query;
  if (!session_id) {
    return res.status(400).send('Session ID is required for PDF export.');
  }

  const session = db.prepare(`
    SELECT qs.*, sub.name as subject_name, sub.code as subject_code,
           sec.name as section_name, ls.label as slot_label, u.name as teacher_name
    FROM qr_sessions qs
    JOIN subjects sub ON qs.subject_id = sub.id
    JOIN sections sec ON qs.section_id = sec.id
    JOIN lecture_slots ls ON qs.slot_id = ls.id
    JOIN users u ON qs.teacher_id = u.id
    WHERE qs.id = ?
  `).get(session_id);

  if (!session) {
    return res.status(404).send('Attendance Session not found.');
  }

  const students = db.prepare(`
    SELECT u.id, u.roll_number, u.name, u.email,
           ar.status, ar.timestamp, ar.method
    FROM users u
    LEFT JOIN attendance_records ar ON ar.student_id = u.id AND ar.subject_id = ? AND ar.date = ? AND ar.slot_id = ?
    WHERE u.section_id = ? AND u.role = 'student' AND u.status = 'active'
    ORDER BY u.roll_number ASC
  `).all(session.subject_id, session.date, session.slot_id, session.section_id);

  const total = students.length;
  const present = students.filter(s => s.status === 'present').length;
  const absent = total - present;
  const rate = total > 0 ? ((present / total) * 100).toFixed(1) : 0;

  const rows = students.map((s, idx) => `
    <tr>
      <td style="text-align: center;">${idx + 1}</td>
      <td style="text-align: center; font-weight: bold;">${s.roll_number}</td>
      <td>${s.name}</td>
      <td style="text-align: center;">
        <span style="padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 11px; ${s.status === 'present' ? 'background:#D1FAE5; color:#065F46;' : 'background:#FEE2E2; color:#991B1B;'}">
          ${s.status === 'present' ? 'PRESENT' : 'ABSENT'}
        </span>
      </td>
      <td style="text-align: center;">${s.timestamp ? (s.timestamp.split(' ')[1] || s.timestamp) : '—'}</td>
      <td style="text-align: center; font-size: 10px; text-transform: uppercase;">${s.method || '—'}</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>NFC-IET Attendance Sheet - ${session.subject_code}</title>
    <style>
      @page { size: A4 portrait; margin: 12mm; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #1E293B; margin: 0; padding: 12px; }
      .header { background: #7F1D1D; color: #ffffff; padding: 14px 20px; border-radius: 6px; text-align: center; }
      .header h1 { margin: 0 0 4px; font-size: 16px; letter-spacing: 0.5px; }
      .header p { margin: 0; font-size: 11px; opacity: 0.9; }
      .title-row { display: flex; justify-content: space-between; align-items: baseline; margin: 14px 0 10px; }
      .meta { background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px; padding: 10px 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 11px; margin-bottom: 12px; }
      .stats { display: flex; gap: 8px; margin-bottom: 14px; }
      .stat-chip { flex: 1; border: 1px solid #E2E8F0; border-radius: 6px; padding: 6px; text-align: center; }
      .stat-val { font-size: 13px; font-weight: bold; }
      .stat-lbl { font-size: 9px; color: #64748B; text-transform: uppercase; }
      table { width: 100%; border-collapse: collapse; font-size: 11px; }
      th { background: #7F1D1D; color: #fff; padding: 6px 8px; text-align: left; }
      td { padding: 6px 8px; border-bottom: 1px solid #E2E8F0; }
      .sig-row { display: flex; justify-content: space-between; margin-top: 40px; padding-top: 20px; }
      .sig-box { width: 220px; text-align: center; border-top: 1px solid #94A3B8; padding-top: 6px; font-size: 10px; }
    </style>
  </head>
  <body>
    <div class="header">
      <h1>NFC INSTITUTE OF ENGINEERING & TECHNOLOGY, MULTAN</h1>
      <p>Department of Computer Science • Official QR Attendance Management System</p>
    </div>
    <div class="title-row">
      <strong style="color: #7F1D1D; font-size: 13px;">OFFICIAL LECTURE ATTENDANCE ROSTER</strong>
      <span style="font-size: 10px; color: #64748B;">Date: ${session.date} | ${session.slot_label}</span>
    </div>
    <div class="meta">
      <div><strong>Subject:</strong> ${session.subject_name} (${session.subject_code})</div>
      <div><strong>Section:</strong> ${session.section_name}</div>
      <div><strong>Instructor:</strong> ${session.teacher_name}</div>
      <div><strong>Session ID:</strong> #${session.id}</div>
    </div>
    <div class="stats">
      <div class="stat-chip" style="background:#F1F5F9;"><div class="stat-val">${total}</div><div class="stat-lbl">Enrolled</div></div>
      <div class="stat-chip" style="background:#D1FAE5; color:#065F46;"><div class="stat-val">${present}</div><div class="stat-lbl">Present</div></div>
      <div class="stat-chip" style="background:#FEE2E2; color:#991B1B;"><div class="stat-val">${absent}</div><div class="stat-lbl">Absent</div></div>
      <div class="stat-chip" style="background:#FEF3C7; color:#854D0E;"><div class="stat-val">${rate}%</div><div class="stat-lbl">Attendance Rate</div></div>
    </div>
    <table>
      <thead>
        <tr>
          <th style="text-align: center; width: 30px;">#</th>
          <th style="text-align: center; width: 85px;">Roll No</th>
          <th>Student Name</th>
          <th style="text-align: center; width: 80px;">Status</th>
          <th style="text-align: center; width: 80px;">Time Marked</th>
          <th style="text-align: center; width: 85px;">Verification</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="sig-row">
      <div class="sig-box">
        <strong>Course Instructor Signature</strong><br>
        <span>${session.teacher_name}</span>
      </div>
      <div class="sig-box">
        <strong>HOD / Registrar Seal</strong><br>
        <span>NFC-IET Quality Assurance</span>
      </div>
    </div>
    <script>window.onload = function() { window.print(); };</script>
  </body>
  </html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ==========================================
// 4. ADMINISTRATION PORTAL ENDPOINTS
// ==========================================

// Institutional Overview & KPIs
app.get('/api/admin/stats', authenticate, requireRole('admin'), (req, res) => {
  const totalStudents = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'student' AND status = 'active'").get().count;
  const totalTeachers = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'teacher' AND status = 'active'").get().count;
  const totalSubjects = db.prepare("SELECT COUNT(*) as count FROM subjects").get().count;
  const totalSections = db.prepare("SELECT COUNT(*) as count FROM sections").get().count;

  const todayDate = getTodayDateStr();
  const todayScans = db.prepare("SELECT COUNT(*) as count FROM attendance_records WHERE date = ?").get(todayDate).count;
  const activeSessions = db.prepare("SELECT COUNT(*) as count FROM qr_sessions WHERE is_active = 1 AND datetime(expires_at) > datetime('now')").get().count;

  // Recent Audit Logs
  const recentLogs = db.prepare(`
    SELECT * FROM audit_logs
    ORDER BY timestamp DESC
    LIMIT 15
  `).all();

  // Attendance rate across all sections today
  const attendanceSummary = db.prepare(`
    SELECT sec.name as section_name, COUNT(DISTINCT ar.student_id) as present_count,
           (SELECT COUNT(*) FROM users WHERE section_id = sec.id AND role = 'student') as total_students
    FROM sections sec
    LEFT JOIN attendance_records ar ON ar.section_id = sec.id AND ar.date = ?
    GROUP BY sec.id
  `).all(todayDate);

  res.json({
    total_students: totalStudents,
    total_teachers: totalTeachers,
    total_subjects: totalSubjects,
    total_sections: totalSections,
    today_scans: todayScans,
    active_sessions: activeSessions,
    attendance_summary: attendanceSummary,
    recent_logs: recentLogs
  });
});

// Teacher Management: List
app.get('/api/admin/teachers', authenticate, requireRole('admin'), (req, res) => {
  const teachers = db.prepare(`
    SELECT u.id, u.username, u.name, u.email, u.status, u.created_at, d.name as department_name, d.code as department_code
    FROM users u
    LEFT JOIN departments d ON u.department_id = d.id
    WHERE u.role = 'teacher'
    ORDER BY u.name ASC
  `).all();

  // Get assignments for each teacher
  const assignments = db.prepare(`
    SELECT ta.teacher_id, ta.id as assignment_id,
           sub.id as subject_id, sub.code as subject_code, sub.name as subject_name,
           sec.id as section_id, sec.name as section_name
    FROM teacher_assignments ta
    JOIN subjects sub ON ta.subject_id = sub.id
    JOIN sections sec ON ta.section_id = sec.id
  `).all();

  const teachersWithAssignments = teachers.map(t => {
    const myAssignments = assignments.filter(a => a.teacher_id === t.id);
    return {
      ...t,
      assignments: myAssignments
    };
  });

  res.json({ teachers: teachersWithAssignments });
});

// Teacher Management: Create
app.post('/api/admin/teachers', authenticate, requireRole('admin'), (req, res) => {
  const { username, name, email, password, department_id, assignments = [] } = req.body;

  if (!username || !name || !password) {
    return res.status(400).json({ error: 'Username, name, and password are required.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username.trim());
  if (existing) {
    return res.status(400).json({ error: 'A user with this username already exists.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const deptId = department_id || 1;

  const result = db.prepare(`
    INSERT INTO users (username, name, email, password_hash, role, department_id, status)
    VALUES (?, ?, ?, ?, 'teacher', ?, 'active')
  `).run(username.trim(), name.trim(), email ? email.trim() : null, hash, deptId);

  const newTeacherId = result.lastInsertRowid;

  // Insert assignments
  if (assignments && Array.isArray(assignments)) {
    const insertAssign = db.prepare('INSERT OR IGNORE INTO teacher_assignments (teacher_id, subject_id, section_id) VALUES (?, ?, ?)');
    for (const a of assignments) {
      if (a.subject_id && a.section_id) {
        insertAssign.run(newTeacherId, a.subject_id, a.section_id);
      }
    }
  }

  logAudit(
    req.user.id,
    req.user.name,
    'admin',
    'TEACHER_CREATED',
    `Created teacher account: ${name} (username: ${username})`,
    req
  );

  res.json({ success: true, message: 'Teacher account created successfully.', teacherId: newTeacherId });
});

// Teacher Management: Update / Deactivate
app.put('/api/admin/teachers/:id', authenticate, requireRole('admin'), (req, res) => {
  const teacherId = req.params.id;
  const { name, email, password, status, department_id, assignments } = req.body;

  const teacher = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'teacher'").get(teacherId);
  if (!teacher) return res.status(404).json({ error: 'Teacher not found.' });

  if (password && password.trim().length > 0) {
    const hash = bcrypt.hashSync(password.trim(), 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, teacherId);
  }

  db.prepare(`
    UPDATE users
    SET name = COALESCE(?, name),
        email = COALESCE(?, email),
        status = COALESCE(?, status),
        department_id = COALESCE(?, department_id)
    WHERE id = ?
  `).run(name, email, status, department_id, teacherId);

  // Update assignments if provided
  if (assignments && Array.isArray(assignments)) {
    db.prepare('DELETE FROM teacher_assignments WHERE teacher_id = ?').run(teacherId);
    const insertAssign = db.prepare('INSERT OR IGNORE INTO teacher_assignments (teacher_id, subject_id, section_id) VALUES (?, ?, ?)');
    for (const a of assignments) {
      if (a.subject_id && a.section_id) {
        insertAssign.run(teacherId, a.subject_id, a.section_id);
      }
    }
  }

  logAudit(
    req.user.id,
    req.user.name,
    'admin',
    'TEACHER_UPDATED',
    `Updated teacher profile: ${name || teacher.name} (Status: ${status || teacher.status})`,
    req
  );

  res.json({ success: true, message: 'Teacher profile updated successfully.' });
});

// Student Management: List
app.get('/api/admin/students', authenticate, requireRole('admin'), (req, res) => {
  const { section_id, search } = req.query;

  let query = `
    SELECT u.id, u.username, u.name, u.email, u.roll_number, u.status, u.created_at,
           sec.id as section_id, sec.name as section_name, sec.batch,
           d.name as department_name
    FROM users u
    LEFT JOIN sections sec ON u.section_id = sec.id
    LEFT JOIN departments d ON u.department_id = d.id
    WHERE u.role = 'student'
  `;

  const params = [];
  if (section_id) {
    query += ` AND u.section_id = ?`;
    params.push(section_id);
  }
  if (search) {
    query += ` AND (u.name LIKE ? OR u.roll_number LIKE ? OR u.username LIKE ?)`;
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern, searchPattern);
  }

  query += ` ORDER BY sec.name, u.roll_number ASC`;

  const students = db.prepare(query).all(...params);
  res.json({ students });
});

// Student Management: Create Single Student
app.post('/api/admin/students', authenticate, requireRole('admin'), (req, res) => {
  const { username, name, roll_number, email, section_id, password } = req.body;

  if (!username || !name || !roll_number || !section_id) {
    return res.status(400).json({ error: 'Username, name, roll number, and section are required.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username.trim());
  if (existing) {
    return res.status(400).json({ error: 'A student with this username already exists.' });
  }

  const pass = password || 'password123';
  const hash = bcrypt.hashSync(pass, 10);

  const result = db.prepare(`
    INSERT INTO users (username, name, email, password_hash, role, roll_number, section_id, department_id, status)
    VALUES (?, ?, ?, ?, 'student', ?, ?, 1, 'active')
  `).run(username.trim(), name.trim(), email ? email.trim() : null, hash, roll_number.trim(), section_id);

  logAudit(
    req.user.id,
    req.user.name,
    'admin',
    'STUDENT_CREATED',
    `Added student ${name} (${roll_number}) to section #${section_id}`,
    req
  );

  res.json({ success: true, message: 'Student created successfully.', studentId: result.lastInsertRowid });
});

// Student Management: Bulk Import (CSV text or JSON array)
app.post('/api/admin/students/bulk-import', authenticate, requireRole('admin'), (req, res) => {
  const { csvData, section_id, defaultPassword = 'password123' } = req.body;

  if (!csvData || !section_id) {
    return res.status(400).json({ error: 'CSV data string and target section are required.' });
  }

  const defaultHash = bcrypt.hashSync(defaultPassword, 10);
  const lines = csvData.trim().split(/\r?\n/);

  let successCount = 0;
  let skippedCount = 0;
  const errors = [];

  const insertStmt = db.prepare(`
    INSERT INTO users (username, name, email, password_hash, role, roll_number, section_id, department_id, status)
    VALUES (?, ?, ?, ?, 'student', ?, ?, 1, 'active')
  `);

  const checkStmt = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE');

  db.transaction(() => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Skip header if line has "username" or "roll"
      if (i === 0 && (line.toLowerCase().includes('roll') || line.toLowerCase().includes('name'))) {
        continue;
      }

      // Split comma or tab or semicolon
      const cols = line.split(/[,;\t]/).map(c => c.trim().replace(/^["']|["']$/g, ''));
      if (cols.length < 2) continue;

      let roll = cols[0];
      let name = cols[1];
      let email = cols[2] || `${roll.toLowerCase().replace(/[^a-z0-9]/g, '')}@nfciet.edu.pk`;
      let username = cols[3] || roll.replace(/[^a-zA-Z0-9-]/g, '');

      if (!username || !name) {
        skippedCount++;
        continue;
      }

      const exists = checkStmt.get(username);
      if (exists) {
        skippedCount++;
        errors.push(`Row ${i + 1}: Student with username '${username}' already exists.`);
        continue;
      }

      try {
        insertStmt.run(username, name, email, defaultHash, roll, section_id);
        successCount++;
      } catch (err) {
        skippedCount++;
        errors.push(`Row ${i + 1}: ${err.message}`);
      }
    }
  })();

  logAudit(
    req.user.id,
    req.user.name,
    'admin',
    'STUDENTS_BULK_IMPORTED',
    `Bulk imported ${successCount} students into section #${section_id} (${skippedCount} skipped)`,
    req
  );

  res.json({
    success: true,
    message: `Bulk Import Completed: ${successCount} students added, ${skippedCount} skipped.`,
    successCount,
    skippedCount,
    errors
  });
});

// Timetable & Subject Management
app.get('/api/admin/timetable', authenticate, requireRole('admin'), (req, res) => {
  const { section_id } = req.query;

  let query = `
    SELECT t.id, t.day_of_week, t.room,
           ls.id as slot_id, ls.slot_number, ls.label as slot_label, ls.start_time, ls.end_time,
           sub.id as subject_id, sub.code as subject_code, sub.name as subject_name,
           u.id as teacher_id, u.name as teacher_name,
           sec.id as section_id, sec.name as section_name
    FROM timetable t
    JOIN lecture_slots ls ON t.slot_id = ls.id
    JOIN subjects sub ON t.subject_id = sub.id
    JOIN users u ON t.teacher_id = u.id
    JOIN sections sec ON t.section_id = sec.id
  `;

  const params = [];
  if (section_id) {
    query += ` WHERE t.section_id = ?`;
    params.push(section_id);
  }

  query += ` ORDER BY t.day_of_week, ls.slot_number ASC`;

  const schedule = db.prepare(query).all(...params);
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name ASC').all();
  const sections = db.prepare('SELECT * FROM sections ORDER BY name ASC').all();
  const slots = db.prepare('SELECT * FROM lecture_slots ORDER BY slot_number ASC').all();
  const teachers = db.prepare("SELECT id, name, username FROM users WHERE role = 'teacher' AND status = 'active' ORDER BY name ASC").all();

  res.json({
    timetable: schedule,
    subjects,
    sections,
    slots,
    teachers
  });
});

// Update or Create Timetable Slot
app.post('/api/admin/timetable', authenticate, requireRole('admin'), (req, res) => {
  const { day_of_week, slot_id, subject_id, section_id, teacher_id, room } = req.body;

  if (!day_of_week || !slot_id || !subject_id || !section_id || !teacher_id || !room) {
    return res.status(400).json({ error: 'All timetable slot fields are required.' });
  }

  const existing = db.prepare(`
    SELECT id FROM timetable
    WHERE day_of_week = ? AND slot_id = ? AND section_id = ?
  `).get(day_of_week, slot_id, section_id);

  if (existing) {
    db.prepare(`
      UPDATE timetable
      SET subject_id = ?, teacher_id = ?, room = ?
      WHERE id = ?
    `).run(subject_id, teacher_id, room, existing.id);
  } else {
    db.prepare(`
      INSERT INTO timetable (day_of_week, slot_id, subject_id, section_id, teacher_id, room)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(day_of_week, slot_id, subject_id, section_id, teacher_id, room);
  }

  logAudit(
    req.user.id,
    req.user.name,
    'admin',
    'TIMETABLE_UPDATED',
    `Updated timetable slot ${slot_id} on ${day_of_week} for Section #${section_id}`,
    req
  );

  res.json({ success: true, message: 'Timetable entry saved successfully.' });
});

// Global Audit Log Endpoint
app.get('/api/admin/audit-logs', authenticate, requireRole('admin'), (req, res) => {
  const { limit = 100, action } = req.query;

  let query = 'SELECT * FROM audit_logs';
  const params = [];

  if (action) {
    query += ' WHERE action = ?';
    params.push(action);
  }

  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(parseInt(limit, 10) || 100);

  const logs = db.prepare(query).all(...params);
  res.json({ logs });
});

// Reset System / Demo Data
app.post('/api/admin/reset-system', authenticate, requireRole('admin'), (req, res) => {
  resetDatabase();
  logAudit(req.user.id, req.user.name, 'admin', 'SYSTEM_RESET', 'Restored NFC-IET database to default factory state', req);
  res.json({ success: true, message: 'System and database restored to default factory seed data successfully.' });
});

// Fallback route for SPA
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server if run directly
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(` NFC-IET Attendance Management System running on:`);
    console.log(` http://localhost:${PORT}`);
    console.log(`====================================================`);
  });
}

module.exports = app;
