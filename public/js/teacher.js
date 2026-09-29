// ==========================================================================
// NFC-IET Attendance Management System - Teacher Portal
// QR Code Generator, Real-time Live Attendance Sheet, Manual Override & Export
// ==========================================================================

const TeacherPortal = {
  currentSession: null,
  countdownInterval: null,
  sseEventSource: null,
  currentRoster: [],
  selectedOverrideStudent: null,

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

    // Export Formatted PDF Button
    const exportPdfBtn = document.getElementById('btn-export-session-pdf');
    if (exportPdfBtn) {
      exportPdfBtn.onclick = () => this.exportCurrentSessionPDF();
    }

    // Manual Override Modal Listeners
    this.setupOverrideModalEvents();
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

      this.currentRoster = data.roster || [];
      const tbody = document.getElementById('teacher-live-roster-body');
      tbody.innerHTML = '';

      this.currentRoster.forEach(st => {
        const row = document.createElement('tr');
        if (highlightStudentId && st.id === highlightStudentId) {
          row.className = 'row-new-scan';
        }

        const isPresent = st.status === 'present';
        const isExcused = st.status === 'excused';

        let statusBadge = `<span class="status-tag absent">❌ Absent</span>`;
        if (isPresent) statusBadge = `<span class="status-tag present">✅ Present</span>`;
        if (isExcused) statusBadge = `<span class="status-tag excused">⏳ Excused</span>`;

        let methodDetails = `<span style="font-size:0.75rem; text-transform:uppercase; color:var(--text-secondary); font-weight:600;">${st.method || '—'}</span>`;
        if (st.reason) {
          methodDetails += `<div style="font-size:0.72rem; color:#475569; margin-top:2px; font-style:italic; line-height:1.2;" title="Override reason: ${Utils.escapeHtml(st.reason)}">💬 ${Utils.escapeHtml(st.reason)}</div>`;
        }

        const targetToggleStatus = isPresent ? 'absent' : 'present';
        const toggleBtnLabel = isPresent ? '❌ Mark Absent' : '✅ Mark Present';
        const toggleBtnStyle = isPresent
          ? 'background: #FEF2F2; color: #991B1B; border: 1px solid #FCA5A5;'
          : 'background: #ECFDF5; color: #065F46; border: 1px solid #6EE7B7;';

        row.innerHTML = `
          <td><strong>${st.roll_number}</strong></td>
          <td>${st.name}</td>
          <td>${statusBadge}</td>
          <td><span style="font-size:0.8rem; color:var(--text-secondary);">${st.marked_at ? (st.marked_at.split(' ')[1] || st.marked_at) : '—'}</span></td>
          <td>${methodDetails}</td>
          <td>
            <div style="display:flex; align-items:center; gap:6px;">
              <button onclick="TeacherPortal.openOverrideModal(${st.id}, '${targetToggleStatus}')"
                      class="btn-secondary" style="padding:4px 10px; font-size:0.75rem; font-weight:600; border-radius:6px; cursor:pointer; ${toggleBtnStyle}"
                      title="Toggle status with reason comment">
                ${toggleBtnLabel}
              </button>
              <button onclick="TeacherPortal.openOverrideModal(${st.id})"
                      class="btn-secondary" style="padding:4px 8px; font-size:0.75rem; border-radius:6px; cursor:pointer;"
                      title="Edit status &amp; custom reason comment">
                ✏️
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

  // 7. Manual Attendance Override Logic & Modal Controllers

  // Open the override modal with preselected student and status
  openOverrideModal(studentId, preferredStatus = null) {
    const student = (this.currentRoster || []).find(s => s.id === studentId);
    if (!student) {
      Utils.showToast('Student record not found in roster.', 'warning');
      return;
    }

    this.selectedOverrideStudent = student;

    // Populate modal fields
    document.getElementById('override-student-id').value = student.id;
    document.getElementById('override-student-roll').value = student.roll_number;
    document.getElementById('override-student-name').value = student.name;
    document.getElementById('override-student-display-name').textContent = student.name;
    document.getElementById('override-student-display-roll').textContent = student.roll_number;

    const currentBadge = document.getElementById('override-student-current-status');
    currentBadge.textContent = student.status.toUpperCase();
    currentBadge.className = `status-tag ${student.status}`;

    // Target Status Selection (toggle opposite by default)
    const targetStatus = preferredStatus || (student.status === 'present' ? 'absent' : 'present');
    this.setOverrideTargetStatus(targetStatus);

    // Pre-populate or reset reason
    const reasonInput = document.getElementById('override-reason-input');
    if (student.reason) {
      reasonInput.value = student.reason;
    } else {
      reasonInput.value = targetStatus === 'absent' ? 'Instructor override: marked absent' : 'Instructor override: verified in classroom';
    }

    // Open Modal
    const modal = document.getElementById('modal-manual-override');
    if (modal) modal.classList.add('active');
  },

  // Set toggle target status styling
  setOverrideTargetStatus(status) {
    document.getElementById('override-target-status').value = status;
    const btnPresent = document.getElementById('btn-toggle-present');
    const btnAbsent = document.getElementById('btn-toggle-absent');
    const reasonInput = document.getElementById('override-reason-input');

    if (status === 'present') {
      btnPresent.style.background = '#ECFDF5';
      btnPresent.style.color = '#065F46';
      btnPresent.style.border = '2px solid #10B981';
      btnPresent.style.boxShadow = '0 0 0 2px rgba(16, 185, 129, 0.2)';

      btnAbsent.style.background = '#F8FAFC';
      btnAbsent.style.color = '#64748B';
      btnAbsent.style.border = '1px solid var(--border-light)';
      btnAbsent.style.boxShadow = 'none';

      if (reasonInput && (!reasonInput.value || reasonInput.value.includes('absent'))) {
        reasonInput.value = 'Instructor override: verified in classroom';
      }
    } else {
      btnAbsent.style.background = '#FEF2F2';
      btnAbsent.style.color = '#991B1B';
      btnAbsent.style.border = '2px solid #EF4444';
      btnAbsent.style.boxShadow = '0 0 0 2px rgba(239, 68, 68, 0.2)';

      btnPresent.style.background = '#F8FAFC';
      btnPresent.style.color = '#64748B';
      btnPresent.style.border = '1px solid var(--border-light)';
      btnPresent.style.boxShadow = 'none';

      if (reasonInput && (!reasonInput.value || reasonInput.value.includes('present') || reasonInput.value.includes('verified'))) {
        reasonInput.value = 'Instructor override: marked absent';
      }
    }
  },

  // Setup event listeners for override modal controls & quick tags
  setupOverrideModalEvents() {
    const btnPresent = document.getElementById('btn-toggle-present');
    const btnAbsent = document.getElementById('btn-toggle-absent');
    const btnSave = document.getElementById('btn-save-attendance-override');
    const reasonInput = document.getElementById('override-reason-input');

    if (btnPresent) {
      btnPresent.onclick = () => this.setOverrideTargetStatus('present');
    }
    if (btnAbsent) {
      btnAbsent.onclick = () => this.setOverrideTargetStatus('absent');
    }

    // Quick Reason Tags
    const tagButtons = document.querySelectorAll('.override-tag-btn');
    tagButtons.forEach(btn => {
      btn.onclick = () => {
        const text = btn.textContent.replace(/^[\p{Emoji}\s]+/u, '').trim();
        if (reasonInput) {
          reasonInput.value = text;
          reasonInput.focus();
        }
      };
    });

    if (btnSave) {
      btnSave.onclick = () => this.executeManualOverride();
    }
  },

  // Execute manual override and persist to Firestore + SQLite Database
  async executeManualOverride() {
    if (!this.currentSession) {
      Utils.showToast('No active lecture session found.', 'warning');
      return;
    }

    const studentId = parseInt(document.getElementById('override-student-id').value, 10);
    const studentRoll = document.getElementById('override-student-roll').value;
    const studentName = document.getElementById('override-student-name').value;
    const newStatus = document.getElementById('override-target-status').value;
    const reasonComment = (document.getElementById('override-reason-input').value || '').trim() ||
      (newStatus === 'absent' ? 'Instructor override: marked absent' : 'Instructor override: marked present');

    const saveBtn = document.getElementById('btn-save-attendance-override');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span>Saving &amp; Cloud Syncing...</span>';
    }

    try {
      // 1. Persist to Backend API / Database
      const res = await App.fetchApi('/api/teacher/manual-override', {
        method: 'POST',
        body: JSON.stringify({
          session_id: this.currentSession.id,
          student_id: studentId,
          subject_id: this.currentSession.subject_id,
          section_id: this.currentSession.section_id,
          slot_id: this.currentSession.slot_id,
          date: this.currentSession.date,
          status: newStatus,
          reason: reasonComment
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to update attendance');
      }

      // 2. Persist override directly to Firestore
      let firestoreSynced = false;
      if (window.FirebaseService && window.FirebaseService.syncOverrideToFirestore) {
        try {
          const syncRes = await window.FirebaseService.syncOverrideToFirestore(this.currentSession, {
            student_id: studentId,
            student_roll: studentRoll,
            student_name: studentName,
            status: newStatus,
            reason: reasonComment
          });
          if (syncRes) firestoreSynced = true;
        } catch (fbErr) {
          console.warn('Firestore override sync notice:', fbErr.message);
        }
      }

      // Close modal
      const modal = document.getElementById('modal-manual-override');
      if (modal) modal.classList.remove('active');

      const syncNote = firestoreSynced ? '🔥 Persisted to Firestore' : '';
      Utils.showToast(`Updated ${studentName} to ${newStatus.toUpperCase()}! ${syncNote}`, 'success');

      // Refresh live roster table and highlight updated row
      await this.loadLiveRoster(this.currentSession.id, studentId);

    } catch (err) {
      console.error('Manual override error:', err);
      Utils.showToast(err.message || 'Network error during manual override', 'error');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<span>Save &amp; Sync to Firestore</span><span style="font-size: 0.9rem;">🔥</span>';
      }
    }
  },

  // Programmatic manual override helper
  async manualOverride(studentId, newStatus) {
    this.openOverrideModal(studentId, newStatus);
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

  // Export Formatted Institutional PDF Document
  async exportCurrentSessionPDF() {
    if (!this.currentSession) {
      Utils.showToast('No active attendance session to export.', 'warning');
      return;
    }

    Utils.showToast('Generating formatted institutional PDF...', 'info');

    try {
      // Fetch latest live attendance details for the active session
      const res = await App.fetchApi(`/api/teacher/live-attendance/${this.currentSession.id}`);
      if (!res.ok) {
        throw new Error('Unable to retrieve current session data for PDF export.');
      }
      const data = await res.json();
      const session = data.session || this.currentSession;
      const roster = data.roster || [];
      const totalStudents = data.total_students || roster.length;
      const presentStudents = data.present_students || roster.filter(s => s.status === 'present').length;
      const absentStudents = data.absent_students || (totalStudents - presentStudents);
      const attendanceRate = data.attendance_rate || (totalStudents > 0 ? ((presentStudents / totalStudents) * 100).toFixed(1) : 0);

      // Check if jsPDF & AutoTable are loaded
      const { jsPDF } = window.jspdf || {};
      if (jsPDF) {
        this.generateJsPdfDocument({
          session,
          roster,
          totalStudents,
          presentStudents,
          absentStudents,
          attendanceRate
        });
        Utils.showToast('Institutional PDF exported successfully!', 'success');
      } else {
        // Fallback: Clean printable HTML window with automatic print/PDF save dialog
        this.printFormattedHtmlPdf({
          session,
          roster,
          totalStudents,
          presentStudents,
          absentStudents,
          attendanceRate
        });
      }
    } catch (err) {
      console.error('PDF export error:', err);
      Utils.showToast(err.message || 'Error generating PDF document', 'error');
    }
  },

  // Generate jsPDF Document
  generateJsPdfDocument({ session, roster, totalStudents, presentStudents, absentStudents, attendanceRate }) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'pt',
      format: 'a4'
    });

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 36; // 0.5 in

    // 1. Top Institutional Banner
    doc.setFillColor(127, 29, 29); // NFC Maroon
    doc.rect(0, 0, pageWidth, 52, 'F');

    // Header Institutional Text
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text('NFC INSTITUTE OF ENGINEERING & TECHNOLOGY, MULTAN', pageWidth / 2, 22, { align: 'center' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text('Department of Computer Science • Official QR Attendance Management System', pageWidth / 2, 38, { align: 'center' });

    // 2. Document Title
    doc.setTextColor(30, 41, 59);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('OFFICIAL LECTURE ATTENDANCE ROSTER', margin, 76);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    const nowStr = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    doc.text(`Generated: ${nowStr} | Session ID: #${session.id}`, pageWidth - margin, 76, { align: 'right' });

    // 3. Metadata Information Card
    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(1);
    doc.roundedRect(margin, 86, pageWidth - (margin * 2), 65, 4, 4, 'FD');

    doc.setFontSize(8.5);
    doc.setTextColor(71, 85, 105);

    // Left Column
    const leftX = margin + 14;
    doc.setFont('helvetica', 'bold');
    doc.text('Course Subject:', leftX, 104);
    doc.setFont('helvetica', 'normal');
    doc.text(`${session.subject_name || 'N/A'} (${session.subject_code || ''})`, leftX + 80, 104);

    doc.setFont('helvetica', 'bold');
    doc.text('Class Section:', leftX, 121);
    doc.setFont('helvetica', 'normal');
    doc.text(`${session.section_name || 'Section B'}`, leftX + 80, 121);

    doc.setFont('helvetica', 'bold');
    doc.text('Instructor:', leftX, 138);
    doc.setFont('helvetica', 'normal');
    doc.text(`${session.teacher_name || (App.currentUser ? App.currentUser.name : 'Faculty')}`, leftX + 80, 138);

    // Right Column
    const rightX = (pageWidth / 2) + 20;
    doc.setFont('helvetica', 'bold');
    doc.text('Lecture Date:', rightX, 104);
    doc.setFont('helvetica', 'normal');
    doc.text(`${session.date || new Date().toISOString().split('T')[0]}`, rightX + 80, 104);

    doc.setFont('helvetica', 'bold');
    doc.text('Lecture Slot:', rightX, 121);
    doc.setFont('helvetica', 'normal');
    doc.text(`${session.slot_label || 'Standard Slot'}`, rightX + 80, 121);

    doc.setFont('helvetica', 'bold');
    doc.text('Session Token:', rightX, 138);
    doc.setFont('helvetica', 'normal');
    doc.text(`${session.session_token || session.active_code || 'VERIFIED'}`, rightX + 80, 138);

    // 4. Summary Statistics Metric Chips
    const statBoxY = 160;
    const boxW = (pageWidth - (margin * 2) - 18) / 4;

    const stats = [
      { label: 'TOTAL ENROLLED', val: String(totalStudents), color: [30, 41, 59], bg: [241, 245, 249] },
      { label: 'PRESENT STUDENTS', val: String(presentStudents), color: [6, 95, 70], bg: [209, 250, 229] },
      { label: 'ABSENT STUDENTS', val: String(absentStudents), color: [153, 27, 27], bg: [254, 226, 226] },
      { label: 'ATTENDANCE RATE', val: `${attendanceRate}%`, color: [180, 83, 9], bg: [254, 243, 199] }
    ];

    stats.forEach((st, i) => {
      const bx = margin + (i * (boxW + 6));
      doc.setFillColor(...st.bg);
      doc.setDrawColor(226, 232, 240);
      doc.roundedRect(bx, statBoxY, boxW, 35, 4, 4, 'FD');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(...st.color);
      doc.text(st.val, bx + (boxW / 2), statBoxY + 17, { align: 'center' });

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(100, 116, 139);
      doc.text(st.label, bx + (boxW / 2), statBoxY + 28, { align: 'center' });
    });

    // 5. Table Data formatting
    const tableData = roster.map((s, idx) => {
      const isPresent = s.status === 'present';
      const isExcused = s.status === 'excused';
      let statusStr = 'ABSENT';
      if (isPresent) statusStr = 'PRESENT';
      if (isExcused) statusStr = 'EXCUSED';

      const timeStr = s.marked_at ? (s.marked_at.split(' ')[1] || s.marked_at) : '—';
      const methodStr = s.method && s.method !== 'none' ? s.method.toUpperCase().replace('_', ' ') : '—';

      return [
        String(idx + 1),
        s.roll_number || '—',
        s.name || 'Student',
        statusStr,
        timeStr,
        methodStr
      ];
    });

    doc.autoTable({
      startY: 206,
      head: [['#', 'Roll Number', 'Student Name', 'Status', 'Time Marked', 'Verification Method']],
      body: tableData,
      theme: 'grid',
      styles: {
        fontSize: 8.5,
        cellPadding: 5,
        valign: 'middle',
        lineColor: [226, 232, 240],
        lineWidth: 0.5
      },
      headStyles: {
        fillColor: [127, 29, 29], // NFC Maroon
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        halign: 'center'
      },
      columnStyles: {
        0: { halign: 'center', cellWidth: 26 },
        1: { halign: 'center', cellWidth: 70, fontStyle: 'bold' },
        2: { halign: 'left' },
        3: { halign: 'center', cellWidth: 68, fontStyle: 'bold' },
        4: { halign: 'center', cellWidth: 75 },
        5: { halign: 'center', cellWidth: 85 }
      },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 3) {
          const val = data.cell.raw;
          if (val === 'PRESENT') {
            data.cell.styles.textColor = [6, 95, 70]; // Dark green
            data.cell.styles.fillColor = [240, 253, 244]; // Light green
          } else if (val === 'ABSENT') {
            data.cell.styles.textColor = [153, 27, 27]; // Dark red
            data.cell.styles.fillColor = [254, 242, 242]; // Light red
          } else if (val === 'EXCUSED') {
            data.cell.styles.textColor = [133, 77, 14]; // Amber
            data.cell.styles.fillColor = [254, 243, 199];
          }
        }
      },
      margin: { left: margin, right: margin, bottom: 95 }
    });

    // 6. Institutional Footers & Signatures
    const totalPages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);

      // Bottom footer rule
      doc.setDrawColor(226, 232, 240);
      doc.setLineWidth(0.5);
      doc.line(margin, pageHeight - 32, pageWidth - margin, pageHeight - 32);

      doc.setFontSize(7.5);
      doc.setTextColor(148, 163, 184);
      doc.text('Official NFC-IET Document • Automated QR Attendance Record • Verification ID: ' + session.id, margin, pageHeight - 20);
      doc.text(`Page ${p} of ${totalPages}`, pageWidth - margin, pageHeight - 20, { align: 'right' });
    }

    // Add Signature Blocks on final page
    doc.setPage(totalPages);
    const finalY = doc.lastAutoTable ? doc.lastAutoTable.finalY : 380;
    let sigY = finalY + 36;
    if (sigY > pageHeight - 90) {
      doc.addPage();
      sigY = 70;
    }

    // Instructor Signature Line
    doc.setDrawColor(148, 163, 184);
    doc.setLineWidth(0.8);
    doc.line(margin + 20, sigY + 28, margin + 170, sigY + 28);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(51, 65, 85);
    doc.text('Course Instructor Signature', margin + 20, sigY + 40);
    doc.setFont('helvetica', 'normal');
    doc.text(`${session.teacher_name || (App.currentUser ? App.currentUser.name : 'Faculty Member')}`, margin + 20, sigY + 52);

    // HOD Signature Line
    const hodX = pageWidth - margin - 170;
    doc.line(hodX, sigY + 28, hodX + 150, sigY + 28);
    doc.setFont('helvetica', 'bold');
    doc.text('Head of Department / Registrar', hodX, sigY + 40);
    doc.setFont('helvetica', 'normal');
    doc.text('NFC-IET Quality Assurance Seal', hodX, sigY + 52);

    // Trigger Save
    const cleanSub = (session.subject_code || session.subject_name || 'Subject').replace(/[^a-zA-Z0-9_-]/g, '_');
    const cleanSec = (session.section_name || 'Section').replace(/[^a-zA-Z0-9_-]/g, '_');
    const docDate = session.date || new Date().toISOString().split('T')[0];
    const pdfFilename = `NFC-IET_Attendance_${cleanSub}_${cleanSec}_${docDate}.pdf`;
    doc.save(pdfFilename);
  },

  // Fallback: Formatted Printable Window
  printFormattedHtmlPdf({ session, roster, totalStudents, presentStudents, absentStudents, attendanceRate }) {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      Utils.showToast('Please allow popups to export the PDF document.', 'warning');
      return;
    }

    const rowsHtml = roster.map((s, idx) => {
      const isPresent = s.status === 'present';
      const isExcused = s.status === 'excused';
      let tagStyle = 'background: #FEE2E2; color: #991B1B;';
      let tagText = 'ABSENT';
      if (isPresent) {
        tagStyle = 'background: #D1FAE5; color: #065F46;';
        tagText = 'PRESENT';
      } else if (isExcused) {
        tagStyle = 'background: #FEF3C7; color: #854D0E;';
        tagText = 'EXCUSED';
      }
      return `
        <tr>
          <td style="text-align: center;">${idx + 1}</td>
          <td style="text-align: center; font-weight: bold;">${s.roll_number || '—'}</td>
          <td>${s.name || 'Student'}</td>
          <td style="text-align: center;">
            <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 0.75rem; ${tagStyle}">${tagText}</span>
          </td>
          <td style="text-align: center;">${s.marked_at ? (s.marked_at.split(' ')[1] || s.marked_at) : '—'}</td>
          <td style="text-align: center; font-size: 0.75rem; text-transform: uppercase;">${s.method && s.method !== 'none' ? s.method : '—'}</td>
        </tr>
      `;
    }).join('');

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>NFC-IET Attendance Sheet - ${session.subject_name || 'Lecture'}</title>
        <style>
          @page { size: A4 portrait; margin: 12mm; }
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1E293B; margin: 0; padding: 12px; }
          .header-banner { background: #7F1D1D; color: #FFFFFF; padding: 14px 20px; border-radius: 6px; text-align: center; }
          .header-banner h1 { margin: 0 0 4px 0; font-size: 16px; letter-spacing: 0.5px; }
          .header-banner p { margin: 0; font-size: 11px; opacity: 0.9; }
          .doc-title-row { display: flex; justify-content: space-between; align-items: baseline; margin: 16px 0 10px 0; }
          .doc-title { font-size: 14px; font-weight: bold; color: #7F1D1D; }
          .meta-box { background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px; padding: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 11px; margin-bottom: 14px; }
          .stats-row { display: flex; gap: 10px; margin-bottom: 16px; }
          .stat-box { flex: 1; border: 1px solid #E2E8F0; border-radius: 6px; padding: 8px; text-align: center; }
          .stat-val { font-size: 14px; font-weight: bold; margin-bottom: 2px; }
          .stat-lbl { font-size: 9px; color: #64748B; text-transform: uppercase; }
          table { width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 20px; }
          th { background: #7F1D1D; color: #ffffff; padding: 6px 8px; text-align: left; }
          td { padding: 6px 8px; border-bottom: 1px solid #E2E8F0; }
          .sig-row { display: flex; justify-content: space-between; margin-top: 36px; padding-top: 20px; }
          .sig-box { width: 220px; text-align: center; border-top: 1px solid #94A3B8; padding-top: 6px; font-size: 10px; }
        </style>
      </head>
      <body>
        <div class="header-banner">
          <h1>NFC INSTITUTE OF ENGINEERING & TECHNOLOGY, MULTAN</h1>
          <p>Department of Computer Science • Official QR Attendance Management System</p>
        </div>
        <div class="doc-title-row">
          <div class="doc-title">OFFICIAL LECTURE ATTENDANCE ROSTER</div>
          <div style="font-size: 10px; color: #64748B;">Date: ${session.date || ''} | Slot: ${session.slot_label || ''}</div>
        </div>
        <div class="meta-box">
          <div><strong>Subject:</strong> ${session.subject_name || 'N/A'} (${session.subject_code || ''})</div>
          <div><strong>Section:</strong> ${session.section_name || 'Section B'}</div>
          <div><strong>Instructor:</strong> ${session.teacher_name || (App.currentUser ? App.currentUser.name : 'Faculty')}</div>
          <div><strong>Session Token:</strong> ${session.session_token || session.active_code || 'VERIFIED'}</div>
        </div>
        <div class="stats-row">
          <div class="stat-box" style="background:#F1F5F9;"><div class="stat-val">${totalStudents}</div><div class="stat-lbl">Total Enrolled</div></div>
          <div class="stat-box" style="background:#D1FAE5; color:#065F46;"><div class="stat-val">${presentStudents}</div><div class="stat-lbl">Present</div></div>
          <div class="stat-box" style="background:#FEE2E2; color:#991B1B;"><div class="stat-val">${absentStudents}</div><div class="stat-lbl">Absent</div></div>
          <div class="stat-box" style="background:#FEF3C7; color:#854D0E;"><div class="stat-val">${attendanceRate}%</div><div class="stat-lbl">Rate</div></div>
        </div>
        <table>
          <thead>
            <tr>
              <th style="text-align: center; width: 30px;">#</th>
              <th style="text-align: center; width: 80px;">Roll No</th>
              <th>Student Name</th>
              <th style="text-align: center; width: 75px;">Status</th>
              <th style="text-align: center; width: 80px;">Time</th>
              <th style="text-align: center; width: 80px;">Verification</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
        <div class="sig-row">
          <div class="sig-box">
            <strong>Instructor Signature</strong><br>
            <span>${session.teacher_name || (App.currentUser ? App.currentUser.name : 'Faculty Member')}</span>
          </div>
          <div class="sig-box">
            <strong>HOD / Registrar Verification</strong><br>
            <span>NFC-IET Quality Assurance</span>
          </div>
        </div>
      </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
    }, 400);
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
