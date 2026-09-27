# NFC-IET QR Attendance Portal - Security Specification

## 1. Data Invariants
1. **Identity & Ownership Integrity**: A student can only view their own attendance records or mark attendance with their own verified `request.auth.uid`. A user cannot claim an admin or teacher role unless explicitly designated in `/admins/{adminId}` or assigned by an admin.
2. **Session Lifecycle Invariant**: Only an authenticated teacher or admin can create an `AttendanceSession`. A session once marked `closed` cannot be reactivated or manipulated to record retro-active student scans.
3. **Record Immutability**: An `AttendanceRecord` cannot alter its `studentId`, `sessionId`, or `timestamp` after creation. Attendance records for a session can only be marked if the parent `AttendanceSession` exists and is `active`.
4. **Denial-of-Wallet & Volumetric Boundaries**: Document IDs, user names, subject names, details, and codes must not exceed strict volumetric limits (strings bounded by `<= 128`, `<= 100`, etc., matching regular expression `^[a-zA-Z0-9_\-]+$`).
5. **No Blanket Reads**: Student queries and lists must be constrained to their own `studentId == request.auth.uid`. Teachers can only manage sessions where `teacherId == request.auth.uid`. Admins have institutional oversight.

---

## 2. The "Dirty Dozen" Payloads (Vulnerability Payloads)

Each of the following 12 attack vectors must be rejected with `PERMISSION_DENIED`:

### Payload 1: Unauthenticated Session Creation
```json
{
  "op": "create",
  "path": "/sessions/session_xyz",
  "auth": null,
  "data": { "id": "session_xyz", "teacherId": "attacker", "status": "active", "code": "QR123" }
}
```

### Payload 2: Student Identity Spoofing (Student A marking Student B)
```json
{
  "op": "create",
  "path": "/sessions/session_101/records/rec_spoofed",
  "auth": { "uid": "student_attacker_1" },
  "data": {
    "id": "rec_spoofed",
    "sessionId": "session_101",
    "studentId": "victim_student_2",
    "studentRoll": "326-B",
    "studentName": "Fatima Noor",
    "status": "present"
  }
}
```

### Payload 3: Privilege Escalation via User Profile Self-Promotion
```json
{
  "op": "create",
  "path": "/users/user_attacker_1",
  "auth": { "uid": "user_attacker_1", "token": { "email": "attacker@fake.com", "email_verified": true } },
  "data": {
    "uid": "user_attacker_1",
    "name": "Attacker",
    "email": "attacker@fake.com",
    "role": "admin"
  }
}
```

### Payload 4: Orphaned Record Creation (Non-Existent Session)
```json
{
  "op": "create",
  "path": "/sessions/non_existent_session/records/rec_orphan",
  "auth": { "uid": "student_123" },
  "data": {
    "id": "rec_orphan",
    "sessionId": "non_existent_session",
    "studentId": "student_123",
    "studentRoll": "325-B",
    "studentName": "Muhammad Hamza",
    "status": "present"
  }
}
```

### Payload 5: Attendance Modification on Closed Session
```json
{
  "op": "create",
  "path": "/sessions/session_closed_999/records/rec_late",
  "auth": { "uid": "student_123" },
  "data": {
    "id": "rec_late",
    "sessionId": "session_closed_999",
    "studentId": "student_123",
    "studentRoll": "325-B",
    "studentName": "Muhammad Hamza",
    "status": "present"
  }
}
```

### Payload 6: ID Poisoning (1KB Payload Buffer Attack on Path Variable)
```json
{
  "op": "get",
  "path": "/users/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "auth": { "uid": "legit_user" }
}
```

### Payload 7: Shadow Field Injection (Ghost Admin Flag in Session)
```json
{
  "op": "create",
  "path": "/sessions/session_hack",
  "auth": { "uid": "teacher_1" },
  "data": {
    "id": "session_hack",
    "teacherId": "teacher_1",
    "teacherName": "Dr. Imran",
    "subjectName": "Machine Learning",
    "section": "Section B",
    "status": "active",
    "code": "CODE_OK",
    "isRootOverride": true,
    "bypassAudit": true
  }
}
```

### Payload 8: Blanket Student Data Scraping (Unauthorized List of All Students)
```json
{
  "op": "list",
  "path": "/users",
  "auth": { "uid": "student_123" },
  "query": {}
}
```

### Payload 9: Unauthorized Attendance Record Tampering (Status Override)
```json
{
  "op": "update",
  "path": "/sessions/session_101/records/rec_1",
  "auth": { "uid": "student_123" },
  "data": {
    "status": "present"
  }
}
```

### Payload 10: Unauthorized Audit Log Manipulation / Deletion
```json
{
  "op": "delete",
  "path": "/audit_logs/log_999",
  "auth": { "uid": "student_123" }
}
```

### Payload 11: Teacher Session Hijacking (Teacher B modifying Teacher A's Session)
```json
{
  "op": "update",
  "path": "/sessions/teacher_a_session",
  "auth": { "uid": "teacher_b" },
  "data": {
    "status": "closed"
  }
}
```

### Payload 12: Unverified Email Admin Escalation (Spoofed Email Token)
```json
{
  "op": "write",
  "path": "/admins/admin_fake",
  "auth": { "uid": "fake_admin", "token": { "email": "faadaali.98@gmail.com", "email_verified": false } },
  "data": {
    "role": "admin"
  }
}
```

---

## 3. Security Test Runner (firestore.rules.test.ts)
```typescript
import { assertFails, assertSucceeds, initializeTestEnvironment, RulesTestEnvironment } from '@firebase/rules-unit-testing';
import * as fs from 'fs';

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'zany-memento-2v9wh',
    firestore: {
      rules: fs.readFileSync('firestore.rules', 'utf8'),
      host: 'localhost',
      port: 8080,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

describe('NFC-IET Security Rules - Dirty Dozen Validation', () => {
  test('Payload 1: Reject unauthenticated session creation', async () => {
    const unauthDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(unauthDb.doc('sessions/session_xyz').set({
      id: 'session_xyz',
      teacherId: 'attacker',
      status: 'active',
      code: 'QR123',
    }));
  });

  test('Payload 2: Reject student identity spoofing', async () => {
    const studentDb = testEnv.authenticatedContext('student_attacker_1', { email_verified: true }).firestore();
    await assertFails(studentDb.doc('sessions/session_101/records/rec_spoofed').set({
      id: 'rec_spoofed',
      sessionId: 'session_101',
      studentId: 'victim_student_2',
      studentRoll: '326-B',
      studentName: 'Fatima Noor',
      status: 'present',
    }));
  });

  test('Payload 3: Reject self-assigned admin role', async () => {
    const attackerDb = testEnv.authenticatedContext('user_attacker_1', { email_verified: true }).firestore();
    await assertFails(attackerDb.doc('users/user_attacker_1').set({
      uid: 'user_attacker_1',
      name: 'Attacker',
      email: 'attacker@fake.com',
      role: 'admin',
    }));
  });

  test('Payload 4: Reject orphaned attendance records', async () => {
    const studentDb = testEnv.authenticatedContext('student_123', { email_verified: true }).firestore();
    await assertFails(studentDb.doc('sessions/non_existent_session/records/rec_orphan').set({
      id: 'rec_orphan',
      sessionId: 'non_existent_session',
      studentId: 'student_123',
      studentRoll: '325-B',
      studentName: 'Muhammad Hamza',
      status: 'present',
    }));
  });

  test('Payload 5: Reject attendance on closed session', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await context.firestore().doc('sessions/session_closed_999').set({
        id: 'session_closed_999',
        teacherId: 'teacher_1',
        teacherName: 'Dr. Imran',
        subjectName: 'AI',
        section: 'Section B',
        status: 'closed',
        code: 'CLOSED_QR',
      });
    });

    const studentDb = testEnv.authenticatedContext('student_123', { email_verified: true }).firestore();
    await assertFails(studentDb.doc('sessions/session_closed_999/records/rec_late').set({
      id: 'rec_late',
      sessionId: 'session_closed_999',
      studentId: 'student_123',
      studentRoll: '325-B',
      studentName: 'Muhammad Hamza',
      status: 'present',
    }));
  });

  test('Payload 6: Reject ID poisoning / malformed document IDs', async () => {
    const userDb = testEnv.authenticatedContext('legit_user', { email_verified: true }).firestore();
    const maliciousId = 'A'.repeat(200);
    await assertFails(userDb.doc(`users/${maliciousId}`).get());
  });

  test('Payload 7: Reject shadow field injection', async () => {
    const teacherDb = testEnv.authenticatedContext('teacher_1', { email_verified: true }).firestore();
    await assertFails(teacherDb.doc('sessions/session_hack').set({
      id: 'session_hack',
      teacherId: 'teacher_1',
      teacherName: 'Dr. Imran',
      subjectName: 'Machine Learning',
      section: 'Section B',
      status: 'active',
      code: 'CODE_OK',
      isRootOverride: true,
      bypassAudit: true,
    }));
  });

  test('Payload 8: Reject blanket student query scraping', async () => {
    const studentDb = testEnv.authenticatedContext('student_123', { email_verified: true }).firestore();
    await assertFails(studentDb.collection('users').get());
  });

  test('Payload 9: Reject student tampering with recorded attendance', async () => {
    const studentDb = testEnv.authenticatedContext('student_123', { email_verified: true }).firestore();
    await assertFails(studentDb.doc('sessions/session_101/records/rec_1').update({
      status: 'present',
    }));
  });

  test('Payload 10: Reject student deleting audit logs', async () => {
    const studentDb = testEnv.authenticatedContext('student_123', { email_verified: true }).firestore();
    await assertFails(studentDb.doc('audit_logs/log_999').delete());
  });

  test('Payload 11: Reject teacher hijacking other teacher session', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await context.firestore().doc('sessions/teacher_a_session').set({
        id: 'teacher_a_session',
        teacherId: 'teacher_a',
        teacherName: 'Engr. Ayesha',
        subjectName: 'Databases',
        section: 'Section B',
        status: 'active',
        code: 'QR_ABC',
      });
    });

    const teacherBDb = testEnv.authenticatedContext('teacher_b', { email_verified: true }).firestore();
    await assertFails(teacherBDb.doc('sessions/teacher_a_session').update({
      status: 'closed',
    }));
  });

  test('Payload 12: Reject unverified email pretending to be admin', async () => {
    const spoofDb = testEnv.authenticatedContext('fake_admin', {
      email: 'faadaali.98@gmail.com',
      email_verified: false,
    }).firestore();
    await assertFails(spoofDb.doc('admins/admin_fake').set({ role: 'admin' }));
  });
});
```
