// Shared by every page: the demo accounts, the session and the menu.
const USERS = {
  'ann@example.test': { password: 'ann-demo-pass', role: 'Customer' },
  'admin@example.test': { password: 'admin-demo-pass', role: 'Admin' },
};

function session() {
  try {
    return JSON.parse(localStorage.getItem('session'));
  } catch {
    return null;
  }
}

function signIn(email, password) {
  const user = USERS[email];
  if (!user || user.password !== password) return false;
  localStorage.setItem('session', JSON.stringify({ email, role: user.role }));
  return true;
}

function signOut() {
  localStorage.removeItem('session');
  location.replace('index.html');
}

/** Send anyone who is not signed in (or not in the role) to the login page. */
function requireRole(role) {
  const s = session();
  if (!s || (role && s.role !== role)) location.replace('login.html');
  return s;
}

function menu() {
  const s = session();
  const items = ['<a href="index.html">Home</a>', '<a href="about.html">About</a>'];
  if (s) items.push('<a href="notes.html">Notes</a>');
  if (s && s.role === 'Admin') items.push('<a href="admin.html">Admin</a>', '<a href="export.html">Export</a>');
  items.push(s ? '<a href="logout.html">Sign out</a>' : '<a href="login.html">Sign in</a>');
  document.getElementById('menu').innerHTML = items.join(' | ');
}

document.addEventListener('DOMContentLoaded', menu);
