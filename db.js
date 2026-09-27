let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.warn('better-sqlite3 load warning:', e.message);
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
    console.warn('Could not copy db to /tmp, will initialize new:', e.message);
  }
  dbPath = tmpDbPath;
}

let db;
if (Database) {
  try {
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
  } catch (err) {
    console.warn('Could not open SQLite file with WAL, opening standard mode:', err.message);
    db = new Database(':memory:');
  }
}

function initDatabase() {
  console.log('Initializing NFC-IET Attendance Database...');

  // Create tables
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
      day_of_week TEXT NOT NULL, -- Monday, Tuesday, Wednesday, Thursday, Friday
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
      date TEXT NOT NULL, -- YYYY-MM-DD
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
      date TEXT NOT NULL, -- YYYY-MM-DD
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

  // Check if initial seeding is needed
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount === 0) {
    seedInitialData();
  }
}

function getTodayDayName() {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const today = new Date();
  const dayName = days[today.getDay()];
  // If today is weekend (Saturday/Sunday), treat today as Monday for demonstration purposes so students always see live timetable
  return (dayName === 'Sunday' || dayName === 'Saturday') ? 'Monday' : dayName;
}

function getTodayDateStr() {
  const today = new Date();
  return today.toISOString().split('T')[0];
}

function seedInitialData() {
  console.log('Seeding NFC-IET initial data...');
  const defaultPasswordHash = bcrypt.hashSync('password123', 10);

  const insertDept = db.prepare('INSERT INTO departments (name, code) VALUES (?, ?)');
  const deptCS = insertDept.run('Computer Science', 'CS').lastInsertRowid;
  const deptEE = insertDept.run('Electrical Engineering', 'EE').lastInsertRowid;
  const deptME = insertDept.run('Mechanical Engineering', 'ME').lastInsertRowid;

  const insertSection = db.prepare('INSERT INTO sections (name, batch, department_id) VALUES (?, ?, ?)');
  const secB = insertSection.run('Section B', '2022-2026', deptCS).lastInsertRowid;
  const secA = insertSection.run('Section A', '2022-2026', deptCS).lastInsertRowid;
  const secEE = insertSection.run('Section A', '2022-2026', deptEE).lastInsertRowid;

  // Insert Lecture Slots
  const insertSlot = db.prepare('INSERT INTO lecture_slots (slot_number, start_time, end_time, label) VALUES (?, ?, ?, ?)');
  const slot1 = insertSlot.run(1, '08:30', '09:30', 'Lecture 1 (08:30 AM - 09:30 AM)').lastInsertRowid;
  const slot2 = insertSlot.run(2, '09:30', '10:30', 'Lecture 2 (09:30 AM - 10:30 AM)').lastInsertRowid;
  const slot3 = insertSlot.run(3, '10:45', '11:45', 'Lecture 3 (10:45 AM - 11:45 AM)').lastInsertRowid;
  const slot4 = insertSlot.run(4, '11:45', '12:45', 'Lecture 4 (11:45 AM - 12:45 PM)').lastInsertRowid;
  const slot5 = insertSlot.run(5, '13:30', '14:30', 'Lecture 5 (01:30 PM - 02:30 PM)').lastInsertRowid;

  // Insert Subjects
  const insertSubject = db.prepare('INSERT INTO subjects (code, name, credit_hours, department_id, semester) VALUES (?, ?, ?, ?, ?)');
  const subAI = insertSubject.run('CS-301', 'Artificial Intelligence', 3, deptCS, 5).lastInsertRowid;
  const subDB = insertSubject.run('CS-204', 'Database Systems', 3, deptCS, 5).lastInsertRowid;
  const subCN = insertSubject.run('CS-305', 'Computer Networks', 3, deptCS, 5).lastInsertRowid;
  const subSE = insertSubject.run('CS-208', 'Software Engineering', 3, deptCS, 5).lastInsertRowid;
  const subWT = insertSubject.run('CS-310', 'Web Technologies', 3, deptCS, 5).lastInsertRowid;
  const subML = insertSubject.run('CS-402', 'Machine Learning', 3, deptCS, 7).lastInsertRowid;

  // Insert Users
  const insertUser = db.prepare(`
    INSERT INTO users (username, name, email, password_hash, role, roll_number, section_id, department_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Admin
  insertUser.run('admin', 'Engr. Muhammad Tahir (Registrar/Admin)', 'admin@nfciet.edu.pk', defaultPasswordHash, 'admin', null, null, null, 'active');

  // Teachers
  const tImran = insertUser.run('dr.imran', 'Dr. Imran Khan', 'imran.khan@nfciet.edu.pk', defaultPasswordHash, 'teacher', null, null, deptCS, 'active').lastInsertRowid;
  const tAyesha = insertUser.run('engr.ayesha', 'Engr. Ayesha Malik', 'ayesha.malik@nfciet.edu.pk', defaultPasswordHash, 'teacher', null, null, deptCS, 'active').lastInsertRowid;
  const tKamran = insertUser.run('dr.kamran', 'Dr. Kamran Ali', 'kamran.ali@nfciet.edu.pk', defaultPasswordHash, 'teacher', null, null, deptCS, 'active').lastInsertRowid;
  const tBilal = insertUser.run('engr.bilal', 'Engr. Bilal Farooq', 'bilal.farooq@nfciet.edu.pk', defaultPasswordHash, 'teacher', null, null, deptCS, 'active').lastInsertRowid;

  // Assign teachers to subjects and sections
  const insertAssign = db.prepare('INSERT INTO teacher_assignments (teacher_id, subject_id, section_id) VALUES (?, ?, ?)');
  insertAssign.run(tImran, subAI, secB);
  insertAssign.run(tImran, subAI, secA);
  insertAssign.run(tImran, subML, secB);
  insertAssign.run(tAyesha, subDB, secB);
  insertAssign.run(tAyesha, subWT, secB);
  insertAssign.run(tKamran, subCN, secB);
  insertAssign.run(tKamran, subCN, secA);
  insertAssign.run(tBilal, subSE, secB);

  // Students for Section B (NFC-IET Format e.g. 325 - Section B)
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

  // Students for Section A
  const studentsSecA = [
    { username: '301-A', name: 'Saad Rehman', roll: '22-CS-301', email: 'saad.301@nfciet.edu.pk' },
    { username: '302-A', name: 'Khadija Aslam', roll: '22-CS-302', email: 'khadija.302@nfciet.edu.pk' }
  ];
  studentsSecA.forEach(s => {
    insertUser.run(s.username, s.name, s.email, defaultPasswordHash, 'student', s.roll, secA, deptCS, 'active');
  });

  // Insert Timetable (5 Daily lectures for weekdays)
  const insertTimetable = db.prepare(`
    INSERT INTO timetable (day_of_week, slot_id, subject_id, section_id, teacher_id, room)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const daysOfWeek = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

  // Timetable for Section B
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

  // Timetable for Section A
  const secA_Schedule = [
    { slot: slot1, subject: subDB, teacher: tAyesha, room: 'Room 201' },
    { slot: slot2, subject: subAI, teacher: tImran, room: 'Lab-102' },
    { slot: slot3, subject: subSE, teacher: tBilal, room: 'Room 304' },
    { slot: slot4, subject: subCN, teacher: tKamran, room: 'Hall B' },
    { slot: slot5, subject: subWT, teacher: tAyesha, room: 'Software Lab 1' }
  ];

  daysOfWeek.forEach(day => {
    secA_Schedule.forEach(sch => {
      insertTimetable.run(day, sch.slot, sch.subject, secA, sch.teacher, sch.room);
    });
  });

  // Seed some historical attendance records for the past 14 days
  const insertAttendance = db.prepare(`
    INSERT INTO attendance_records (qr_session_id, timetable_id, student_id, subject_id, section_id, slot_id, date, timestamp, method, status, marked_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date();
  for (let d = 14; d >= 1; d--) {
    const pastDate = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
    const dayOfWeek = daysOfWeek[pastDate.getDay() - 1];
    if (!dayOfWeek) continue; // Skip weekend days

    const dateStr = pastDate.toISOString().split('T')[0];

    // Seed attendance for lectures on that day
    secB_Schedule.forEach(sch => {
      studentIds.forEach((sId, index) => {
        // High attendance rate (~85%) with some realistic variance
        const isPresent = (index % 5 !== 0 || d % 3 !== 0);
        if (isPresent) {
          const timestamp = `${dateStr} 08:35:12`;
          insertAttendance.run(null, null, sId, sch.subject, secB, sch.slot, dateStr, timestamp, 'qr_scan', 'present', sId);
        }
      });
    });
  }

  // Add initial Audit Log
  const insertAudit = db.prepare('INSERT INTO audit_logs (user_id, user_name, user_role, action, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)');
  insertAudit.run(1, 'Engr. Muhammad Tahir (Admin)', 'admin', 'SYSTEM_INIT', 'Initialized NFC-IET Multi-Portal Database with demo timetable & users', '127.0.0.1');

  console.log('NFC-IET Database initialized successfully.');
}

// Reset database helper
function resetDatabase() {
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
  initDatabase();
}

module.exports = {
  db,
  initDatabase,
  resetDatabase,
  getTodayDayName,
  getTodayDateStr
};
