const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

let Database;
let isNativeSqlite = false;

try {
  Database = require('better-sqlite3');
} catch (e) {
  console.warn('Native better-sqlite3 not available (Serverless environment). Using pure-JS relational store.');
}

// Support Vercel serverless environment (/tmp writeable path)
let dbPath = path.join(__dirname, 'attendance.db');
if (process.env.VERCEL) {
  const tmpDbPath = path.join('/tmp', 'attendance.db');
  try {
    if (!fs.existsSync(tmpDbPath) && fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, tmpDbPath);
    }
  } catch (e) {
    // serverless read-only
  }
  dbPath = tmpDbPath;
}

let dbInstance = null;

if (Database) {
  try {
    const nativeDb = new Database(dbPath);
    nativeDb.pragma('foreign_keys = ON');
    nativeDb.pragma('journal_mode = WAL');
    dbInstance = nativeDb;
    isNativeSqlite = true;
  } catch (err) {
    console.warn('Could not initialize native SQLite file, switching to pure-JS fallback engine:', err.message);
  }
}

// Pure JS In-Memory Database Fallback for Serverless / Vercel
class PureJsDatabase {
  constructor() {
    this.tables = {
      departments: [],
      sections: [],
      users: [],
      subjects: [],
      teacher_assignments: [],
      lecture_slots: [],
      timetable: [],
      qr_sessions: [],
      attendance_records: [],
      audit_logs: []
    };
    this.autoInc = {};
  }

  pragma(cmd) {
    return true;
  }

  exec(sql) {
    return true;
  }

  transaction(fn) {
    return (...args) => fn(...args);
  }

  prepare(sql) {
    const trimmed = sql.trim();
    const self = this;

    return {
      run(...params) {
        return self.executeRun(trimmed, params);
      },
      get(...params) {
        const rows = self.executeSelect(trimmed, params);
        return rows.length > 0 ? rows[0] : undefined;
      },
      all(...params) {
        return self.executeSelect(trimmed, params);
      }
    };
  }

  executeRun(sql, params) {
    const s = sql.replace(/\s+/g, ' ');

    if (/^INSERT INTO departments/i.test(s)) {
      const id = this.getNextId('departments');
      this.tables.departments.push({ id, name: params[0], code: params[1] });
      return { lastInsertRowid: id, changes: 1 };
    }

    if (/^INSERT INTO sections/i.test(s)) {
      const id = this.getNextId('sections');
      this.tables.sections.push({ id, name: params[0], batch: params[1], department_id: params[2] });
      return { lastInsertRowid: id, changes: 1 };
    }

    if (/^INSERT INTO lecture_slots/i.test(s)) {
      const id = this.getNextId('lecture_slots');
      this.tables.lecture_slots.push({ id, slot_number: params[0], start_time: params[1], end_time: params[2], label: params[3] });
      return { lastInsertRowid: id, changes: 1 };
    }

    if (/^INSERT INTO subjects/i.test(s)) {
      const id = this.getNextId('subjects');
      this.tables.subjects.push({ id, code: params[0], name: params[1], credit_hours: params[2], department_id: params[3], semester: params[4] });
      return { lastInsertRowid: id, changes: 1 };
    }

    if (/^INSERT (OR IGNORE )?INTO teacher_assignments/i.test(s)) {
      const exists = this.tables.teacher_assignments.find(a => a.teacher_id === params[0] && a.subject_id === params[1] && a.section_id === params[2]);
      if (!exists) {
        const id = this.getNextId('teacher_assignments');
        this.tables.teacher_assignments.push({ id, teacher_id: params[0], subject_id: params[1], section_id: params[2] });
        return { lastInsertRowid: id, changes: 1 };
      }
      return { lastInsertRowid: exists.id, changes: 0 };
    }

    if (/^INSERT INTO users/i.test(s)) {
      const id = this.getNextId('users');
      // users (username, name, email, password_hash, role, roll_number, section_id, department_id, status)
      this.tables.users.push({
        id,
        username: params[0],
        name: params[1],
        email: params[2],
        password_hash: params[3],
        role: params[4] || 'student',
        roll_number: params[5] || null,
        section_id: params[6] || null,
        department_id: params[7] || 1,
        status: params[8] || 'active',
        created_at: new Date().toISOString()
      });
      return { lastInsertRowid: id, changes: 1 };
    }

    if (/^INSERT INTO timetable/i.test(s)) {
      const id = this.getNextId('timetable');
      this.tables.timetable.push({
        id,
        day_of_week: params[0],
        slot_id: params[1],
        subject_id: params[2],
        section_id: params[3],
        teacher_id: params[4],
        room: params[5]
      });
      return { lastInsertRowid: id, changes: 1 };
    }

    if (/^UPDATE timetable/i.test(s)) {
      const target = this.tables.timetable.find(t => t.id === params[3]);
      if (target) {
        target.subject_id = params[0];
        target.teacher_id = params[1];
        target.room = params[2];
      }
      return { changes: target ? 1 : 0 };
    }

    if (/^INSERT INTO qr_sessions/i.test(s)) {
      const id = this.getNextId('qr_sessions');
      this.tables.qr_sessions.push({
        id,
        session_token: params[0],
        timetable_id: params[1],
        teacher_id: params[2],
        subject_id: params[3],
        section_id: params[4],
        slot_id: params[5],
        date: params[6],
        created_at: new Date().toISOString(),
        expires_at: params[7],
        duration_minutes: params[8],
        is_active: 1
      });
      return { lastInsertRowid: id, changes: 1 };
    }

    if (/^UPDATE qr_sessions SET is_active = 0 WHERE teacher_id = \?/i.test(s)) {
      this.tables.qr_sessions.forEach(q => {
        if (q.teacher_id === params[0]) q.is_active = 0;
      });
      return { changes: 1 };
    }

    if (/^UPDATE qr_sessions SET is_active = 0 WHERE id = \?/i.test(s)) {
      const q = this.tables.qr_sessions.find(qs => qs.id === params[0]);
      if (q) q.is_active = 0;
      return { changes: q ? 1 : 0 };
    }

    if (/^INSERT INTO attendance_records/i.test(s)) {
      const id = this.getNextId('attendance_records');
      this.tables.attendance_records.push({
        id,
        qr_session_id: params[0],
        timetable_id: params[1] || null,
        student_id: params[2],
        subject_id: params[3],
        section_id: params[4],
        slot_id: params[5],
        date: params[6],
        timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
        method: params[7] || 'qr_scan',
        status: params[8] || 'present',
        marked_by: params[9] || params[2],
        device_hash: params[10] || 'device'
      });
      return { lastInsertRowid: id, changes: 1 };
    }

    if (/^UPDATE attendance_records SET status = \?/i.test(s)) {
      const rec = this.tables.attendance_records.find(r => r.id === params[3]);
      if (rec) {
        rec.status = params[0];
        rec.method = 'manual_override';
        rec.marked_by = params[1];
        rec.timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
      }
      return { changes: rec ? 1 : 0 };
    }

    if (/^DELETE FROM attendance_records WHERE id = \?/i.test(s)) {
      const idx = this.tables.attendance_records.findIndex(r => r.id === params[0]);
      if (idx !== -1) this.tables.attendance_records.splice(idx, 1);
      return { changes: idx !== -1 ? 1 : 0 };
    }

    if (/^INSERT INTO audit_logs/i.test(s)) {
      const id = this.getNextId('audit_logs');
      this.tables.audit_logs.push({
        id,
        user_id: params[0],
        user_name: params[1],
        user_role: params[2],
        action: params[3],
        details: params[4],
        ip_address: params[5],
        timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19)
      });
      return { lastInsertRowid: id, changes: 1 };
    }

    if (/^UPDATE users/i.test(s)) {
      const id = params[params.length - 1];
      const u = this.tables.users.find(user => user.id === id);
      if (u) {
        if (/password_hash = \?/i.test(s)) u.password_hash = params[0];
        if (params[0] !== undefined && params[0] !== null) u.name = params[0];
        if (params[1] !== undefined && params[1] !== null) u.email = params[1];
        if (params[2] !== undefined && params[2] !== null) u.status = params[2];
      }
      return { changes: u ? 1 : 0 };
    }

    return { changes: 1, lastInsertRowid: 1 };
  }

  executeSelect(sql, params) {
    const s = sql.replace(/\s+/g, ' ');

    if (/SELECT COUNT\(\*\) as count FROM users/i.test(s)) {
      if (/WHERE role = 'student'/i.test(s)) {
        return [{ count: this.tables.users.filter(u => u.role === 'student' && u.status === 'active').length }];
      }
      if (/WHERE role = 'teacher'/i.test(s)) {
        return [{ count: this.tables.users.filter(u => u.role === 'teacher' && u.status === 'active').length }];
      }
      return [{ count: this.tables.users.length }];
    }

    if (/SELECT COUNT\(\*\) as count FROM subjects/i.test(s)) {
      return [{ count: this.tables.subjects.length }];
    }
    if (/SELECT COUNT\(\*\) as count FROM sections/i.test(s)) {
      return [{ count: this.tables.sections.length }];
    }
    if (/SELECT COUNT\(\*\) as count FROM attendance_records WHERE date = \?/i.test(s)) {
      return [{ count: this.tables.attendance_records.filter(r => r.date === params[0]).length }];
    }
    if (/SELECT COUNT\(\*\) as count FROM attendance_records WHERE qr_session_id = \? AND status = 'present'/i.test(s)) {
      return [{ count: this.tables.attendance_records.filter(r => r.qr_session_id === params[0] && r.status === 'present').length }];
    }
    if (/SELECT COUNT\(\*\) as count FROM qr_sessions WHERE is_active = 1/i.test(s)) {
      const now = new Date();
      return [{ count: this.tables.qr_sessions.filter(q => q.is_active === 1 && new Date(q.expires_at) > now).length }];
    }

    if (/SELECT u\.\*.*FROM users u.*WHERE u\.username = \?/i.test(s)) {
      const username = params[0];
      const u = this.tables.users.find(user => user.username.toLowerCase() === String(username).toLowerCase());
      if (!u) return [];
      const sec = this.tables.sections.find(s => s.id === u.section_id);
      const dept = this.tables.departments.find(d => d.id === u.department_id);
      return [{
        ...u,
        section_name: sec ? sec.name : null,
        department_name: dept ? dept.name : null
      }];
    }

    if (/SELECT id FROM users WHERE username = \?/i.test(s)) {
      const u = this.tables.users.find(user => user.username.toLowerCase() === String(params[0]).toLowerCase());
      return u ? [{ id: u.id }] : [];
    }

    if (/SELECT u\.id.*FROM users u.*WHERE u\.id = \?/i.test(s)) {
      const u = this.tables.users.find(user => user.id === params[0]);
      if (!u) return [];
      const sec = this.tables.sections.find(s => s.id === u.section_id);
      const dept = this.tables.departments.find(d => d.id === u.department_id);
      return [{
        ...u,
        section_name: sec ? sec.name : null,
        department_name: dept ? dept.name : null
      }];
    }

    if (/SELECT u\.id.*FROM users u.*WHERE u\.username IN \('admin'/i.test(s)) {
      const demoUsers = this.tables.users.filter(u => ['admin', 'dr.imran', 'engr.ayesha', '325-B', '326-B', '327-B'].includes(u.username));
      return demoUsers.map(u => {
        const sec = this.tables.sections.find(s => s.id === u.section_id);
        return {
          id: u.id,
          username: u.username,
          name: u.name,
          role: u.role,
          roll_number: u.roll_number,
          section_name: sec ? sec.name : null
        };
      });
    }

    if (/SELECT \* FROM lecture_slots/i.test(s)) {
      return [...this.tables.lecture_slots].sort((a, b) => a.slot_number - b.slot_number);
    }

    if (/SELECT \* FROM subjects/i.test(s)) {
      return [...this.tables.subjects].sort((a, b) => a.name.localeCompare(b.name));
    }
    if (/SELECT \* FROM sections/i.test(s)) {
      return [...this.tables.sections].sort((a, b) => a.name.localeCompare(b.name));
    }

    if (/SELECT qs\.\*.*FROM qr_sessions qs.*WHERE qs\.session_token = \?/i.test(s)) {
      const qs = this.tables.qr_sessions.find(q => q.session_token === params[0]);
      if (!qs) return [];
      const sub = this.tables.subjects.find(sb => sb.id === qs.subject_id);
      const teacher = this.tables.users.find(u => u.id === qs.teacher_id);
      const sec = this.tables.sections.find(sc => sc.id === qs.section_id);
      return [{
        ...qs,
        subject_name: sub ? sub.name : 'Subject',
        subject_code: sub ? sub.code : 'CODE',
        teacher_name: teacher ? teacher.name : 'Teacher',
        section_name: sec ? sec.name : 'Section'
      }];
    }

    if (/SELECT qs\.\*.*FROM qr_sessions qs.*WHERE qs\.section_id = \? AND qs\.date = \? AND qs\.is_active = 1/i.test(s)) {
      const section_id = params[0];
      const date = params[1];
      const now = new Date();
      return this.tables.qr_sessions
        .filter(q => q.section_id === section_id && q.date === date && q.is_active === 1 && new Date(q.expires_at) > now)
        .map(q => {
          const sub = this.tables.subjects.find(s => s.id === q.subject_id);
          const teacher = this.tables.users.find(u => u.id === q.teacher_id);
          return {
            ...q,
            subject_name: sub ? sub.name : 'Subject',
            subject_code: sub ? sub.code : 'CODE',
            teacher_name: teacher ? teacher.name : 'Teacher'
          };
        });
    }

    if (/SELECT qs\.\*.*FROM qr_sessions qs.*WHERE qs\.teacher_id = \? AND qs\.is_active = 1/i.test(s)) {
      const teacher_id = params[0];
      const now = new Date();
      const qs = this.tables.qr_sessions.find(q => q.teacher_id === teacher_id && q.is_active === 1 && new Date(q.expires_at) > now);
      if (!qs) return [];
      const sub = this.tables.subjects.find(s => s.id === qs.subject_id);
      const sec = this.tables.sections.find(s => s.id === qs.section_id);
      const slot = this.tables.lecture_slots.find(l => l.id === qs.slot_id);
      return [{
        ...qs,
        subject_name: sub ? sub.name : 'Subject',
        subject_code: sub ? sub.code : 'CODE',
        section_name: sec ? sec.name : 'Section',
        slot_label: slot ? slot.label : `Slot #${qs.slot_id}`
      }];
    }

    if (/SELECT qs\.\*.*FROM qr_sessions qs.*WHERE qs\.id = \?/i.test(s)) {
      const id = params[0];
      const qs = this.tables.qr_sessions.find(q => q.id === id);
      if (!qs) return [];
      const sub = this.tables.subjects.find(s => s.id === qs.subject_id);
      const sec = this.tables.sections.find(s => s.id === qs.section_id);
      const slot = this.tables.lecture_slots.find(l => l.id === qs.slot_id);
      return [{
        ...qs,
        subject_name: sub ? sub.name : 'Subject',
        subject_code: sub ? sub.code : 'CODE',
        section_name: sec ? sec.name : 'Section',
        slot_label: slot ? slot.label : `Slot #${qs.slot_id}`
      }];
    }

    if (/SELECT t\.id.*FROM timetable t.*WHERE t\.section_id = \? AND t\.day_of_week = \?/i.test(s)) {
      const section_id = params[0];
      const day = params[1];
      return this.tables.timetable
        .filter(t => t.section_id === section_id && t.day_of_week === day)
        .map(t => {
          const sub = this.tables.subjects.find(s => s.id === t.subject_id);
          const teacher = this.tables.users.find(u => u.id === t.teacher_id);
          return {
            timetable_id: t.id,
            slot_id: t.slot_id,
            room: t.room,
            subject_id: t.subject_id,
            subject_code: sub ? sub.code : 'CODE',
            subject_name: sub ? sub.name : 'Subject',
            teacher_id: t.teacher_id,
            teacher_name: teacher ? teacher.name : 'Teacher'
          };
        });
    }

    if (/SELECT \* FROM attendance_records WHERE student_id = \? AND date = \?/i.test(s)) {
      return this.tables.attendance_records.filter(r => r.student_id === params[0] && r.date === params[1]);
    }

    if (/SELECT \* FROM attendance_records WHERE student_id = \? AND subject_id = \? AND date = \? AND slot_id = \?/i.test(s)) {
      return this.tables.attendance_records.filter(r => r.student_id === params[0] && r.subject_id === params[1] && r.date === params[2] && r.slot_id === params[3]);
    }

    if (/SELECT ar\.\*.*FROM attendance_records ar.*WHERE ar\.subject_id = \? AND ar\.section_id = \? AND ar\.date = \? AND ar\.slot_id = \?/i.test(s)) {
      return this.tables.attendance_records
        .filter(r => r.subject_id === params[0] && r.section_id === params[1] && r.date === params[2] && r.slot_id === params[3])
        .map(r => {
          const u = this.tables.users.find(usr => usr.id === r.student_id);
          return {
            ...r,
            student_name: u ? u.name : 'Student',
            roll_number: u ? u.roll_number : 'ROLL'
          };
        });
    }

    if (/SELECT id, name, roll_number, email FROM users WHERE section_id = \? AND role = 'student'/i.test(s)) {
      return this.tables.users
        .filter(u => u.section_id === params[0] && u.role === 'student' && u.status === 'active')
        .map(u => ({ id: u.id, name: u.name, roll_number: u.roll_number, email: u.email }));
    }

    if (/SELECT ta\.id.*FROM teacher_assignments ta.*WHERE ta\.teacher_id = \?/i.test(s)) {
      return this.tables.teacher_assignments
        .filter(ta => ta.teacher_id === params[0])
        .map(ta => {
          const sub = this.tables.subjects.find(s => s.id === ta.subject_id);
          const sec = this.tables.sections.find(s => s.id === ta.section_id);
          return {
            id: ta.id,
            subject_id: ta.subject_id,
            section_id: ta.section_id,
            subject_code: sub ? sub.code : 'CODE',
            subject_name: sub ? sub.name : 'Subject',
            section_name: sec ? sec.name : 'Section',
            batch: sec ? sec.batch : '2022-2026'
          };
        });
    }

    if (/SELECT u\.id.*FROM users u.*WHERE u\.role = 'teacher'/i.test(s)) {
      return this.tables.users
        .filter(u => u.role === 'teacher')
        .map(u => {
          const dept = this.tables.departments.find(d => d.id === u.department_id);
          return {
            id: u.id,
            username: u.username,
            name: u.name,
            email: u.email,
            status: u.status,
            created_at: u.created_at,
            department_name: dept ? dept.name : 'CS',
            department_code: dept ? dept.code : 'CS'
          };
        });
    }

    if (/SELECT ta\.teacher_id.*FROM teacher_assignments ta/i.test(s)) {
      return this.tables.teacher_assignments.map(ta => {
        const sub = this.tables.subjects.find(s => s.id === ta.subject_id);
        const sec = this.tables.sections.find(s => s.id === ta.section_id);
        return {
          teacher_id: ta.teacher_id,
          assignment_id: ta.id,
          subject_id: ta.subject_id,
          subject_code: sub ? sub.code : 'CODE',
          subject_name: sub ? sub.name : 'Subject',
          section_id: ta.section_id,
          section_name: sec ? sec.name : 'Section'
        };
      });
    }

    if (/SELECT u\.id.*FROM users u.*WHERE u\.role = 'student'/i.test(s)) {
      let list = this.tables.users.filter(u => u.role === 'student');
      return list.map(u => {
        const sec = this.tables.sections.find(s => s.id === u.section_id);
        const dept = this.tables.departments.find(d => d.id === u.department_id);
        return {
          id: u.id,
          username: u.username,
          name: u.name,
          email: u.email,
          roll_number: u.roll_number,
          status: u.status,
          created_at: u.created_at,
          section_id: u.section_id,
          section_name: sec ? sec.name : 'Section B',
          batch: sec ? sec.batch : '2022-2026',
          department_name: dept ? dept.name : 'CS'
        };
      });
    }

    if (/SELECT t\.id.*FROM timetable t.*JOIN lecture_slots/i.test(s)) {
      return this.tables.timetable.map(t => {
        const ls = this.tables.lecture_slots.find(l => l.id === t.slot_id);
        const sub = this.tables.subjects.find(s => s.id === t.subject_id);
        const u = this.tables.users.find(usr => usr.id === t.teacher_id);
        const sec = this.tables.sections.find(s => s.id === t.section_id);
        return {
          id: t.id,
          day_of_week: t.day_of_week,
          room: t.room,
          slot_id: t.slot_id,
          slot_number: ls ? ls.slot_number : 1,
          slot_label: ls ? ls.label : 'Slot',
          start_time: ls ? ls.start_time : '08:30',
          end_time: ls ? ls.end_time : '09:30',
          subject_id: t.subject_id,
          subject_code: sub ? sub.code : 'CODE',
          subject_name: sub ? sub.name : 'Subject',
          teacher_id: t.teacher_id,
          teacher_name: u ? u.name : 'Teacher',
          section_id: t.section_id,
          section_name: sec ? sec.name : 'Section'
        };
      });
    }

    if (/SELECT \* FROM audit_logs/i.test(s)) {
      return [...this.tables.audit_logs].reverse().slice(0, 50);
    }

    return [];
  }

  getNextId(table) {
    if (!this.autoInc[table]) this.autoInc[table] = 1;
    return this.autoInc[table]++;
  }
}

// Instantiate DB
const db = dbInstance || new PureJsDatabase();

function getTodayDayName() {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const today = new Date();
  const dayName = days[today.getDay()];
  return (dayName === 'Sunday' || dayName === 'Saturday') ? 'Monday' : dayName;
}

function getTodayDateStr() {
  const today = new Date();
  return today.toISOString().split('T')[0];
}

function initDatabase() {
  console.log('Initializing NFC-IET Attendance Database (Engine: ' + (isNativeSqlite ? 'Native SQLite' : 'Pure-JS') + ')...');

  if (isNativeSqlite) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS departments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        code TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        batch TEXT NOT NULL,
        department_id INTEGER,
        FOREIGN KEY (department_id) REFERENCES departments(id)
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        email TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'teacher', 'student')),
        roll_number TEXT,
        section_id INTEGER,
        department_id INTEGER,
        status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (section_id) REFERENCES sections(id),
        FOREIGN KEY (department_id) REFERENCES departments(id)
      );

      CREATE TABLE IF NOT EXISTS subjects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        credit_hours INTEGER DEFAULT 3,
        department_id INTEGER,
        semester INTEGER DEFAULT 5,
        FOREIGN KEY (department_id) REFERENCES departments(id)
      );

      CREATE TABLE IF NOT EXISTS teacher_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_id INTEGER NOT NULL,
        subject_id INTEGER NOT NULL,
        section_id INTEGER NOT NULL,
        FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
        FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE,
        UNIQUE(teacher_id, subject_id, section_id)
      );

      CREATE TABLE IF NOT EXISTS lecture_slots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slot_number INTEGER NOT NULL UNIQUE,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        label TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS timetable (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day_of_week TEXT NOT NULL,
        slot_id INTEGER NOT NULL,
        subject_id INTEGER NOT NULL,
        section_id INTEGER NOT NULL,
        teacher_id INTEGER NOT NULL,
        room TEXT NOT NULL,
        FOREIGN KEY (slot_id) REFERENCES lecture_slots(id),
        FOREIGN KEY (subject_id) REFERENCES subjects(id),
        FOREIGN KEY (section_id) REFERENCES sections(id),
        FOREIGN KEY (teacher_id) REFERENCES users(id),
        UNIQUE(day_of_week, slot_id, section_id)
      );

      CREATE TABLE IF NOT EXISTS qr_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_token TEXT NOT NULL UNIQUE,
        timetable_id INTEGER,
        teacher_id INTEGER NOT NULL,
        subject_id INTEGER NOT NULL,
        section_id INTEGER NOT NULL,
        slot_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        duration_minutes INTEGER DEFAULT 10,
        is_active INTEGER DEFAULT 1,
        FOREIGN KEY (timetable_id) REFERENCES timetable(id),
        FOREIGN KEY (teacher_id) REFERENCES users(id),
        FOREIGN KEY (subject_id) REFERENCES subjects(id),
        FOREIGN KEY (section_id) REFERENCES sections(id),
        FOREIGN KEY (slot_id) REFERENCES lecture_slots(id)
      );

      CREATE TABLE IF NOT EXISTS attendance_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        qr_session_id INTEGER,
        timetable_id INTEGER,
        student_id INTEGER NOT NULL,
        subject_id INTEGER NOT NULL,
        section_id INTEGER NOT NULL,
        slot_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        method TEXT DEFAULT 'qr_scan' CHECK(method IN ('qr_scan', 'manual_override')),
        status TEXT DEFAULT 'present' CHECK(status IN ('present', 'absent', 'late', 'excused')),
        marked_by INTEGER,
        device_hash TEXT,
        FOREIGN KEY (qr_session_id) REFERENCES qr_sessions(id),
        FOREIGN KEY (timetable_id) REFERENCES timetable(id),
        FOREIGN KEY (student_id) REFERENCES users(id),
        FOREIGN KEY (subject_id) REFERENCES subjects(id),
        FOREIGN KEY (section_id) REFERENCES sections(id),
        FOREIGN KEY (slot_id) REFERENCES lecture_slots(id),
        FOREIGN KEY (marked_by) REFERENCES users(id),
        UNIQUE(student_id, subject_id, date, slot_id)
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        user_name TEXT,
        user_role TEXT,
        action TEXT NOT NULL,
        details TEXT,
        ip_address TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount === 0) {
    seedInitialData();
  }
}

function seedInitialData() {
  console.log('Seeding NFC-IET initial data...');
  const defaultPasswordHash = bcrypt.hashSync('password123', 10);

  const insertDept = db.prepare('INSERT INTO departments (name, code) VALUES (?, ?)');
  const deptCS = insertDept.run('Computer Science', 'CS').lastInsertRowid;
  const deptEE = insertDept.run('Electrical Engineering', 'EE').lastInsertRowid;

  const insertSection = db.prepare('INSERT INTO sections (name, batch, department_id) VALUES (?, ?, ?)');
  const secB = insertSection.run('Section B', '2022-2026', deptCS).lastInsertRowid;
  const secA = insertSection.run('Section A', '2022-2026', deptCS).lastInsertRowid;

  // Lecture Slots
  const insertSlot = db.prepare('INSERT INTO lecture_slots (slot_number, start_time, end_time, label) VALUES (?, ?, ?, ?)');
  const slot1 = insertSlot.run(1, '08:30', '09:30', 'Lecture 1 (08:30 AM - 09:30 AM)').lastInsertRowid;
  const slot2 = insertSlot.run(2, '09:30', '10:30', 'Lecture 2 (09:30 AM - 10:30 AM)').lastInsertRowid;
  const slot3 = insertSlot.run(3, '10:45', '11:45', 'Lecture 3 (10:45 AM - 11:45 AM)').lastInsertRowid;
  const slot4 = insertSlot.run(4, '11:45', '12:45', 'Lecture 4 (11:45 AM - 12:45 PM)').lastInsertRowid;
  const slot5 = insertSlot.run(5, '13:30', '14:30', 'Lecture 5 (01:30 PM - 02:30 PM)').lastInsertRowid;

  // Subjects
  const insertSubject = db.prepare('INSERT INTO subjects (code, name, credit_hours, department_id, semester) VALUES (?, ?, ?, ?, ?)');
  const subAI = insertSubject.run('CS-301', 'Artificial Intelligence', 3, deptCS, 5).lastInsertRowid;
  const subDB = insertSubject.run('CS-204', 'Database Systems', 3, deptCS, 5).lastInsertRowid;
  const subCN = insertSubject.run('CS-305', 'Computer Networks', 3, deptCS, 5).lastInsertRowid;
  const subSE = insertSubject.run('CS-208', 'Software Engineering', 3, deptCS, 5).lastInsertRowid;
  const subWT = insertSubject.run('CS-310', 'Web Technologies', 3, deptCS, 5).lastInsertRowid;
  const subML = insertSubject.run('CS-402', 'Machine Learning', 3, deptCS, 7).lastInsertRowid;

  // Users
  const insertUser = db.prepare(`
    INSERT INTO users (username, name, email, password_hash, role, roll_number, section_id, department_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertUser.run('admin', 'Engr. Muhammad Tahir (Registrar/Admin)', 'admin@nfciet.edu.pk', defaultPasswordHash, 'admin', null, null, null, 'active');
  const tImran = insertUser.run('dr.imran', 'Dr. Imran Khan', 'imran.khan@nfciet.edu.pk', defaultPasswordHash, 'teacher', null, null, deptCS, 'active').lastInsertRowid;
  const tAyesha = insertUser.run('engr.ayesha', 'Engr. Ayesha Malik', 'ayesha.malik@nfciet.edu.pk', defaultPasswordHash, 'teacher', null, null, deptCS, 'active').lastInsertRowid;
  const tKamran = insertUser.run('dr.kamran', 'Dr. Kamran Ali', 'kamran.ali@nfciet.edu.pk', defaultPasswordHash, 'teacher', null, null, deptCS, 'active').lastInsertRowid;
  const tBilal = insertUser.run('engr.bilal', 'Engr. Bilal Farooq', 'bilal.farooq@nfciet.edu.pk', defaultPasswordHash, 'teacher', null, null, deptCS, 'active').lastInsertRowid;

  // Teacher Assignments
  const insertAssign = db.prepare('INSERT OR IGNORE INTO teacher_assignments (teacher_id, subject_id, section_id) VALUES (?, ?, ?)');
  insertAssign.run(tImran, subAI, secB);
  insertAssign.run(tImran, subAI, secA);
  insertAssign.run(tImran, subML, secB);
  insertAssign.run(tAyesha, subDB, secB);
  insertAssign.run(tAyesha, subWT, secB);
  insertAssign.run(tKamran, subCN, secB);
  insertAssign.run(tBilal, subSE, secB);

  // Students
  const studentsSecB = [
    { username: '325-B', name: 'Muhammad Hamza', roll: '22-CS-325', email: 'hamza.325@nfciet.edu.pk' },
    { username: '326-B', name: 'Fatima Noor', roll: '22-CS-326', email: 'fatima.326@nfciet.edu.pk' },
    { username: '327-B', name: 'Zainab Bibi', roll: '22-CS-327', email: 'zainab.327@nfciet.edu.pk' },
    { username: '328-B', name: 'Ali Raza', roll: '22-CS-328', email: 'ali.328@nfciet.edu.pk' },
    { username: '329-B', name: 'Usman Ahmed', roll: '22-CS-329', email: 'usman.329@nfciet.edu.pk' },
    { username: '330-B', name: 'Areeba Tariq', roll: '22-CS-330', email: 'areeba.330@nfciet.edu.pk' },
    { username: '331-B', name: 'Bilal Hassan', roll: '22-CS-331', email: 'bilal.331@nfciet.edu.pk' },
    { username: '332-B', name: 'Hassan Javed', roll: '22-CS-332', email: 'hassan.332@nfciet.edu.pk' },
    { username: '333-B', name: 'Maryam Shah', roll: '22-CS-333', email: 'maryam.333@nfciet.edu.pk' },
    { username: '334-B', name: 'Ahmed Zia', roll: '22-CS-334', email: 'ahmed.334@nfciet.edu.pk' },
    { username: '335-B', name: 'Danish Ali', roll: '22-CS-335', email: 'danish.335@nfciet.edu.pk' },
    { username: '336-B', name: 'Sana Ullah', roll: '22-CS-336', email: 'sana.336@nfciet.edu.pk' }
  ];

  const studentIds = [];
  studentsSecB.forEach(s => {
    const sId = insertUser.run(s.username, s.name, s.email, defaultPasswordHash, 'student', s.roll, secB, deptCS, 'active').lastInsertRowid;
    studentIds.push(sId);
  });

  // Timetable
  const insertTimetable = db.prepare(`
    INSERT INTO timetable (day_of_week, slot_id, subject_id, section_id, teacher_id, room)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const daysOfWeek = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const secB_Schedule = [
    { slot: slot1, subject: subAI, teacher: tImran, room: 'Lab-102 / CS Dept' },
    { slot: slot2, subject: subDB, teacher: tAyesha, room: 'Hall B / Academic Block' },
    { slot: slot3, subject: subCN, teacher: tKamran, room: 'Room 304 / Main Wing' },
    { slot: slot4, subject: subSE, teacher: tBilal, room: 'Room 201 / CS Dept' },
    { slot: slot5, subject: subWT, teacher: tAyesha, room: 'Software Lab 2' }
  ];

  daysOfWeek.forEach(day => {
    secB_Schedule.forEach(sch => {
      insertTimetable.run(day, sch.slot, sch.subject, secB, sch.teacher, sch.room);
    });
  });

  // History attendance records for past 14 days
  const insertAttendance = db.prepare(`
    INSERT INTO attendance_records (qr_session_id, timetable_id, student_id, subject_id, section_id, slot_id, date, timestamp, method, status, marked_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date();
  for (let d = 14; d >= 1; d--) {
    const pastDate = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
    const dayOfWeek = daysOfWeek[pastDate.getDay() - 1];
    if (!dayOfWeek) continue;

    const dateStr = pastDate.toISOString().split('T')[0];
    secB_Schedule.forEach(sch => {
      studentIds.forEach((sId, index) => {
        const isPresent = (index % 5 !== 0 || d % 3 !== 0);
        if (isPresent) {
          const timestamp = `${dateStr} 08:35:12`;
          insertAttendance.run(null, null, sId, sch.subject, secB, sch.slot, dateStr, timestamp, 'qr_scan', 'present', sId);
        }
      });
    });
  }

  const insertAudit = db.prepare('INSERT INTO audit_logs (user_id, user_name, user_role, action, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)');
  insertAudit.run(1, 'Engr. Muhammad Tahir (Admin)', 'admin', 'SYSTEM_INIT', 'Initialized NFC-IET Multi-Portal Database', '127.0.0.1');

  console.log('NFC-IET Database initialized successfully.');
}

function resetDatabase() {
  if (isNativeSqlite) {
    db.exec(`
      DROP TABLE IF EXISTS audit_logs;
      DROP TABLE IF EXISTS attendance_records;
      DROP TABLE IF EXISTS qr_sessions;
      DROP TABLE IF EXISTS timetable;
      DROP TABLE IF EXISTS lecture_slots;
      DROP TABLE IF EXISTS teacher_assignments;
      DROP TABLE IF EXISTS subjects;
      DROP TABLE IF EXISTS users;
      DROP TABLE IF EXISTS sections;
      DROP TABLE IF EXISTS departments;
    `);
  } else {
    Object.keys(db.tables).forEach(k => db.tables[k] = []);
  }
  initDatabase();
}

module.exports = {
  db,
  initDatabase,
  resetDatabase,
  getTodayDayName,
  getTodayDateStr
};
