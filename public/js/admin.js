// ==========================================================================
// NFC-IET Attendance Management System - Administration Portal
// KPI Dashboard, Teacher Accounts, Student Bulk Import, Timetable, Audit Logs
// ==========================================================================

const AdminPortal = {
  currentTab: 'teachers',

  async init() {
    console.log('Initializing Administration Portal...');
    await this.loadStats();
    await this.loadTeachers();
    await this.loadStudents();
    await this.loadTimetable();
    await this.loadAuditLogs();
    this.setupListeners();
  },

  // 1. Dashboard Overview Stats
  async loadStats() {
    try {
      const res = await App.fetchApi('/api/admin/stats');
      if (!res.ok) return;
      const data = await res.json();

      document.getElementById('admin-total-students').textContent = data.total_students;
      document.getElementById('admin-total-teachers').textContent = data.total_teachers;
      document.getElementById('admin-total-subjects').textContent = data.total_subjects;
      document.getElementById('admin-today-scans').textContent = data.today_scans;
      document.getElementById('admin-active-sessions').textContent = data.active_sessions;

      // Render Section Summaries
      const secList = document.getElementById('admin-section-summary-list');
      if (secList && data.attendance_summary) {
        secList.innerHTML = '';
        data.attendance_summary.forEach(sec => {
          const pct = sec.total_students > 0 ? Math.round((sec.present_count / sec.total_students) * 100) : 0;
          const item = document.createElement('div');
          item.style.padding = '10px 0';
          item.style.borderBottom = '1px solid var(--border-light)';
          item.innerHTML = `
            <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:0.85rem;">
              <strong>${sec.section_name}</strong>
              <span>${sec.present_count} / ${sec.total_students} Present (${pct}%)</span>
            </div>
            <div style="background:#E2E8F0; height:6px; border-radius:3px; overflow:hidden;">
              <div style="width:${pct}%; background:var(--primary-maroon); height:100%;"></div>
            </div>
          `;
          secList.appendChild(item);
        });
      }

    } catch (err) {
      console.error('Error loading admin stats:', err);
    }
  },

  setupListeners() {
    // Subtabs switching
    const subtabs = document.querySelectorAll('.admin-subtab-btn');
    subtabs.forEach(btn => {
      btn.onclick = () => {
        subtabs.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.subtab;
        document.querySelectorAll('.admin-subtab-panel').forEach(p => p.style.display = 'none');
        const target = document.getElementById(`admin-panel-${tab}`);
        if (target) target.style.display = 'block';
      };
    });

    // Add Teacher Modal
    const addTeacherBtn = document.getElementById('btn-open-add-teacher');
    if (addTeacherBtn) {
      addTeacherBtn.onclick = () => this.openAddTeacherModal();
    }

    const saveTeacherBtn = document.getElementById('btn-save-teacher');
    if (saveTeacherBtn) {
      saveTeacherBtn.onclick = () => this.saveTeacher();
    }

    // Add Single Student Modal
    const addStudentBtn = document.getElementById('btn-open-add-student');
    if (addStudentBtn) {
      addStudentBtn.onclick = () => this.openAddStudentModal();
    }

    const saveStudentBtn = document.getElementById('btn-save-student');
    if (saveStudentBtn) {
      saveStudentBtn.onclick = () => this.saveStudent();
    }

    // Bulk Import Modal
    const bulkImportBtn = document.getElementById('btn-open-bulk-import');
    if (bulkImportBtn) {
      bulkImportBtn.onclick = () => this.openBulkImportModal();
    }

    const runImportBtn = document.getElementById('btn-run-bulk-import');
    if (runImportBtn) {
      runImportBtn.onclick = () => this.runBulkImport();
    }

    // Reset System Database
    const resetBtn = document.getElementById('btn-reset-system');
    if (resetBtn) {
      resetBtn.onclick = () => this.resetSystemDatabase();
    }

    // Student Filter
    const studentFilter = document.getElementById('admin-student-section-filter');
    if (studentFilter) {
      studentFilter.onchange = () => this.loadStudents();
    }

    const studentSearch = document.getElementById('admin-student-search');
    if (studentSearch) {
      studentSearch.oninput = () => this.loadStudents();
    }
  },

  // 2. Teacher Management
  async loadTeachers() {
    try {
      const res = await App.fetchApi('/api/admin/teachers');
      if (!res.ok) return;
      const data = await res.json();

      const tbody = document.getElementById('admin-teachers-table-body');
      tbody.innerHTML = '';

      data.teachers.forEach(t => {
        const row = document.createElement('tr');
        const assignmentsStr = t.assignments.map(a => `<span class="demo-pill" style="font-size:0.7rem;">${a.subject_code} (${a.section_name})</span>`).join(' ') || '<em style="color:var(--text-muted);">None assigned</em>';

        row.innerHTML = `
          <td><strong>${t.name}</strong></td>
          <td><code>${t.username}</code></td>
          <td>${t.email || '—'}</td>
          <td>${t.department_name || 'CS'}</td>
          <td>${assignmentsStr}</td>
          <td>
            <span class="status-tag ${t.status === 'active' ? 'present' : 'absent'}">
              ${t.status === 'active' ? 'Active' : 'Inactive'}
            </span>
          </td>
          <td>
            <button onclick="AdminPortal.toggleTeacherStatus(${t.id}, '${t.status}')" class="btn-secondary" style="padding:4px 8px; font-size:0.75rem;">
              ${t.status === 'active' ? 'Deactivate' : 'Activate'}
            </button>
          </td>
        `;
        tbody.appendChild(row);
      });

    } catch (err) {
      console.error('Error loading teachers:', err);
    }
  },

  openAddTeacherModal() {
    document.getElementById('modal-add-teacher').classList.add('active');
  },

  async saveTeacher() {
    const name = document.getElementById('new-teacher-name').value.trim();
    const username = document.getElementById('new-teacher-username').value.trim();
    const email = document.getElementById('new-teacher-email').value.trim();
    const password = document.getElementById('new-teacher-password').value.trim();

    if (!name || !username || !password) {
      Utils.showToast('Please fill in Name, Username, and Password.', 'warning');
      return;
    }

    try {
      const res = await App.fetchApi('/api/admin/teachers', {
        method: 'POST',
        body: JSON.stringify({ name, username, email, password })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        Utils.showToast('Teacher account created successfully!', 'success');
        document.getElementById('modal-add-teacher').classList.remove('active');
        this.loadTeachers();
        this.loadStats();
      } else {
        Utils.showToast(data.error || 'Failed to create teacher account', 'error');
      }
    } catch (err) {
      Utils.showToast('Network error saving teacher', 'error');
    }
  },

  async toggleTeacherStatus(teacherId, currentStatus) {
    const newStatus = currentStatus === 'active' ? 'inactive' : 'active';
    try {
      const res = await App.fetchApi(`/api/admin/teachers/${teacherId}`, {
        method: 'PUT',
        body: JSON.stringify({ status: newStatus })
      });

      if (res.ok) {
        Utils.showToast(`Teacher status updated to ${newStatus}`, 'success');
        this.loadTeachers();
      }
    } catch (err) {
      Utils.showToast('Error updating status', 'error');
    }
  },

  // 3. Student Management & Bulk Import
  async loadStudents() {
    try {
      const secFilter = document.getElementById('admin-student-section-filter').value;
      const search = document.getElementById('admin-student-search').value.trim();

      let url = '/api/admin/students?';
      if (secFilter) url += `section_id=${secFilter}&`;
      if (search) url += `search=${encodeURIComponent(search)}&`;

      const res = await App.fetchApi(url);
      if (!res.ok) return;
      const data = await res.json();

      const tbody = document.getElementById('admin-students-table-body');
      tbody.innerHTML = '';

      data.students.forEach(s => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td><strong>${s.roll_number}</strong></td>
          <td>${s.name}</td>
          <td><code>${s.username}</code></td>
          <td><span class="portal-tag-badge portal-tag-student">${s.section_name}</span></td>
          <td>${s.email || '—'}</td>
          <td><span class="status-tag present">Active</span></td>
        `;
        tbody.appendChild(row);
      });

    } catch (err) {
      console.error('Error loading students:', err);
    }
  },

  openAddStudentModal() {
    document.getElementById('modal-add-student').classList.add('active');
  },

  async saveStudent() {
    const roll = document.getElementById('new-student-roll').value.trim();
    const name = document.getElementById('new-student-name').value.trim();
    const username = document.getElementById('new-student-username').value.trim() || roll;
    const section_id = document.getElementById('new-student-section').value;
    const email = document.getElementById('new-student-email').value.trim();

    if (!roll || !name || !section_id) {
      Utils.showToast('Roll Number, Name, and Section are required.', 'warning');
      return;
    }

    try {
      const res = await App.fetchApi('/api/admin/students', {
        method: 'POST',
        body: JSON.stringify({ roll_number: roll, name, username, section_id: parseInt(section_id, 10), email })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        Utils.showToast('Student added successfully!', 'success');
        document.getElementById('modal-add-student').classList.remove('active');
        this.loadStudents();
        this.loadStats();
      } else {
        Utils.showToast(data.error || 'Failed to add student', 'error');
      }
    } catch (err) {
      Utils.showToast('Network error saving student', 'error');
    }
  },

  openBulkImportModal() {
    document.getElementById('modal-bulk-import').classList.add('active');
  },

  async runBulkImport() {
    const csvData = document.getElementById('bulk-csv-textarea').value.trim();
    const section_id = document.getElementById('bulk-target-section').value;

    if (!csvData) {
      Utils.showToast('Please paste CSV student data first.', 'warning');
      return;
    }

    try {
      Utils.showToast('Importing student records...', 'info');

      const res = await App.fetchApi('/api/admin/students/bulk-import', {
        method: 'POST',
        body: JSON.stringify({ csvData, section_id: parseInt(section_id, 10) })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        Utils.showToast(data.message, 'success');
        document.getElementById('modal-bulk-import').classList.remove('active');
        this.loadStudents();
        this.loadStats();
      } else {
        Utils.showToast(data.error || 'Bulk import failed', 'error');
      }
    } catch (err) {
      Utils.showToast('Network error during bulk import', 'error');
    }
  },

  // 4. Timetable Management
  async loadTimetable() {
    try {
      const res = await App.fetchApi('/api/admin/timetable');
      if (!res.ok) return;
      const data = await res.json();

      const tbody = document.getElementById('admin-timetable-body');
      tbody.innerHTML = '';

      data.timetable.forEach(slot => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td><strong>${slot.day_of_week}</strong></td>
          <td>Slot #${slot.slot_number} (${slot.start_time} - ${slot.end_time})</td>
          <td><strong>${slot.subject_name}</strong> (${slot.subject_code})</td>
          <td>${slot.teacher_name}</td>
          <td><span class="portal-tag-badge portal-tag-student">${slot.section_name}</span></td>
          <td>${slot.room}</td>
        `;
        tbody.appendChild(row);
      });

    } catch (err) {
      console.error('Error loading timetable:', err);
    }
  },

  // 5. Global Audit Logs
  async loadAuditLogs() {
    try {
      const res = await App.fetchApi('/api/admin/audit-logs?limit=50');
      if (!res.ok) return;
      const data = await res.json();

      const tbody = document.getElementById('admin-audit-logs-body');
      tbody.innerHTML = '';

      data.logs.forEach(log => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td><span style="font-size:0.8rem; color:var(--text-secondary);">${log.timestamp}</span></td>
          <td><strong>${log.user_name || 'System'}</strong> (${log.user_role})</td>
          <td><code>${log.action}</code></td>
          <td>${log.details}</td>
          <td><span style="font-size:0.75rem; color:var(--text-muted);">${log.ip_address}</span></td>
        `;
        tbody.appendChild(row);
      });

    } catch (err) {
      console.error('Error loading audit logs:', err);
    }
  },

  // 6. System Reset
  async resetSystemDatabase() {
    if (!confirm('CAUTION: Are you sure you want to reset the NFC-IET database to default factory demo records? All live marks created in this session will be restored.')) {
      return;
    }

    try {
      const res = await App.fetchApi('/api/admin/reset-system', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        Utils.showToast(data.message, 'success');
        setTimeout(() => window.location.reload(), 1200);
      }
    } catch (err) {
      Utils.showToast('Reset failed', 'error');
    }
  }
};
