// ════════════════════════════════════════════════════════
//  Brothers Gym Portal — Node.js / Express Backend
//  Handles: Real OTP via Fast2SMS, Members, Payments, Auth
// ════════════════════════════════════════════════════════

require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Rate limiters ──────────────────────────────────────
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5,                    // max 5 OTP requests per IP per 10 min
  message: { success: false, message: 'Too many OTP requests. Try after 10 minutes.' }
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many login attempts.' }
});

// ════════════════════════════════════════════════════════
//  FILE-BASED DATA STORE  (replace with DB in production)
// ════════════════════════════════════════════════════════
const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file) {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return []; }
}
function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// Seed demo data if empty
function seedData() {
  if (readJSON('members.json').length > 0) return;
  const today = new Date();
  function dago(n) {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return d.toISOString().split('T')[0];
  }
  const members = [
    { id: 'M001', name: 'Rahul Sharma',  phone: '9876543210', plan: 'monthly',   admissionDate: dago(5),  gender: 'Male',   notes: '',           emergency: '', paymentStatus: 'paid',    password: 'pass123' },
    { id: 'M002', name: 'Priya Singh',   phone: '9876543211', plan: 'quarterly', admissionDate: dago(85), gender: 'Female', notes: '',           emergency: '', paymentStatus: 'paid',    password: 'pass123' },
    { id: 'M003', name: 'Amit Yadav',    phone: '9876543212', plan: 'annual',    admissionDate: dago(10), gender: 'Male',   notes: 'Knee issue', emergency: '', paymentStatus: 'paid',    password: 'pass123' },
    { id: 'M004', name: 'Sunita Devi',   phone: '9876543213', plan: 'monthly',   admissionDate: dago(27), gender: 'Female', notes: '',           emergency: '', paymentStatus: 'pending', password: 'pass123' },
    { id: 'M005', name: 'Vikram Patel',  phone: '9876543214', plan: 'monthly',   admissionDate: dago(25), gender: 'Male',   notes: '',           emergency: '', paymentStatus: 'paid',    password: 'pass123' },
  ];
  writeJSON('members.json', members);

  const PLAN_PRICE = { monthly: 800, quarterly: 2100, annual: 7500 };
  const payments = members.map(m => ({
    id: 'P' + uuidv4().substr(0, 6).toUpperCase(),
    memberId: m.id, memberName: m.name, phone: m.phone,
    plan: m.plan, amount: PLAN_PRICE[m.plan],
    date: m.admissionDate, status: m.paymentStatus
  }));
  writeJSON('payments.json', payments);
  writeJSON('notifications.json', []);
  console.log('✅ Demo data seeded.');
}
seedData();

// ════════════════════════════════════════════════════════
//  IN-MEMORY OTP STORE  { phone: { otp, expiresAt, attempts } }
// ════════════════════════════════════════════════════════
const otpStore = {};

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ════════════════════════════════════════════════════════
//  REAL SMS via Fast2SMS
// ════════════════════════════════════════════════════════
async function sendSMS(phone, otp) {
  const apiKey = process.env.FAST2SMS_API_KEY;

  // ── DEV MODE: if no API key, log OTP to console ──────
  if (!apiKey || apiKey === 'YOUR_FAST2SMS_API_KEY_HERE') {
    console.log(`\n📱 [DEV MODE] OTP for ${phone}: ${otp}\n`);
    return { success: true, devMode: true };
  }

  // ── PRODUCTION: send real SMS via Fast2SMS ────────────
  try {
    const response = await axios.get('https://www.fast2sms.com/dev/bulkV2', {
      params: {
        authorization: apiKey,
        variables_values: otp,
        route: 'otp',
        numbers: phone
      },
      headers: { 'cache-control': 'no-cache' },
      timeout: 10000
    });

    if (response.data.return === true) {
      console.log(`✅ OTP sent to ${phone}`);
      return { success: true };
    } else {
      console.error('Fast2SMS error:', response.data);
      return { success: false, error: response.data.message?.[0] || 'SMS failed' };
    }
  } catch (err) {
    console.error('Fast2SMS request failed:', err.message);
    return { success: false, error: 'SMS service unavailable' };
  }
}

// ════════════════════════════════════════════════════════
//  OTP ROUTES
// ════════════════════════════════════════════════════════

// POST /api/otp/send  { phone }
app.post('/api/otp/send', otpLimiter, async (req, res) => {
  let { phone } = req.body;
  phone = String(phone).replace(/\D/g, '').slice(-10); // keep last 10 digits

  if (!phone || phone.length !== 10) {
    return res.json({ success: false, message: 'Enter a valid 10-digit phone number.' });
  }

  const otp = generateOTP();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

  otpStore[phone] = { otp, expiresAt, attempts: 0 };

  const result = await sendSMS(phone, otp);

  if (!result.success) {
    return res.json({ success: false, message: 'Failed to send OTP. Try again.' });
  }

  const response = { success: true, message: 'OTP sent successfully!' };
  if (result.devMode) {
    response.devMode = true;
    response.devOtp = otp; // Only shown in dev mode — never in production
    response.message = `[DEV] OTP: ${otp} (check server console too)`;
  }
  res.json(response);
});

// POST /api/otp/verify  { phone, otp }
app.post('/api/otp/verify', (req, res) => {
  let { phone, otp } = req.body;
  phone = String(phone).replace(/\D/g, '').slice(-10);

  const stored = otpStore[phone];
  if (!stored) return res.json({ success: false, message: 'No OTP sent to this number. Request a new one.' });
  if (Date.now() > stored.expiresAt) {
    delete otpStore[phone];
    return res.json({ success: false, message: 'OTP expired. Please request a new one.' });
  }
  stored.attempts = (stored.attempts || 0) + 1;
  if (stored.attempts > 5) {
    delete otpStore[phone];
    return res.json({ success: false, message: 'Too many wrong attempts. Request a new OTP.' });
  }
  if (String(stored.otp) !== String(otp)) {
    return res.json({ success: false, message: `Wrong OTP. ${5 - stored.attempts} attempts left.` });
  }

  delete otpStore[phone]; // OTP used — delete it
  res.json({ success: true, message: 'OTP verified!' });
});

// ════════════════════════════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════════════════════════════

// POST /api/auth/signup  { name, phone, password }
app.post('/api/auth/signup', (req, res) => {
  const { name, phone, password } = req.body;
  const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
  if (!name || !cleanPhone || !password) return res.json({ success: false, message: 'All fields required.' });
  if (password.length < 6) return res.json({ success: false, message: 'Password must be at least 6 characters.' });

  const members = readJSON('members.json');
  const existing = members.find(m => m.phone === cleanPhone);
  if (existing && existing.password) {
    return res.json({ success: false, message: 'Account already exists. Please login.' });
  }

  if (existing) {
    // Admin pre-registered this member — just set their password
    existing.password = password;
    writeJSON('members.json', members);
    return res.json({ success: true, message: 'Account activated!', member: sanitize(existing) });
  }

  // New self-registration
  const id = 'M' + Date.now().toString().slice(-6);
  const newMember = { id, name, phone: cleanPhone, plan: 'monthly', admissionDate: new Date().toISOString().split('T')[0], gender: '', notes: '', emergency: '', paymentStatus: 'pending', password };
  members.push(newMember);
  writeJSON('members.json', members);
  res.json({ success: true, message: 'Account created!', member: sanitize(newMember) });
});

// POST /api/auth/login  { phone, password }
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { phone, password } = req.body;
  const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
  const members = readJSON('members.json');
  const m = members.find(x => x.phone === cleanPhone && x.password === password);
  if (!m) return res.json({ success: false, message: 'Wrong phone number or password.' });
  res.json({ success: true, member: sanitize(m) });
});

// POST /api/auth/reset-password  { phone, password }
app.post('/api/auth/reset-password', (req, res) => {
  const { phone, password } = req.body;
  const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
  if (!password || password.length < 6) return res.json({ success: false, message: 'Password too short.' });
  const members = readJSON('members.json');
  const idx = members.findIndex(m => m.phone === cleanPhone);
  if (idx === -1) return res.json({ success: false, message: 'No account found.' });
  members[idx].password = password;
  writeJSON('members.json', members);
  res.json({ success: true, message: 'Password reset successfully!' });
});

// POST /api/auth/change-password  { phone, oldPassword, newPassword }
app.post('/api/auth/change-password', (req, res) => {
  const { phone, oldPassword, newPassword } = req.body;
  const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
  const members = readJSON('members.json');
  const idx = members.findIndex(m => m.phone === cleanPhone);
  if (idx === -1) return res.json({ success: false, message: 'Account not found.' });
  if (members[idx].password !== oldPassword) return res.json({ success: false, message: 'Current password is wrong.' });
  if (newPassword.length < 6) return res.json({ success: false, message: 'New password too short.' });
  members[idx].password = newPassword;
  writeJSON('members.json', members);
  res.json({ success: true, message: 'Password changed successfully!' });
});

// POST /api/auth/admin  { password }
app.post('/api/auth/admin', (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.json({ success: false, message: 'Wrong admin password.' });
  }
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════
//  MEMBER ROUTES
// ════════════════════════════════════════════════════════
function sanitize(m) {
  const { password, ...safe } = m;
  return safe;
}

// GET /api/members
app.get('/api/members', (req, res) => {
  res.json(readJSON('members.json').map(sanitize));
});

// POST /api/members  — add member (admin)
app.post('/api/members', (req, res) => {
  const { name, phone, plan, admissionDate, gender, emergency, notes, paymentStatus } = req.body;
  const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
  if (!name || !cleanPhone || !plan || !admissionDate) {
    return res.json({ success: false, message: 'Name, phone, plan and date are required.' });
  }
  const members = readJSON('members.json');
  const existing = members.find(m => m.phone === cleanPhone);
  const PLAN_PRICE = { monthly: 800, quarterly: 2100, annual: 7500 };

  if (existing) {
    // Update plan for existing member
    existing.plan = plan;
    existing.admissionDate = admissionDate;
    existing.gender = gender || existing.gender;
    existing.emergency = emergency || existing.emergency;
    existing.notes = notes || existing.notes;
    existing.paymentStatus = paymentStatus || 'pending';
    writeJSON('members.json', members);

    // Log payment
    addPayment({ memberId: existing.id, memberName: existing.name, phone: cleanPhone, plan, amount: PLAN_PRICE[plan], date: admissionDate, status: paymentStatus || 'pending' });
    return res.json({ success: true, message: `${name}'s membership updated.`, member: sanitize(existing) });
  }

  const id = 'M' + Date.now().toString().slice(-6);
  const newMember = { id, name, phone: cleanPhone, plan, admissionDate, gender: gender || '', emergency: emergency || '', notes: notes || '', paymentStatus: paymentStatus || 'pending', password: 'gym123' };
  members.push(newMember);
  writeJSON('members.json', members);
  addPayment({ memberId: id, memberName: name, phone: cleanPhone, plan, amount: PLAN_PRICE[plan], date: admissionDate, status: paymentStatus || 'pending' });
  res.json({ success: true, message: `${name} added. Default password: gym123`, member: sanitize(newMember) });
});

// PUT /api/members/:id  — edit member
app.put('/api/members/:id', (req, res) => {
  const members = readJSON('members.json');
  const idx = members.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.json({ success: false, message: 'Member not found.' });
  Object.assign(members[idx], req.body);
  writeJSON('members.json', members);
  res.json({ success: true, member: sanitize(members[idx]) });
});

// DELETE /api/members/:id
app.delete('/api/members/:id', (req, res) => {
  const members = readJSON('members.json');
  const filtered = members.filter(m => m.id !== req.params.id);
  writeJSON('members.json', filtered);
  res.json({ success: true });
});

// POST /api/members/:id/renew
app.post('/api/members/:id/renew', (req, res) => {
  const { plan, date, paymentStatus } = req.body;
  const members = readJSON('members.json');
  const idx = members.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.json({ success: false, message: 'Member not found.' });
  const PLAN_PRICE = { monthly: 800, quarterly: 2100, annual: 7500 };
  members[idx].plan = plan;
  members[idx].admissionDate = date;
  members[idx].paymentStatus = paymentStatus;
  writeJSON('members.json', members);
  addPayment({ memberId: members[idx].id, memberName: members[idx].name, phone: members[idx].phone, plan, amount: PLAN_PRICE[plan], date, status: paymentStatus });
  // Add notification
  addNotification({ type: 'success', icon: '✅', title: `${members[idx].name} membership renewed`, desc: `New plan: ${plan}. Renewed on ${date}.`, memberId: members[idx].id });
  res.json({ success: true, member: sanitize(members[idx]) });
});

// ════════════════════════════════════════════════════════
//  PAYMENT ROUTES
// ════════════════════════════════════════════════════════
function addPayment(data) {
  const payments = readJSON('payments.json');
  payments.unshift({ id: 'P' + uuidv4().substr(0, 6).toUpperCase(), ...data, createdAt: new Date().toISOString() });
  writeJSON('payments.json', payments);
}

// GET /api/payments
app.get('/api/payments', (req, res) => res.json(readJSON('payments.json')));

// GET /api/payments/member/:id
app.get('/api/payments/member/:id', (req, res) => {
  res.json(readJSON('payments.json').filter(p => p.memberId === req.params.id));
});

// PUT /api/payments/:id/mark-paid
app.put('/api/payments/:id/mark-paid', (req, res) => {
  const payments = readJSON('payments.json');
  const p = payments.find(x => x.id === req.params.id);
  if (!p) return res.json({ success: false });
  p.status = 'paid';
  writeJSON('payments.json', payments);
  // Update member payment status
  const members = readJSON('members.json');
  const m = members.find(x => x.id === p.memberId);
  if (m) { m.paymentStatus = 'paid'; writeJSON('members.json', members); }
  addNotification({ type: 'success', icon: '💳', title: `Payment confirmed for ${p.memberName}`, desc: `₹${p.amount} — ${p.plan}`, memberId: p.memberId });
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════
//  NOTIFICATION ROUTES
// ════════════════════════════════════════════════════════
function addNotification(data) {
  const notifs = readJSON('notifications.json');
  notifs.unshift({ id: uuidv4(), ...data, read: false, time: new Date().toISOString() });
  if (notifs.length > 200) notifs.splice(200);
  writeJSON('notifications.json', notifs);
}

// GET /api/notifications
app.get('/api/notifications', (req, res) => res.json(readJSON('notifications.json')));

// POST /api/notifications/check-expiry  (call on admin login)
app.post('/api/notifications/check-expiry', (req, res) => {
  const PLAN_DAYS = { monthly: 30, quarterly: 90, annual: 365 };
  const members = readJSON('members.json');
  const notifs = readJSON('notifications.json');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];
  let added = 0;

  members.forEach(m => {
    const exp = new Date(m.admissionDate);
    exp.setDate(exp.getDate() + PLAN_DAYS[m.plan]);
    const daysLeft = Math.ceil((exp - today) / (1000 * 60 * 60 * 24));
    const key = `expiry_${m.id}_${todayStr}`;
    if (notifs.find(n => n.key === key)) return;

    if (daysLeft <= 0) {
      addNotification({ key, type: 'danger', icon: '🚨', title: `${m.name}'s membership EXPIRED`, desc: `Phone: ${m.phone} — Collect renewal fee`, memberId: m.id });
      added++;
    } else if (daysLeft <= 3) {
      addNotification({ key, type: 'danger', icon: '⚠️', title: `${m.name} — ${daysLeft} day(s) left!`, desc: `Phone: ${m.phone} — Expiring very soon`, memberId: m.id });
      added++;
    } else if (daysLeft <= 7) {
      addNotification({ key, type: 'warn', icon: '🔔', title: `${m.name} — ${daysLeft} days left`, desc: `Phone: ${m.phone} — Expiring soon`, memberId: m.id });
      added++;
    }
  });
  res.json({ success: true, added });
});

// PUT /api/notifications/:id/read
app.put('/api/notifications/:id/read', (req, res) => {
  const notifs = readJSON('notifications.json');
  const n = notifs.find(x => x.id === req.params.id);
  if (n) n.read = true;
  writeJSON('notifications.json', notifs);
  res.json({ success: true });
});

// DELETE /api/notifications  (clear all)
app.delete('/api/notifications', (req, res) => {
  writeJSON('notifications.json', []);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════
//  LIVE STATUS  (simple flag so website knows admin is live)
// ════════════════════════════════════════════════════════
let liveStatus = { live: false, startedAt: null };

app.get('/api/live/status', (req, res) => res.json(liveStatus));
app.post('/api/live/start',  (req, res) => { liveStatus = { live: true,  startedAt: new Date().toISOString() }; res.json({ success: true }); });
app.post('/api/live/stop',   (req, res) => { liveStatus = { live: false, startedAt: null };                     res.json({ success: true }); });

// ════════════════════════════════════════════════════════
//  SERVE FRONTEND
// ════════════════════════════════════════════════════════
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/portal', (req, res) => res.sendFile(path.join(__dirname, '../public/portal.html')));

// ════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🏋️  Brothers Gym Server running at http://localhost:${PORT}`);
  console.log(`📱  Portal:  http://localhost:${PORT}/portal`);
  console.log(`🌐  Website: http://localhost:${PORT}/`);
  if (!process.env.FAST2SMS_API_KEY || process.env.FAST2SMS_API_KEY === 'YOUR_FAST2SMS_API_KEY_HERE') {
    console.log(`\n⚠️  DEV MODE: Add FAST2SMS_API_KEY to .env for real SMS`);
    console.log(`   OTPs will be printed in this console instead.\n`);
  } else {
    console.log(`\n✅  Fast2SMS configured — Real OTPs will be sent!\n`);
  }
});