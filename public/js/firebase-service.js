// ==========================================================================
// NFC-IET Multi-Portal System - Firebase Integration Service
// Initializes Firebase Client SDK, Firestore Real-Time DB, and Firebase Auth
// ==========================================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import { 
  getAuth, 
  signInWithPopup, 
  GoogleAuthProvider, 
  signOut,
  onAuthStateChanged 
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { 
  getFirestore, 
  doc, 
  getDoc,
  getDocFromServer, 
  setDoc, 
  addDoc, 
  updateDoc, 
  collection, 
  query, 
  where, 
  orderBy, 
  onSnapshot,
  serverTimestamp 
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

// Operation Types for error handling
export const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write'
};

// Global References
let app = null;
export let auth = null;
export let db = null;
export let isFirebaseReady = false;

// Standard Error Handler per Firebase Integration Skill Specification
export function handleFirestoreError(error, operationType, path = null) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
    authInfo: {
      userId: auth?.currentUser?.uid || null,
      email: auth?.currentUser?.email || null,
      emailVerified: auth?.currentUser?.emailVerified || null,
      isAnonymous: auth?.currentUser?.isAnonymous || null,
      tenantId: auth?.currentUser?.tenantId || null,
      providerInfo: auth?.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    }
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Connection Testing per Skill Specification
export async function testFirestoreConnection() {
  if (!db) return;
  try {
    // Tests connection to server without caching
    await getDocFromServer(doc(db, 'test', 'connection'));
    console.log('✅ Firebase Firestore connection successfully verified.');
    updateFirebaseBadge('connected', '🔥 Cloud Synced (Firestore)');
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn('⚠️ Firebase Firestore: Client is offline or network restricted.');
      updateFirebaseBadge('offline', '⚡ Local Mode (Offline)');
    } else {
      console.info('Firebase connection check response:', error.message || 'Ready');
      updateFirebaseBadge('connected', '🔥 Firebase Active');
    }
  }
}

// UI Badge Updater Helper
function updateFirebaseBadge(status, text) {
  const badge = document.getElementById('firebase-status-badge');
  if (badge) {
    badge.textContent = text;
    badge.className = `firebase-badge ${status}`;
    badge.style.display = 'inline-flex';
  }
}

// Initialize Firebase
export async function initFirebase() {
  try {
    const res = await fetch('/api/firebase-config');
    if (!res.ok) {
      console.warn('Could not fetch Firebase configuration from server.');
      return false;
    }
    const firebaseConfig = await res.json();
    
    app = initializeApp(firebaseConfig);
    // CRITICAL: Load firestore using the explicit firestoreDatabaseId from config
    db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
    auth = getAuth(app);
    isFirebaseReady = true;

    console.log('🔥 Firebase Initialized with Project:', firebaseConfig.projectId);

    // Test connection
    testFirestoreConnection();

    // Listen to Firebase auth changes
    onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        console.log('Firebase Auth User Active:', firebaseUser.email);
        updateFirebaseBadge('connected', `🔥 Firebase: ${firebaseUser.email.split('@')[0]}`);
      } else {
        updateFirebaseBadge('connected', '🔥 Firebase Cloud Ready');
      }
    });

    return true;
  } catch (err) {
    console.error('Firebase initialization failure:', err);
    updateFirebaseBadge('offline', '⚠️ Firebase Inactive');
    return false;
  }
}

// Sign in with Google Popup
export async function signInWithGoogle() {
  if (!auth) {
    throw new Error('Firebase Auth is not initialized');
  }
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const result = await signInWithPopup(auth, provider);
  const user = result.user;

  // Sync with backend API to obtain standard portal JWT token
  const res = await fetch('/api/auth/firebase-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uid: user.uid,
      email: user.email,
      displayName: user.displayName
    })
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || 'Failed to exchange Firebase credentials with NFC-IET portal.');
  }

  const sessionData = await res.json();

  // Also sync user profile doc into Firestore
  try {
    const userDocRef = doc(db, 'users', user.uid);
    await setDoc(userDocRef, {
      uid: user.uid,
      name: sessionData.user.name || user.displayName || 'NFC-IET User',
      email: user.email,
      role: sessionData.user.role || 'student',
      rollNumber: sessionData.user.roll_number || '',
      section: sessionData.user.section_name || 'Section B',
      department: sessionData.user.department_name || 'Department of Computer Science',
      createdAt: new Date().toISOString()
    }, { merge: true });
  } catch (e) {
    console.warn('Optional Firestore profile sync notice:', e.message);
  }

  return sessionData;
}

// Sign out from Firebase
export async function signOutFirebase() {
  if (auth && auth.currentUser) {
    try {
      await signOut(auth);
    } catch (e) {
      console.warn('Sign out warning:', e.message);
    }
  }
}

// Sync Attendance Record to Firestore
export async function syncAttendanceToFirestore(sessionDetails, recordDetails) {
  if (!db || !isFirebaseReady) return null;
  const path = 'attendance_records';
  try {
    const recordId = `rec_${recordDetails.studentId || Date.now()}_${Date.now()}`;
    await setDoc(doc(db, path, recordId), {
      id: recordId,
      sessionId: String(sessionDetails.sessionId || sessionDetails.id || 'sess_1'),
      studentId: String(auth?.currentUser?.uid || recordDetails.studentId || 'std_temp'),
      studentRoll: String(recordDetails.studentRoll || 'N/A'),
      studentName: String(recordDetails.studentName || 'Student'),
      subjectName: String(sessionDetails.subjectName || 'Course'),
      status: recordDetails.status || 'present',
      markedVia: 'qr_scanner',
      timestamp: new Date().toISOString()
    });
    console.log('Attendance record securely backed up to Firestore:', recordId);
    return recordId;
  } catch (err) {
    console.warn('Firestore attendance sync note:', err.message);
    // Don't crash local flow if rules or offline restrict client write
    return null;
  }
}

// Sync Live Session to Firestore
export async function syncSessionToFirestore(sessionData) {
  if (!db || !isFirebaseReady) return null;
  const path = 'sessions';
  try {
    const sessionId = String(sessionData.id);
    await setDoc(doc(db, path, sessionId), {
      id: sessionId,
      teacherId: String(auth?.currentUser?.uid || sessionData.teacher_id || 'teacher'),
      teacherName: String(sessionData.teacher_name || 'Faculty'),
      subjectId: String(sessionData.subject_id || ''),
      subjectName: String(sessionData.subject_name || 'Subject'),
      section: String(sessionData.section_name || 'Section B'),
      lectureDate: String(sessionData.lecture_date || new Date().toISOString().split('T')[0]),
      slotTime: String(sessionData.slot_time || ''),
      code: String(sessionData.active_code || 'QR_VALID'),
      status: 'active',
      createdAt: new Date().toISOString()
    }, { merge: true });
    console.log('Lecture session synced to Firestore:', sessionId);
  } catch (err) {
    console.warn('Firestore session sync note:', err.message);
  }
}

// Make globally accessible on window for classic script integration
window.FirebaseService = {
  initFirebase,
  testFirestoreConnection,
  signInWithGoogle,
  signOutFirebase,
  syncAttendanceToFirestore,
  syncSessionToFirestore,
  handleFirestoreError,
  OperationType
};
