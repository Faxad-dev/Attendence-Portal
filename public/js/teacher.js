// ==========================================================================
// NFC-IET Attendance Management System - Teacher Portal
// QR Code Generator, Real-time Live Attendance Sheet, Manual Override & Export
// ==========================================================================

const TeacherPortal = {
  currentSession: null,
  countdownInterval: null,
  sseEventSource: null,

  async init() {
    console.log('Initializing Teacher Portal...');
    await this.loadTeacherClasses();
    await this.loadAnalytics();
    this.setupListeners();
  },

  // 1. Load Teacher Assigned Classes & Check Existing Active Session
  async loadTeacherClasses() {
    try {
      const res = await App.fetchApi('/api/teacher/classes');
      if (!res.ok) throw new Error('Failed to load classes');
      const data = await res.json();

      // Populate Subject & Section Dropdown
      const classSelect = document.getElementById('teacher-class-select');
      classSelect.innerHTML = '<option value="">-- Select Subject & Section --</option>';

      data.assignments.forEach(a => {
        const opt = document.createElement('option');
        opt.value = JSON.stringify({ subject_id: a.subject_id, section_id: a.section_id });
        opt.textContent = `${a.subject_name} (${a.subject_code}) - ${a.section_name}`;
        classSelect.appendChild(opt);
      });

      // Populate Lecture Slots Dropdown
      const slotSelect = document.getElementById('teacher-slot-select');
      slotSelect.innerHTML = '<option value="">-- Select Lecture Slot --</option>';
      data.slots.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `Slot #${s.slot_number}: ${s.label} (${s.start_time} - ${s.end_time})`;
        slotSelect.appendChild(opt);
      });

      // Default select first class & slot for fast demo
      if (data.assignments.length > 0) {
        classSelect.selectedIndex = 1;
      }
      if (data.slots.length > 0) {
        slotSelect.selectedIndex = 1;
      }

      // If there is already an active QR session, restore it
      if (data.active_session) {
        this.displayActiveSession(data.active_session);
      } else {
        this.resetSessionUI();
      }

    } catch (err) {
      console.error('Error loading teacher classes:', err);
    }
  },

  setupListeners() {
    // Generate QR Button
    const genBtn = document.getElementById('btn-generate-qr');
    if (genBtn) {
      genBtn.onclick = () => this.generateQRCode();
    }

    // Close Session Button
    const closeBtn = document.getElementById('btn-close-qr-session');
    if (closeBtn) {
      closeBtn.onclick = () => this.closeCurrentSession();
    }

    // Fullscreen Presentation Mode Button
    const fullBtn = document.getElementById('btn-fullscreen-qr');
    if (fullBtn) {
      fullBtn.onclick = () => this.openFullscreenQR();
    }

    const closeFullBtn = document.getElementById('btn-close-fullscreen');
    if (closeFullBtn) {
      closeFullBtn.onclick = () => this.closeFullscreenQR();
    }

    // Export CSV Button
    const exportBtn = document.getElementById('btn-export-session-csv');
    if (exportBtn) {
      exportBtn.onclick = () => this.exportCurrentSessionCSV();
    }
  },

  // 2. Generate Time-Limited Anti-Cheating QR Code
  async generateQRCode() {
    const classVal = document.getElementById('teacher-class-select').value;
    const slotId = document.getElementById('teacher-slot-select').value;
    const duration = document.getElementById('teacher-duration-select').value || 10;

    if (!classVal || !slotId) {
      Utils.showToast('Please select both a Class/Subject and a Lecture Slot.', 'warning');
      return;
    }

    const { subject_id, section_id } = JSON.parse(classVal);

    try {
      Utils.showToast('Generating live attendance QR session...', 'info');

      const res = await App.fetchApi('/api/teacher/generate-qr', {
        method: 'POST',
        body: JSON.stringify({
          subject_id,
          section_id,
          slot_id: parseInt(slotId, 10),
          duration_minutes: parseInt(duration, 10)
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        Utils.playSuccessChime();
        Utils.showToast('Live QR code generated! Students can now scan.', 'success');
        this.displayActiveSession(data.session);
      } else {
        Utils.showToast(data.error || 'Failed to generate QR code', 'error');
      }

    } catch (err) {
      console.error('QR Generation error:', err);
      Utils.showToast('Server error while generating QR code', 'error');
    }
  },

  // 3. Display Active QR Session & Setup Live Sync
  displayActiveSession(session) {
    this.currentSession = session;

    // Show Session Elements
    document.getElementById('teacher-no-session-view').style.display = 'none';
    document.getElementById('teacher-active-session-view').style.display = 'block';

    // Set Info
    document.getElementById('live-session-title').textContent = `${session.subject_name} (${session.section_name})`;
    document.getElementById('live-session-slot').textContent = session.slot_label || `Slot #${session.slot_id}`;

    // Set QR Image
    const qrImg = document.getElementById('teacher-qr-image');
    qrImg.src = session.qr_data_url;

    const fullQrImg = document.getElementById('fullscreen-qr-img');
    fullQrImg.src = session.qr_data_url;
    document.getElementById('fullscreen-sub-title').textContent = `${session.subject_name} - ${session.section_name}`;

    // Copyable Token Hint for Testing
    document.getElementById('current-session-token-hint').textContent = session.session_token;

    // Start Countdown Timer
    this.startCountdownTimer(new Date(session.expires_at));

    // Connect SSE for Real-time Student Scanning Updates
    this.connectLiveStream(session.id);

    // Initial load of attendance sheet roster
    this.loadLiveRoster(session.id);

    // Backup session state to Firebase Firestore
    if (window.FirebaseService && window.FirebaseService.syncSessionToFirestore) {
      window.FirebaseService.syncSessionToFirestore(session);
    }
  },

  // 4. Countdown Timer Engine
  startCountdownTimer(expiryDate) {
    if (this.countdownInterval) clearInterval(this.countdownInterval);

    const timerEl = document.getElementById('qr-countdown-timer');
    const fullTimerEl = document.getElementById('fullscreen-countdown-timer');

    const updateTimer = () => {
      const now = new Date();
      const diffMs = expiryDate - now;

      if (diffMs <= 0) {
        timerEl.textContent = 'EXPIRED (00:00)';
        timerEl.style.color = 'var(--danger)';
        if (fullTimerEl) fullTimerEl.textContent = 'EXPIRED';
        clearInterval(this.countdownInterval);
        Utils.showToast('Attendance QR code has expired.', 'warning');
        return;
      }

      const totalSec = Math.floor(diffMs / 1000);
      const mins = Math.floor(totalSec / 60);
      const secs = totalSec % 60;
      const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

      timerEl.textContent = formatted;
      timerEl.style.color = mins < 2 ? 'var(--danger)' : 'var(--primary-maroon)';
      if (fullTimerEl) fullTimerEl.textContent = formatted;
    };

    updateTimer();
    this.countdownInterval = setInterval(updateTimer, 1000);
  },

  // 5. Real-Time SSE Live Stream Connection
  connectLiveStream(sessionId) {
    if (this.sseEventSource) {
      this.sseEventSource.close();
    }

    this.sseEventSource = new EventSource(`/api/teacher/live-stream/${sessionId}`);

    this.sseEventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);

        if (payload.type === 'STUDENT_MARKED') {
          Utils.playSuccessChime();
          Utils.showToast(`🎯 ${payload.student.name} (${payload.student.roll_number}) marked present!`, 'success');
          // Reload roster to reflect new live count & timestamp
          this.loadLiveRoster(sessionId, payload.student.id);
        } else if (payload.type === 'MANUAL_OVERRIDE') {
          this.loadLiveRoster(sessionId);
        } else if (payload.type === 'SESSION_CLOSED') {
          Utils.showToast('Session has been closed.', 'info');
          this.resetSessionUI();
        }
      } catch (e) {
        console.error('SSE parse error:', e);
      }
    };

    this.sseEventSource.onerror = (err) => {
      console.warn('SSE connection closed or lost:', err);
    };
  },

  // 6. Load Live Attendance Roster
  async loadLiveRoster(sessionId, highlightStudentId = null) {
    try {
      const res = await App.fetchApi(`/api/teacher/live-attendance/${sessionId}`);
      if (!res.ok) throw new Error('Failed to load roster');
      const data = await res.json();

      // Update counters
      document.getElementById('live-count-present').textContent = data.present_students;
      document.getElementById('live-count-total').textContent = data.total_students;
      document.getElementById('live-count-pct').textContent = `${data.attendance_rate}%`;

      // Fullscreen counters
      const fullCount = document.getElementById('fullscreen-live-count');
      if (fullCount) {
        fullCount.textContent = `${data.present_students} / ${data.total_students} Present (${data.attendance_rate}%)`;
      }

      const tbody = document.getElementById('teacher-live-roster-body');
      tbody.innerHTML = '';

      data.roster.forEach(st => {
        const row = document.createElement('tr');
        if (highlightStudentId && st.id === highlightStudentId) {
          row.className = 'row-new-scan';
        }

        const isPresent = st.status === 'present';
        const isExcused = st.status === 'excused';

        let statusBadge = `<span class="status-tag absent">❌ Absent</span>`;
        if (isPresent) statusBadge = `<span class="status-tag present">✅ Present</span>`;
        if (isExcused) statusBadge = `<span class="status-tag excused">⏳ Excused</span>`;

        row.innerHTML = `
          <td><strong>${st.roll_number}</strong></td>
          <td>${st.name}</td>
          <td>${statusBadge}</td>
          <td><span style="font-size:0.8rem; color:var(--text-secondary);">${st.marked_at ? st.marked_at.split(' ')[1] || st.marked_at : '—'}</span></td>
          <td><span style="font-size:0.75rem; text-transform:uppercase;">${st.method || '—'}</span></td>
          <td>
            <div style="display:flex; gap:4px;">
              <button onclick="TeacherPortal.manualOverride(${st.id}, '${isPresent ? 'absent' : 'present'}')"
                      class="btn-secondary" style="padding:4px 8px; font-size:0.75rem;">
                ${isPresent ? 'Mark Absent' : 'Mark Present'}
              </button>
              <button onclick="TeacherPortal.manualOverride(${st.id}, 'excused')"
                      class="btn-secondary" style="padding:4px 6px; font-size:0.75rem;">
                Excuse
              </button>
            </div>
          </td>
        `;
        tbody.appendChild(row);
      });

    } catch (err) {
      console.error('Error loading live roster:', err);
    }
  },

  // 7. Manual Attendance Override
  async manualOverride(studentId, newStatus) {
    if (!this.currentSession) return;

    try {
      const res = await App.fetchApi('/api/teacher/manual-override', {
        method: 'POST',
        body: JSON.stringify({
          session_id: this.currentSession.id,
          student_id: studentId,
          subject_id: this.currentSession.subject_id,
          section_id: this.currentSession.section_id,
          slot_id: this.currentSession.slot_id,
          date: this.currentSession.date,
          status: newStatus
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        Utils.showToast(data.message, 'success');
        this.loadLiveRoster(this.currentSession.id);
      } else {
        Utils.showToast(data.error || 'Failed to update attendance', 'error');
      }
    } catch (err) {
      Utils.showToast('Network error during manual override', 'error');
    }
  },

  // 8. Close Current Active Session
  async closeCurrentSession() {
    if (!this.currentSession) return;

    if (!confirm('Are you sure you want to close this live QR session? Students will no longer be able to scan.')) {
      return;
    }

    try {
      const res = await App.fetchApi('/api/teacher/close-session', {
        method: 'POST',
        body: JSON.stringify({ session_id: this.currentSession.id })
      });

      if (res.ok) {
        Utils.showToast('QR session closed successfully.', 'info');
        this.resetSessionUI();
      }
    } catch (err) {
      Utils.showToast('Error closing session', 'error');
    }
  },

  resetSessionUI() {
    if (this.countdownInterval) clearInterval(this.countdownInterval);
    if (this.sseEventSource) this.sseEventSource.close();
    this.currentSession = null;

    document.getElementById('teacher-active-session-view').style.display = 'none';
    document.getElementById('teacher-no-session-view').style.display = 'block';
  },

  // Fullscreen Presentation Mode for Classroom Projectors
  openFullscreenQR() {
    const overlay = document.getElementById('fullscreen-qr-overlay');
    if (overlay) overlay.classList.add('active');
  },

  closeFullscreenQR() {
    const overlay = document.getElementById('fullscreen-qr-overlay');
    if (overlay) overlay.classList.remove('active');
  },

  // Export CSV
  exportCurrentSessionCSV() {
    if (!this.currentSession) return;
    const url = `/api/teacher/export-csv?session_id=${this.currentSession.id}`;
    window.location.href = url;
  },

  // 9. Teacher Analytics & Defaulters List
  async loadAnalytics() {
    try {
      const res = await App.fetchApi('/api/teacher/analytics');
      if (!res.ok) return;
      const data = await res.json();

      document.getElementById('teacher-defaulter-count').textContent = data.defaulters_count;

      const tbody = document.getElementById('teacher-defaulters-table-body');
      if (!tbody) return;
      tbody.innerHTML = '';

      if (data.defaulters_list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center" style="color:var(--success); font-weight:600; padding:16px;">🎉 Excellent! No attendance defaulters in your assigned classes.</td></tr>`;
        return;
      }

      data.defaulters_list.forEach(st => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td><strong>${st.roll_number}</strong></td>
          <td>${st.student_name}</td>
          <td>${st.section_name}</td>
          <td>${st.subject_name}</td>
          <td><strong style="color:var(--danger);">${st.percentage}%</strong> (${st.attended}/${st.conducted})</td>
          <td><span class="status-tag absent">⚠️ Defaulter Warning</span></td>
        `;
        tbody.appendChild(row);
      });

    } catch (err) {
      console.error('Error loading analytics:', err);
    }
  }
};
