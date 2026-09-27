// ==========================================================================
// NFC-IET Attendance Management System - Student Portal
// Daily 5-Lecture View, Camera QR Scanner, History & Defaulter Alerts
// ==========================================================================

const StudentPortal = {
  html5QrScanner: null,
  isScanning: false,

  async init() {
    console.log('Initializing Student Portal...');
    await this.loadDailySchedule();
    await this.loadAttendanceHistory();
    this.setupScannerListeners();
  },

  // 1. Load Daily 5-Lecture Timetable Schedule
  async loadDailySchedule() {
    try {
      const res = await App.fetchApi('/api/student/daily-schedule');
      if (!res.ok) throw new Error('Failed to load daily schedule');
      const data = await res.json();

      document.getElementById('student-schedule-day').textContent = `${data.day} (${data.date})`;
      document.getElementById('student-schedule-section').textContent = data.section_name || 'Section B';

      const grid = document.getElementById('student-lecture-grid');
      grid.innerHTML = '';

      let markedCount = 0;
      let totalConductedToday = 0;

      data.lectures.forEach(slot => {
        if (slot.status === 'marked') markedCount++;
        if (slot.status === 'marked' || slot.status === 'not_marked') totalConductedToday++;

        const card = document.createElement('div');
        let cardStatusClass = 'status-' + slot.status;
        if (slot.is_live_qr && slot.status !== 'marked') cardStatusClass = 'status-live';

        card.className = `lecture-card ${cardStatusClass}`;

        let statusBadgeHtml = '';
        if (slot.status === 'marked') {
          statusBadgeHtml = `<div class="lecture-status-badge status-badge-marked">✅ Marked Present <span style="font-size:0.75rem; opacity:0.8;">(${slot.marked_at ? slot.marked_at.split(' ')[1] || slot.marked_at : 'Today'})</span></div>`;
        } else if (slot.is_live_qr) {
          statusBadgeHtml = `<button onclick="StudentPortal.openScannerModal()" class="lecture-status-badge status-badge-live" style="cursor:pointer; border:none;">🔴 Live QR Session (Click to Scan)</button>`;
        } else if (slot.status === 'not_marked') {
          statusBadgeHtml = `<div class="lecture-status-badge status-badge-not_marked">❌ Not Marked (Absent)</div>`;
        } else {
          statusBadgeHtml = `<div class="lecture-status-badge status-badge-upcoming">⏳ Upcoming Lecture</div>`;
        }

        card.innerHTML = `
          <div class="lecture-slot-header">
            <span class="lecture-slot-num">Slot #${slot.slot_number}</span>
            <span class="lecture-time-badge">${slot.start_time} - ${slot.end_time}</span>
          </div>
          <div>
            <h4 class="lecture-subject-name">${slot.subject_name}</h4>
            <div class="lecture-meta-info">
              <span><strong>Code:</strong> ${slot.subject_code}</span>
              <span><strong>Teacher:</strong> ${slot.teacher_name}</span>
              <span><strong>Venue:</strong> ${slot.room}</span>
            </div>
          </div>
          <div style="margin-top: 8px;">
            ${statusBadgeHtml}
          </div>
        `;

        grid.appendChild(card);
      });

      // Update hero summary badge
      const todayPct = totalConductedToday > 0 ? Math.round((markedCount / totalConductedToday) * 100) : 100;
      document.getElementById('student-today-stat').textContent = `${markedCount} / ${data.lectures.filter(l => l.has_lecture).length}`;

    } catch (err) {
      console.error('Error loading schedule:', err);
      Utils.showToast('Could not load daily lecture schedule.', 'error');
    }
  },

  // 2. Load Attendance History & Subject Breakdown
  async loadAttendanceHistory() {
    try {
      const res = await App.fetchApi('/api/student/history');
      if (!res.ok) throw new Error('Failed to load history');
      const data = await res.json();

      // Update Overall Summary
      document.getElementById('student-overall-pct').textContent = `${data.overall_percentage}%`;
      document.getElementById('student-total-attended').textContent = `${data.total_attended} / ${data.total_lectures}`;

      // Defaulter Banner if below 75%
      const alertBanner = document.getElementById('student-defaulter-alert');
      if (data.is_overall_defaulter) {
        alertBanner.style.display = 'block';
        alertBanner.innerHTML = `⚠️ <strong>Attendance Warning:</strong> Your overall attendance is <strong>${data.overall_percentage}%</strong> (Below the 75% NFC-IET mandatory examination threshold). Please attend remaining lectures regularly.`;
      } else {
        alertBanner.style.display = 'none';
      }

      // Subject-wise Breakdown Table
      const subTableBody = document.getElementById('student-subject-table-body');
      subTableBody.innerHTML = '';

      data.subject_breakdown.forEach(sub => {
        const row = document.createElement('tr');
        const isLow = sub.percentage < 75;
        const color = isLow ? 'var(--danger)' : 'var(--success)';

        row.innerHTML = `
          <td>
            <strong>${sub.subject_name}</strong>
            <div style="font-size:0.75rem; color:var(--text-muted);">${sub.subject_code} • ${sub.credit_hours} Cr Hrs</div>
          </td>
          <td>${sub.conducted}</td>
          <td><strong style="color:var(--success);">${sub.attended}</strong></td>
          <td><span style="color:var(--danger);">${sub.absent}</span></td>
          <td>
            <div style="display:flex; align-items:center; gap:8px;">
              <div style="flex:1; background:#E2E8F0; height:8px; border-radius:4px; overflow:hidden;">
                <div style="width:${sub.percentage}%; background:${color}; height:100%;"></div>
              </div>
              <strong style="color:${color}; font-size:0.85rem; min-width:45px;">${sub.percentage}%</strong>
            </div>
          </td>
          <td>
            ${isLow ? '<span class="status-tag absent">⚠️ Defaulter (&lt;75%)</span>' : '<span class="status-tag present">✅ Eligible</span>'}
          </td>
        `;
        subTableBody.appendChild(row);
      });

      // Recent Attendance Logs
      const logTableBody = document.getElementById('student-log-table-body');
      logTableBody.innerHTML = '';

      data.recent_records.forEach(rec => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${rec.date}</td>
          <td><strong>${rec.subject_code}</strong> - ${rec.subject_name}</td>
          <td>${rec.slot_label}</td>
          <td><span class="status-tag present">✅ Present</span></td>
          <td>${rec.timestamp ? rec.timestamp.split(' ')[1] || rec.timestamp : 'N/A'}</td>
          <td><span style="font-size:0.75rem; text-transform:uppercase; background:#F1F5F9; padding:2px 6px; border-radius:4px;">${rec.method}</span></td>
        `;
        logTableBody.appendChild(row);
      });

    } catch (err) {
      console.error('Error loading history:', err);
    }
  },

  // 3. Camera QR Scanner Setup & Trigger
  setupScannerListeners() {
    const triggerBtn = document.getElementById('btn-open-scanner');
    if (triggerBtn) {
      triggerBtn.onclick = () => this.openScannerModal();
    }

    const closeBtn = document.getElementById('btn-close-scanner');
    if (closeBtn) {
      closeBtn.onclick = () => this.closeScannerModal();
    }

    // Direct Simulated Scan Button (for instant testing without webcam)
    const testScanBtn = document.getElementById('btn-test-simulated-scan');
    if (testScanBtn) {
      testScanBtn.onclick = () => this.performSimulatedScan();
    }
  },

  openScannerModal() {
    Utils.initAudio();
    const modal = document.getElementById('scanner-modal');
    modal.classList.add('active');
    this.startCameraScanner();
  },

  closeScannerModal() {
    const modal = document.getElementById('scanner-modal');
    modal.classList.remove('active');
    this.stopCameraScanner();
  },

  startCameraScanner() {
    const statusMsg = document.getElementById('scanner-status-msg');
    statusMsg.style.display = 'none';

    if (window.Html5Qrcode) {
      if (!this.html5QrScanner) {
        this.html5QrScanner = new Html5Qrcode('qr-reader-video');
      }

      const qrConfig = { fps: 10, qrbox: { width: 220, height: 220 } };

      this.html5QrScanner.start(
        { facingMode: 'environment' },
        qrConfig,
        (decodedText) => {
          this.handleQrScanned(decodedText);
        },
        (errorMessage) => {
          // Continuous scanning noise ignored
        }
      ).catch(err => {
        console.warn('Camera access unavailable or declined:', err);
        statusMsg.style.display = 'block';
        statusMsg.className = 'scanner-status-msg';
        statusMsg.style.background = '#FFFBEB';
        statusMsg.style.color = '#92400E';
        statusMsg.innerHTML = '⚠️ Camera permission unavailable on this device. You can use the <strong>"Simulate Live QR Scan"</strong> button below to test attendance instantly!';
      });
      this.isScanning = true;
    }
  },

  stopCameraScanner() {
    if (this.html5QrScanner && this.isScanning) {
      this.html5QrScanner.stop().then(() => {
        this.isScanning = false;
      }).catch(err => console.error('Error stopping scanner:', err));
    }
  },

  async handleQrScanned(qrCodeString) {
    // Prevent duplicate rapid calls
    if (!qrCodeString) return;

    const statusMsg = document.getElementById('scanner-status-msg');
    statusMsg.style.display = 'block';
    statusMsg.style.background = '#EFF6FF';
    statusMsg.style.color = '#1E40AF';
    statusMsg.textContent = '🔄 Validating QR code and marking attendance...';

    try {
      const res = await App.fetchApi('/api/student/scan-qr', {
        method: 'POST',
        body: JSON.stringify({
          qrToken: qrCodeString,
          deviceHash: navigator.userAgent
        })
      });

      const data = await res.json();

      if (res.ok && data.success) {
        // Success Sound & Visual Feedback
        Utils.playSuccessChime();
        statusMsg.style.background = 'var(--success-bg)';
        statusMsg.style.color = '#065F46';
        statusMsg.innerHTML = `✅ <strong>Attendance Marked!</strong><br>${data.lecture.subject_name} (${data.lecture.teacher_name})`;
        Utils.showToast(`Attendance marked for ${data.lecture.subject_name}!`, 'success');

        // Vibrate if supported
        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

        // Refresh schedules
        setTimeout(() => {
          this.closeScannerModal();
          this.loadDailySchedule();
          this.loadAttendanceHistory();
        }, 1800);

      } else {
        // Error Sound & Message
        Utils.playErrorBuzz();
        statusMsg.style.background = 'var(--danger-bg)';
        statusMsg.style.color = '#991B1B';
        statusMsg.innerHTML = `❌ ${data.error || 'Failed to mark attendance.'}`;
        Utils.showToast(data.error || 'Attendance marking failed', 'error');
      }

    } catch (err) {
      Utils.playErrorBuzz();
      statusMsg.style.background = 'var(--danger-bg)';
      statusMsg.style.color = '#991B1B';
      statusMsg.innerHTML = '❌ Network connection error. Please try again.';
    }
  },

  // Simulated Scan for instant test testing
  async performSimulatedScan() {
    let inputToken = document.getElementById('simulated-token-input').value.trim();

    if (!inputToken) {
      // Auto-detect active session from server for student's section
      try {
        const res = await App.fetchApi('/api/student/active-session');
        const data = await res.json();

        if (data.session && data.session.session_token) {
          inputToken = data.session.session_token;
          document.getElementById('simulated-token-input').value = inputToken;
          Utils.showToast(`Found active lecture: ${data.session.subject_name}. Scanning now...`, 'info');
        } else {
          Utils.playErrorBuzz();
          Utils.showToast('No active QR session found. Please generate one from the Teacher Portal first (e.g., Dr. Imran), or paste a token.', 'warning');
          return;
        }
      } catch (e) {
        Utils.showToast('Error checking for active QR sessions.', 'error');
        return;
      }
    }

    await this.handleQrScanned(inputToken);
  }
};
