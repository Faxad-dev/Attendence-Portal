// ==========================================================================
// NFC-IET Attendance Management System - Main App Router & Auth State
// Handles JWT authentication, portal views switching, quick demo account switcher
// ==========================================================================

const App = {
  currentUser: null,
  token: null,
  activePortal: null, // 'student', 'teacher', 'admin'

  async init() {
    console.log('NFC-IET Attendance Management System Initializing...');
    this.token = localStorage.getItem('nfc_jwt_token');

    this.setupGlobalListeners();
    this.setupDemoToolbar();

    // Initialize Firebase
    const initFb = () => {
      if (window.FirebaseService && window.FirebaseService.initFirebase) {
        window.FirebaseService.initFirebase();
      }
    };
    initFb();
    window.addEventListener('load', initFb);

    if (this.token) {
      await this.verifyCurrentSession();
    } else {
      // Default to login view
      this.showLoginView();
    }
  },

  // API Fetch Wrapper with Auth Bearer Token
  async fetchApi(endpoint, options = {}) {
    const headers = options.headers || {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    if (!headers['Content-Type'] && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    return fetch(endpoint, {
      ...options,
      headers
    });
  },

  // Setup Global Event Handlers
  setupGlobalListeners() {
    // Login Form Submit
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.onsubmit = (e) => {
        e.preventDefault();
        this.handleLoginFormSubmit();
      };
    }

    // Portal Selection Tabs on Login Form
    const portalBtns = document.querySelectorAll('.portal-select-btn');
    portalBtns.forEach(btn => {
      btn.onclick = () => {
        portalBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('login-selected-portal').value = btn.dataset.portal;
        this.updateLoginHints(btn.dataset.portal);
      };
    });

    // Google Firebase Login Button
    const googleBtn = document.getElementById('btn-google-firebase');
    if (googleBtn) {
      googleBtn.onclick = async () => {
        try {
          if (!window.FirebaseService || !window.FirebaseService.signInWithGoogle) {
            throw new Error('Firebase Service is still initializing. Please wait a moment.');
          }
          Utils.showToast('Connecting to Firebase Google Auth...', 'info');
          const data = await window.FirebaseService.signInWithGoogle();
          this.token = data.token;
          this.currentUser = data.user;
          localStorage.setItem('nfc_jwt_token', this.token);
          this.updateHeaderProfile();
          this.switchPortal(this.currentUser.role);
          Utils.showToast(`Welcome ${this.currentUser.name} (Firebase Verified)`, 'success');
        } catch (err) {
          console.error('Firebase Auth error:', err);
          Utils.showToast(err.message || 'Firebase Google Sign-In failed', 'error');
        }
      };
    }

    // Logout Button
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) {
      logoutBtn.onclick = () => this.logout();
    }

    // Portal Navigation Tabs
    const navTabs = document.querySelectorAll('.nav-tab-btn');
    navTabs.forEach(tab => {
      tab.onclick = () => {
        const portal = tab.dataset.portal;
        if (this.currentUser && this.currentUser.role === portal) {
          this.switchPortal(portal);
        } else if (this.currentUser && this.currentUser.role === 'admin') {
          // Admin can preview all views
          this.switchPortal(portal);
        } else {
          Utils.showToast(`Access Restricted: You are logged in as ${this.currentUser ? this.currentUser.role : 'guest'}.`, 'warning');
        }
      };
    });

    // Modal Close buttons
    document.querySelectorAll('.btn-close-modal').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.remove('active'));
      };
    });
  },

  // Update hints dynamically on login screen
  updateLoginHints(portal) {
    const hintBox = document.getElementById('login-credential-hints');
    if (!hintBox) return;

    if (portal === 'student') {
      hintBox.innerHTML = `💡 <strong>Student Login:</strong> Use Roll No / Username <code>325-B</code>, <code>326-B</code>, or <code>327-B</code> (Password: <code>password123</code>)`;
    } else if (portal === 'teacher') {
      hintBox.innerHTML = `💡 <strong>Teacher Login:</strong> Use Username <code>dr.imran</code> or <code>engr.ayesha</code> (Password: <code>password123</code>)`;
    } else if (portal === 'admin') {
      hintBox.innerHTML = `💡 <strong>Admin Login:</strong> Use Username <code>admin</code> (Password: <code>password123</code>)`;
    }
  },

  // Setup Top Demo Quick-Switch Bar
  setupDemoToolbar() {
    const demoPills = document.querySelectorAll('.demo-pill');
    demoPills.forEach(pill => {
      pill.onclick = async () => {
        const username = pill.dataset.username;
        if (!username) return;

        Utils.showToast(`Switching session to ${pill.textContent.trim()}...`, 'info');
        await this.quickSwitchUser(username);
      };
    });
  },

  // Quick switch user account
  async quickSwitchUser(username) {
    try {
      const res = await fetch('/api/auth/quick-switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username })
      });

      const data = await res.json();
      if (res.ok && data.token) {
        this.token = data.token;
        this.currentUser = data.user;
        localStorage.setItem('nfc_jwt_token', this.token);
        this.onAuthenticated();
      } else {
        Utils.showToast(data.error || 'Quick switch failed', 'error');
      }
    } catch (e) {
      console.error('Quick switch error:', e);
    }
  },

  // Handle Login Form Submit
  async handleLoginFormSubmit() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const portal = document.getElementById('login-selected-portal').value;

    if (!username || !password) {
      Utils.showToast('Please enter both username and password.', 'warning');
      return;
    }

    try {
      Utils.showToast('Authenticating with NFC-IET server...', 'info');

      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, portal })
      });

      const data = await res.json();

      if (res.ok && data.token) {
        this.token = data.token;
        this.currentUser = data.user;
        localStorage.setItem('nfc_jwt_token', this.token);
        Utils.playSuccessChime();
        Utils.showToast(`Welcome back, ${this.currentUser.name}!`, 'success');
        this.onAuthenticated();
      } else {
        Utils.playErrorBuzz();
        Utils.showToast(data.error || 'Authentication failed', 'error');
      }
    } catch (err) {
      Utils.showToast('Connection to NFC-IET server failed.', 'error');
    }
  },

  // Verify stored session
  async verifyCurrentSession() {
    try {
      const res = await this.fetchApi('/api/auth/me');
      if (res.ok) {
        const data = await res.json();
        this.currentUser = data.user;
        this.onAuthenticated();
      } else {
        this.logout();
      }
    } catch (e) {
      this.logout();
    }
  },

  // Callback after successful authentication
  onAuthenticated() {
    document.getElementById('login-wrapper').style.display = 'none';
    document.getElementById('portal-nav').style.display = 'block';
    document.getElementById('user-profile-badge').style.display = 'flex';

    // Update Header Profile Info
    document.getElementById('header-user-name').textContent = this.currentUser.name;
    document.getElementById('header-user-role').textContent = `${this.currentUser.role.toUpperCase()} ${this.currentUser.roll_number ? `(${this.currentUser.roll_number})` : ''}`;

    // Highlight active demo pill
    document.querySelectorAll('.demo-pill').forEach(p => {
      p.classList.toggle('active', p.dataset.username === this.currentUser.username);
    });

    // Route to user's assigned portal
    this.switchPortal(this.currentUser.role);
  },

  // Switch between Portal views
  switchPortal(role) {
    this.activePortal = role;

    // Update Nav Tab UI
    document.querySelectorAll('.nav-tab-btn').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.portal === role);
    });

    // Hide all portal views
    document.querySelectorAll('.portal-view').forEach(view => {
      view.classList.remove('active');
    });

    // Show selected portal
    const targetView = document.getElementById(`view-${role}-portal`);
    if (targetView) {
      targetView.classList.add('active');
    }

    // Initialize portal specific logic
    if (role === 'student') {
      StudentPortal.init();
    } else if (role === 'teacher') {
      TeacherPortal.init();
    } else if (role === 'admin') {
      AdminPortal.init();
    }
  },

  // Show Login Screen
  showLoginView() {
    document.getElementById('login-wrapper').style.display = 'block';
    document.getElementById('portal-nav').style.display = 'none';
    document.getElementById('user-profile-badge').style.display = 'none';

    document.querySelectorAll('.portal-view').forEach(view => {
      view.classList.remove('active');
    });
  },

  // Logout
  logout() {
    this.token = null;
    this.currentUser = null;
    localStorage.removeItem('nfc_jwt_token');
    if (window.FirebaseService && window.FirebaseService.signOutFirebase) {
      window.FirebaseService.signOutFirebase();
    }
    Utils.showToast('Logged out of NFC-IET portal.', 'info');
    this.showLoginView();
  }
};

// Bootstrap application on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
