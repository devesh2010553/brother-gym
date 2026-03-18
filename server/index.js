// ════════════════════════════════════════════════════════
//  Brothers Gym Portal — Express Backend  v7.0
//  New: Custom Pricing, Admin PW Reset, Background Push
// ════════════════════════════════════════════════════════
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const { MongoClient } = require('mongodb');
const webpush = require('web-push');

const app  = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

webpush.setVapidDetails(
  "mailto:admin@brothersgym.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── PWA files ────────────────────────────────────────────
app.get('/sw.js', (req,res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '../public/sw.js'));
});
app.get('/manifest.json', (req,res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(__dirname, '../public/manifest.json'));
});

// ── Icons ─────────────────────────────────────────────────
function gymIconSVG(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
    <rect width="512" height="512" rx="80" fill="#090b0f"/>
    <rect x="40"  y="220" width="80"  height="72" rx="12" fill="#ff3c00"/>
    <rect x="392" y="220" width="80"  height="72" rx="12" fill="#ff3c00"/>
    <rect x="100" y="240" width="60"  height="32" rx="8"  fill="#ff3c00"/>
    <rect x="352" y="240" width="60"  height="32" rx="8"  fill="#ff3c00"/>
    <rect x="148" y="196" width="216" height="120" rx="16" fill="#ff3c00"/>
    <text x="256" y="285" font-family="Arial Black,sans-serif" font-weight="900"
          font-size="88" fill="white" text-anchor="middle" dominant-baseline="central">B</text>
  </svg>`;
}
app.get('/icon-192.png', (req,res) => {
  res.setHeader('Content-Type','image/svg+xml');
  res.setHeader('Cache-Control','public,max-age=86400');
  res.send(gymIconSVG(192));
});
app.get('/icon-512.png', (req,res) => {
  res.setHeader('Content-Type','image/svg+xml');
  res.setHeader('Cache-Control','public,max-age=86400');
  res.send(gymIconSVG(512));
});

// ── Static & pages ────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));
app.get('/portal', (req,res) => res.sendFile(path.join(__dirname,'../public/portal.html')));
app.get('/',       (req,res) => res.sendFile(path.join(__dirname,'../public/index.html')));

// ── Rate limiters ─────────────────────────────────────────
const otpLimiter = rateLimit({
  windowMs: 5*60*1000, max: 5,
  keyGenerator: req => {
    const p = String(req.body?.phone||'').replace(/\D/g,'').slice(-10);
    return p.length===10 ? 'otp_'+p : req.ip;
  },
  handler: (req,res) => res.json({success:false, message:'Too many OTP requests. Wait 5 minutes.'})
});
const loginLimiter = rateLimit({
  windowMs: 15*60*1000, max: 30,
  keyGenerator: req => {
    const p = String(req.body?.phone||'').replace(/\D/g,'').slice(-10);
    return p.length===10 ? 'login_'+p : req.ip;
  },
  handler: (req,res) => res.json({success:false, message:'Too many login attempts. Wait 15 minutes.'})
});

// ════════════════════════════════════════════════════════
//  MONGODB
// ════════════════════════════════════════════════════════
let db;

function requireDB(req,res,next) {
  if (!db) return res.json({success:false, message:'Database connecting... wait 10 seconds and try again.'});
  next();
}

// Plan config — custom plans store their own days/amount on member doc
const PLAN_PRICE = {monthly:800, quarterly:2100, annual:7500};
const PLAN_DAYS  = {monthly:30,  quarterly:90,   annual:365};

function sanitize(m) {
  if (!m) return null;
  const {password, _id, ...safe} = m;
  return safe;
}

// Compute expiry for any plan type (handles custom)
function computeExpiry(m) {
  if (!m.admissionDate || !m.plan) return null;
  const d = new Date(m.admissionDate);
  const days = m.plan === 'custom' ? (m.customDays || 30) : (PLAN_DAYS[m.plan] || 30);
  d.setDate(d.getDate() + days);
  return d;
}

function getDaysLeft(m) {
  const exp = computeExpiry(m);
  if (!exp) return -999;
  const now = new Date(); now.setHours(0,0,0,0);
  return Math.ceil((exp - now) / 86400000);
}

async function connectDB() {
  let uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('\n❌  MONGO_URI is not set!');
    process.exit(1);
  }
  const user = process.env.MONGO_USER;
  const pass = process.env.MONGO_PASS;
  if (user && pass) {
    uri = uri.replace('mongodb+srv://', `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
  }
  const maskedUri = uri.replace(/:([^@]{1,80})@/, ':***@');
  console.log('🔌  Connecting to MongoDB:', maskedUri);
  const client = new MongoClient(uri, {serverSelectionTimeoutMS:30000, connectTimeoutMS:30000});
  await client.connect();
  await client.db('admin').command({ping:1});
  db = client.db('brothers_gym');
  await db.collection('members').createIndex({phone:1},{unique:true});
  await db.collection('payments').createIndex({memberId:1});
  await db.collection('payments').createIndex({createdAt:-1});
  await db.collection('notifications').createIndex({time:-1});
  await db.collection('announcements').createIndex({createdAt:-1});
  await db.collection('push_subs').createIndex({phone:1});
  await db.collection('push_subs').createIndex({endpoint:1},{unique:true});
  await db.collection('push_queue').createIndex({createdAt:1},{expireAfterSeconds:86400});
  console.log('✅  MongoDB Atlas connected — brothers_gym database ready');
}

// ════════════════════════════════════════════════════════
//  OTP
// ════════════════════════════════════════════════════════
const otpStore = {};

function generateOTP() {
  return Math.floor(100000 + Math.random()*900000).toString();
}

app.post('/api/otp/send', otpLimiter, (req,res) => {
  let {phone} = req.body;
  phone = String(phone||'').replace(/\D/g,'').slice(-10);
  if (phone.length !== 10) return res.json({success:false, message:'Enter a valid 10-digit phone number.'});
  const otp = generateOTP();
  otpStore[phone] = {otp, expiresAt: Date.now()+5*60*1000, attempts:0};
  console.log('📱  OTP for', phone, '->', otp);
  res.json({success:true, screenMode:true, screenOtp:otp});
});

app.post('/api/otp/verify', (req,res) => {
  let {phone, otp} = req.body;
  phone = String(phone||'').replace(/\D/g,'').slice(-10);
  const stored = otpStore[phone];
  if (!stored) return res.json({success:false, message:'No OTP found. Please request a new one.'});
  if (Date.now() > stored.expiresAt) {
    delete otpStore[phone];
    return res.json({success:false, message:'OTP expired. Request a new one.'});
  }
  stored.attempts++;
  if (stored.attempts > 5) {
    delete otpStore[phone];
    return res.json({success:false, message:'Too many wrong attempts. Request a new OTP.'});
  }
  if (String(stored.otp) !== String(otp||'').trim())
    return res.json({success:false, message:'Wrong OTP. '+(5-stored.attempts)+' attempts left.'});
  delete otpStore[phone];
  res.json({success:true, message:'OTP verified!'});
});

// ════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════

app.post('/api/auth/admin', (req,res) => {
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  if (req.body.password !== adminPass) return res.json({success:false, message:'Wrong admin password.'});
  res.json({success:true, type:'admin'});
});

app.post('/api/auth/signup', requireDB, async (req,res) => {
  try {
    let {name, phone, password} = req.body;
    phone = String(phone||'').replace(/\D/g,'').slice(-10);
    if (!name || name.trim().length < 2) return res.json({success:false, message:'Enter your full name.'});
    if (phone.length !== 10) return res.json({success:false, message:'Enter a valid 10-digit phone number.'});
    if (!password || password.length < 6) return res.json({success:false, message:'Password must be at least 6 characters.'});

    const exists = await db.collection('members').findOne({phone});
    if (exists) return res.json({success:false, message:'This phone is already registered. Please login.'});

    const member = {
      id: 'M'+Date.now().toString().slice(-6),
      name: name.trim(), phone, password,
      plan: null, admissionDate: null,
      paymentStatus: 'pending',
      memberStatus: 'no-plan',
      gender: '', emergency: '', notes: 'Self-signup via app',
      createdAt: new Date()
    };
    await db.collection('members').insertOne(member);

    await addNotification({
      type:'info', icon:'🆕',
      title: name.trim() + ' just signed up!',
      desc: 'Phone: '+phone+' — Go to Pending tab to confirm payment & activate.',
      adminOnly: true
    });

    res.json({success:true, member: sanitize(member)});
  } catch(e) {
    if (e.code===11000) return res.json({success:false, message:'Phone already registered. Please login.'});
    console.error('Signup error:', e.message);
    res.json({success:false, message:'Server error. Try again.'});
  }
});

app.post('/api/auth/login', loginLimiter, requireDB, async (req,res) => {
  try {
    let {phone, password} = req.body;
    phone = String(phone||'').replace(/\D/g,'').slice(-10);
    if (phone.length !== 10) return res.json({success:false, message:'Enter a valid phone number.'});
    const member = await db.collection('members').findOne({phone});
    if (!member) return res.json({success:false, message:'Phone not registered. Please sign up first.'});
    if (member.password !== password) return res.json({success:false, message:'Wrong password. Try again.'});

    await addNotification({
      type:'info', icon:'👤',
      title: member.name + ' logged in',
      desc: 'Phone: '+phone+' · Plan: '+(member.plan||'none')+' · Status: '+(member.memberStatus||member.paymentStatus),
      adminOnly: true
    });

    res.json({success:true, member: sanitize(member)});
  } catch(e) {
    console.error('Login error:', e.message);
    res.json({success:false, message:'Server error. Try again.'});
  }
});

// ── Member requests password reset (no OTP) ──
app.post('/api/auth/request-password-reset', requireDB, async (req,res) => {
  try {
    let {phone, name} = req.body;
    phone = String(phone||'').replace(/\D/g,'').slice(-10);
    if (phone.length !== 10) return res.json({success:false, message:'Enter a valid phone number.'});
    const member = await db.collection('members').findOne({phone});
    if (!member) return res.json({success:false, message:'No account found with this phone number.'});
    const displayName = name || member.name || phone;
    await addNotification({
      type:'warn', icon:'🔑',
      title: `Password reset request`,
      desc: `${displayName} (${phone}) forgot their password. Open Members tab → 🔑 button to set a new password for them.`,
      adminOnly: true
    });
    // Also queue push to admin
    await queuePush({
      type:'reset',
      title:'🔑 Password Reset Request',
      body:`${displayName} (${phone}) needs password reset. Open the portal.`,
      url:'/portal'
    });
    res.json({success:true, message:'Reset request sent to admin! They will contact you shortly.'});
  } catch(e) {
    res.json({success:false, message:'Server error.'});
  }
});

// ── Admin resets a member password directly ──
app.post('/api/auth/admin-reset-password', requireDB, async (req,res) => {
  try {
    const {phone, newPassword, adminPassword} = req.body;
    if (adminPassword !== (process.env.ADMIN_PASSWORD||'admin123'))
      return res.json({success:false, message:'Unauthorized.'});
    if (!newPassword || newPassword.length < 4)
      return res.json({success:false, message:'Password must be at least 4 characters.'});
    const ph = String(phone||'').replace(/\D/g,'').slice(-10);
    const r = await db.collection('members').updateOne({phone:ph}, {$set:{password:newPassword}});
    if (r.matchedCount === 0) return res.json({success:false, message:'Member not found.'});
    const m = await db.collection('members').findOne({phone:ph});
    // Notify member
    if (m) {
      await addNotification({
        type:'info', icon:'🔑',
        title: 'Password reset by admin',
        desc: 'Your login password has been reset. Use your new password to login, then change it in Settings.',
        memberId: m.id, adminOnly: false
      });
      await queuePush({
        type:'reset',
        title:'🔑 Password Reset',
        body:'Your gym portal password was reset by admin. Login with your new password.',
        url:'/portal'
      }, m.phone);
    }
    res.json({success:true, message:'Password reset successfully.'});
  } catch(e) {
    res.json({success:false, message:'Server error.'});
  }
});

app.post('/api/auth/reset-password', requireDB, async (req,res) => {
  try {
    let {phone, newPassword, password} = req.body;
    const pw = newPassword || password;
    phone = String(phone||'').replace(/\D/g,'').slice(-10);
    if (!pw || pw.length < 6) return res.json({success:false, message:'Password must be at least 6 characters.'});
    const r = await db.collection('members').updateOne({phone}, {$set:{password:pw}});
    if (r.matchedCount === 0) return res.json({success:false, message:'No account found with this phone number.'});
    res.json({success:true, message:'Password reset successfully! Please login.'});
  } catch(e) {
    res.json({success:false, message:'Server error.'});
  }
});

app.post('/api/auth/change-password', requireDB, async (req,res) => {
  try {
    let {phone, oldPassword, newPassword} = req.body;
    phone = String(phone||'').replace(/\D/g,'').slice(-10);
    const member = await db.collection('members').findOne({phone});
    if (!member) return res.json({success:false, message:'Account not found.'});
    if (member.password !== oldPassword) return res.json({success:false, message:'Current password is incorrect.'});
    if (!newPassword || newPassword.length < 6) return res.json({success:false, message:'New password must be at least 6 characters.'});
    await db.collection('members').updateOne({phone}, {$set:{password:newPassword}});
    res.json({success:true, message:'Password changed successfully!'});
  } catch(e) {
    res.json({success:false, message:'Server error.'});
  }
});

// ════════════════════════════════════════════════════════
//  MEMBERS
// ════════════════════════════════════════════════════════

app.get('/api/members', requireDB, async (req,res) => {
  try {
    const members = await db.collection('members').find({}).sort({createdAt:-1}).toArray();
    res.json(members.map(sanitize));
  } catch(e) { res.json([]); }
});

app.post('/api/members', requireDB, async (req,res) => {
  try {
    const {name,phone,plan,admissionDate,gender,emergency,notes,paymentStatus,password,customDays,customAmount} = req.body;
    const cp = String(phone||'').replace(/\D/g,'').slice(-10);
    if (!name||!cp||!plan||!admissionDate)
      return res.json({success:false, message:'Name, phone, plan and date are required.'});

    const assignedPass = (password && password.length >= 6) ? password : 'gym123';
    const exists = await db.collection('members').findOne({phone:cp});

    // Determine plan amount
    const planAmount = plan === 'custom'
      ? (customAmount || 0)
      : (PLAN_PRICE[plan] || 0);

    if (exists) {
      const upd = {
        plan, admissionDate,
        paymentStatus: paymentStatus||'pending',
        memberStatus: paymentStatus==='paid'?'active':'pending-payment'
      };
      if (plan === 'custom') { upd.customDays = customDays||30; upd.customAmount = customAmount||0; }
      if (gender) upd.gender = gender;
      if (notes)  upd.notes  = notes;
      if (password && password.length >= 6) upd.password = password;
      await db.collection('members').updateOne({phone:cp}, {$set:upd});
      if (paymentStatus==='paid') {
        await addPayment({memberId:exists.id, memberName:exists.name, phone:cp, plan, amount:planAmount, date:admissionDate, status:'paid'});
      }
      const updated = await db.collection('members').findOne({phone:cp});
      return res.json({success:true, message:exists.name+"'s membership updated.", member:sanitize(updated)});
    }

    const id = 'M'+Date.now().toString().slice(-6);
    const nm = {
      id, name, phone:cp, password:assignedPass, plan, admissionDate,
      gender:gender||'', emergency:emergency||'', notes:notes||'',
      paymentStatus:paymentStatus||'pending',
      memberStatus: paymentStatus==='paid'?'active':'pending-payment',
      createdAt: new Date()
    };
    if (plan === 'custom') { nm.customDays = customDays||30; nm.customAmount = customAmount||0; }
    await db.collection('members').insertOne(nm);
    if (paymentStatus==='paid') {
      await addPayment({memberId:id, memberName:name, phone:cp, plan, amount:planAmount, date:admissionDate, status:'paid'});
    }
    res.json({success:true, message:name+' added! Login password: '+assignedPass, member:sanitize(nm)});
  } catch(e) {
    if (e.code===11000) return res.json({success:false, message:'Phone number already exists.'});
    res.json({success:false, message:'Server error: '+e.message});
  }
});

app.put('/api/members/:id', requireDB, async (req,res) => {
  try {
    const {_id, password, ...upd} = req.body;
    if (upd.paymentStatus) upd.memberStatus = upd.paymentStatus==='paid'?'active':'pending-payment';
    await db.collection('members').updateOne({id:req.params.id}, {$set:upd});
    const updated = await db.collection('members').findOne({id:req.params.id});
    res.json({success:true, member:sanitize(updated)});
  } catch(e) { res.json({success:false, message:'Update failed.'}); }
});

app.delete('/api/members/:id', requireDB, async (req,res) => {
  try {
    await db.collection('members').deleteOne({id:req.params.id});
    await db.collection('payments').deleteMany({memberId:req.params.id});
    await db.collection('notifications').deleteMany({memberId:req.params.id});
    res.json({success:true});
  } catch(e) { res.json({success:false, message:'Delete failed.'}); }
});

app.post('/api/members/:id/renew', requireDB, async (req,res) => {
  try {
    const {plan, date, paymentStatus, customDays, customAmount, adminPassword} = req.body;
    // paymentDate is also accepted
    const payDate = req.body.paymentDate || date;
    const m = await db.collection('members').findOne({id:req.params.id});
    if (!m) return res.json({success:false, message:'Member not found.'});

    // Determine amount
    const amount = plan === 'custom'
      ? (customAmount || 0)
      : (PLAN_PRICE[plan] || 0);

    const upd = {
      plan, admissionDate:payDate,
      paymentStatus: paymentStatus||'paid',
      memberStatus:'active'
    };
    if (plan === 'custom') {
      upd.customDays   = customDays   || 30;
      upd.customAmount = customAmount || 0;
    } else {
      // Clear custom fields when switching back to standard
      upd.customDays   = null;
      upd.customAmount = null;
    }

    await db.collection('members').updateOne({id:req.params.id}, {$set:upd});
    await addPayment({
      memberId:m.id, memberName:m.name, phone:m.phone,
      plan, amount, date:payDate, status:paymentStatus||'paid'
    });
    await addNotification({
      type:'success', icon:'✅',
      title:m.name+' membership renewed',
      desc:'Plan: '+(plan==='custom'?`Custom ${customDays}d ₹${amount}`:plan)+' from '+payDate,
      memberId:m.id
    });
    await queuePush({
      type:'renewal',
      title:'✅ Membership Renewed!',
      body:'Your '+(plan==='custom'?`Custom (${customDays} days)`:plan)+' membership is now active. Keep training! 💪',
      url:'/portal'
    }, m.phone);

    const updated = await db.collection('members').findOne({id:req.params.id});
    res.json({success:true, member:sanitize(updated)});
  } catch(e) { res.json({success:false, message:'Renewal failed: '+e.message}); }
});

app.post('/api/members/:id/confirm-payment', requireDB, async (req,res) => {
  try {
    const {plan, paymentDate, adminPassword} = req.body;
    if (adminPassword !== (process.env.ADMIN_PASSWORD||'admin123'))
      return res.json({success:false, message:'Unauthorized.'});
    const usePlan = plan || 'monthly';
    const today = paymentDate || new Date().toISOString().split('T')[0];
    await db.collection('members').updateOne({id:req.params.id}, {
      $set:{plan:usePlan, admissionDate:today, paymentStatus:'paid', memberStatus:'active'}
    });
    const m = await db.collection('members').findOne({id:req.params.id});
    if (!m) return res.json({success:false, message:'Member not found.'});
    await addPayment({
      memberId:m.id, memberName:m.name, phone:m.phone,
      plan:usePlan, amount:PLAN_PRICE[usePlan]||0, date:today, status:'paid'
    });
    await addNotification({
      type:'success', icon:'✅',
      title:m.name+' membership activated!',
      desc:'Plan: '+usePlan+' · Confirmed by admin', memberId:m.id
    });
    await queuePush({
      type:'renewal',
      title:'🎉 Membership Activated!',
      body:'Welcome to Brothers Gym! Your '+usePlan+' membership is now active. 💪',
      url:'/portal'
    }, m.phone);
    res.json({success:true, member:sanitize(m)});
  } catch(e) { res.json({success:false, message:'Server error.'}); }
});

// ════════════════════════════════════════════════════════
//  PAYMENTS
// ════════════════════════════════════════════════════════
async function addPayment(data) {
  // Prevent duplicate payment entries for same member+plan+date
  const existing = await db.collection('payments').findOne({
    memberId: data.memberId,
    date: data.date,
    plan: data.plan,
    status: 'paid'
  });
  if (existing) return; // already recorded
  await db.collection('payments').insertOne({
    id: 'P'+uuidv4().substr(0,6).toUpperCase(),
    ...data, createdAt: new Date()
  });
}

app.get('/api/payments', requireDB, async (req,res) => {
  try {
    const p = await db.collection('payments').find({}).sort({createdAt:-1}).toArray();
    res.json(p.map(({_id,...x})=>x));
  } catch(e) { res.json([]); }
});

app.get('/api/payments/member/:id', requireDB, async (req,res) => {
  try {
    const p = await db.collection('payments').find({memberId:req.params.id}).sort({createdAt:-1}).toArray();
    res.json(p.map(({_id,...x})=>x));
  } catch(e) { res.json([]); }
});

app.put('/api/payments/:id/mark-paid', requireDB, async (req,res) => {
  try {
    await db.collection('payments').updateOne({id:req.params.id}, {$set:{status:'paid'}});
    const p = await db.collection('payments').findOne({id:req.params.id});
    if (p) {
      await db.collection('members').updateOne({id:p.memberId}, {$set:{paymentStatus:'paid', memberStatus:'active'}});
      await addNotification({
        type:'success', icon:'💳',
        title:'Payment confirmed for '+p.memberName,
        desc:'₹'+p.amount+' — '+p.plan, memberId:p.memberId
      });
      await queuePush({
        type:'renewal',
        title:'💳 Payment Confirmed!',
        body:'Your payment of ₹'+p.amount+' has been confirmed. Membership active! 💪',
        url:'/portal'
      }, p.phone);
    }
    res.json({success:true});
  } catch(e) { res.json({success:false}); }
});

// ════════════════════════════════════════════════════════
//  NOTIFICATIONS
// ════════════════════════════════════════════════════════
async function addNotification(data) {
  try {
    const count = await db.collection('notifications').countDocuments();
    if (count >= 200) {
      const oldest = await db.collection('notifications').find({}).sort({time:1}).limit(count-199).toArray();
      if (oldest.length) await db.collection('notifications').deleteMany({_id:{$in:oldest.map(n=>n._id)}});
    }
    await db.collection('notifications').insertOne({
      id: uuidv4(), ...data, read:false, time: new Date()
    });
  } catch(e) { console.error('addNotification error:', e.message); }
}

app.get('/api/notifications', requireDB, async (req,res) => {
  try {
    const {adminOnly, memberId} = req.query;
    const query = {};
    if (adminOnly==='true') query.adminOnly = true;
    if (memberId) query.$or = [{memberId}, {memberId:null, adminOnly:{$ne:true}}];
    const n = await db.collection('notifications').find(query).sort({time:-1}).limit(50).toArray();
    res.json(n.map(({_id,...x})=>x));
  } catch(e) { res.json([]); }
});

app.post('/api/notifications', requireDB, async (req,res) => {
  try {
    const {type,icon,title,desc,memberId,adminOnly} = req.body;
    await addNotification({type:type||'info', icon:icon||'🔔', title, desc, memberId:memberId||null, adminOnly:!!adminOnly});
    res.json({success:true});
  } catch(e) { res.json({success:false}); }
});

app.put('/api/notifications/:id/read', requireDB, async (req,res) => {
  try {
    await db.collection('notifications').updateOne({id:req.params.id}, {$set:{read:true}});
    res.json({success:true});
  } catch(e) { res.json({success:false}); }
});

app.delete('/api/notifications', requireDB, async (req,res) => {
  try {
    await db.collection('notifications').deleteMany({});
    res.json({success:true});
  } catch(e) { res.json({success:false}); }
});

// Daily expiry check — deduped per day, notifies member + admin + queues push
app.post('/api/notifications/check-expiry', requireDB, async (req,res) => {
  try {
    const members = await db.collection('members').find({
      plan:{$ne:null},
      memberStatus:'active'
    }).toArray();
    const today = new Date(); today.setHours(0,0,0,0);
    const todayStr = today.toISOString().split('T')[0];
    let added = 0;
    for (const m of members) {
      if (!m.admissionDate || !m.plan) continue;
      const daysLeft = getDaysLeft(m);
      const key = 'expiry_'+m.id+'_'+todayStr;
      const exists = await db.collection('notifications').findOne({key});
      if (exists) continue;
      if (daysLeft <= 0) {
        await addNotification({key, type:'danger', icon:'🚨', title:m.name+"'s membership EXPIRED", desc:'Phone: '+m.phone+' — Collect renewal fee', memberId:m.id, adminOnly:true});
        await addNotification({key:key+'_m', type:'danger', icon:'🚨', title:'Your membership has EXPIRED', desc:'Please contact gym to renew your membership.', memberId:m.id, adminOnly:false});
        await queuePush({type:'expiry', title:'❌ Membership Expired', body:'Hi '+m.name+'! Your membership has expired. Contact gym to renew. 💪', url:'/portal'}, m.phone);
        added++;
      } else if (daysLeft === 2) {
        await addNotification({key, type:'danger', icon:'⚠️', title:m.name+' — 2 days left!', desc:'Phone: '+m.phone+' — Expiring in 2 days', memberId:m.id, adminOnly:true});
        await addNotification({key:key+'_m', type:'danger', icon:'⚠️', title:'Membership expiring in 2 days!', desc:'Contact gym immediately or renew online.', memberId:m.id, adminOnly:false});
        await queuePush({type:'expiry', title:'⚠️ 2 Days Left!', body:'Hi '+m.name+'! Renew now to keep training. 💪', url:'/portal'}, m.phone);
        added++;
      } else if (daysLeft === 1) {
        await addNotification({key, type:'danger', icon:'🚨', title:m.name+' — LAST DAY!', desc:'Phone: '+m.phone+' — Expires tomorrow', memberId:m.id, adminOnly:true});
        await addNotification({key:key+'_m', type:'danger', icon:'🚨', title:'Last day of membership!', desc:'Your membership expires tomorrow. Renew now!', memberId:m.id, adminOnly:false});
        await queuePush({type:'expiry', title:'🚨 Last Day!', body:'Hi '+m.name+'! Your membership expires today. Renew now! 💪', url:'/portal'}, m.phone);
        added++;
      } else if (daysLeft <= 7) {
        await addNotification({key, type:'warn', icon:'🔔', title:m.name+' — '+daysLeft+' days left', desc:'Phone: '+m.phone+' — Expiring soon', memberId:m.id, adminOnly:true});
        await queuePush({type:'expiry', title:'🔔 '+daysLeft+' days left', body:'Hi '+m.name+'! Your membership expires soon. Plan your renewal. 💪', url:'/portal'}, m.phone);
        added++;
      }
    }
    res.json({success:true, added});
  } catch(e) {
    console.error('check-expiry error:', e.message);
    res.json({success:false, added:0});
  }
});

// ════════════════════════════════════════════════════════
//  LIVE STREAM
// ════════════════════════════════════════════════════════
let liveStatus = {live:false, url:'', startedAt:null, title:'Gym Live Session'};

app.get('/api/live/status', (req,res) => res.json(liveStatus));

app.post('/api/live/start', async (req,res) => {
  const {url, title} = req.body;
  liveStatus = {live:true, url:url||'', title:title||'Gym Live Session', startedAt:new Date().toISOString()};
  console.log('🔴  Live started:', url);
  await queuePush({type:'live', title:'🔴 Gym is LIVE!', body:(title||'Gym Live')+' — Watch now! 💪', url:'/portal'});
  res.json({success:true, liveStatus});
});

app.post('/api/live/stop', (req,res) => {
  liveStatus = {live:false, url:'', startedAt:null, title:''};
  console.log('⏹   Live stopped');
  res.json({success:true});
});

// ════════════════════════════════════════════════════════
//  ANNOUNCEMENTS
// ════════════════════════════════════════════════════════
app.get('/api/announcements', requireDB, async (req,res) => {
  try {
    const list = await db.collection('announcements').find({}).sort({createdAt:-1}).limit(20).toArray();
    res.json(list.map(({_id,...x})=>x));
  } catch(e) { res.json([]); }
});

app.post('/api/announcements', requireDB, async (req,res) => {
  try {
    const {title, body, adminPassword} = req.body;
    if (adminPassword !== (process.env.ADMIN_PASSWORD||'admin123'))
      return res.json({success:false, message:'Unauthorized.'});
    if (!title||!body) return res.json({success:false, message:'Title and body required.'});
    const ann = {id:uuidv4(), title, body, createdAt:new Date()};
    await db.collection('announcements').insertOne(ann);
    await queuePush({type:'announcement', title:'📢 '+title, body, url:'/portal'});
    res.json({success:true, announcement:ann});
  } catch(e) { res.json({success:false, message:'Server error.'}); }
});

app.delete('/api/announcements/:id', requireDB, async (req,res) => {
  try {
    const {adminPassword} = req.body;
    if (adminPassword !== (process.env.ADMIN_PASSWORD||'admin123'))
      return res.json({success:false, message:'Unauthorized.'});
    await db.collection('announcements').deleteOne({id:req.params.id});
    res.json({success:true});
  } catch(e) { res.json({success:false}); }
});

// ════════════════════════════════════════════════════════
//  PUSH NOTIFICATIONS (Web Push + polling fallback)
// ════════════════════════════════════════════════════════
async function queuePush(payload, targetPhone=null) {
  if (!db) return;

  try {
    // Normalize phone to last 10 digits (matches how poll query works)
    const normPhone = targetPhone
      ? String(targetPhone).replace(/\D/g,'').slice(-10) || null
      : null;

    // Generate a stable ID for dedup in SW seen-IDs cache
    const { ObjectId } = require('mongodb');
    const docId = new ObjectId();

    // Save notification in queue (backup system — SW bgPoll reads this)
    await db.collection('push_queue').insertOne({
      _id: docId,
      ...payload,
      targetPhone: normPhone,
      createdAt: new Date(),
      delivered: false
    });

    const pushPayload = JSON.stringify({
      _id: docId.toString(),   // include ID so SW can dedup
      title: payload.title || "Brothers Gym 💪",
      body: payload.body || "",
      type: payload.type || "info",
      url: payload.url || "/portal"
    });

    // Send live Web Push to all subscribed devices for this phone (or all if broadcast)
    const subs = normPhone
      ? await db.collection('push_subs').find({ phone: normPhone }).toArray()
      : await db.collection('push_subs').find({}).toArray();

    for (const s of subs) {
      try {
        if (s.subscription) {
          await webpush.sendNotification(s.subscription, pushPayload);
        }
      } catch (err) {
        console.log('Push send error:', err.statusCode, err.message);
        // Remove expired/invalid subscriptions so we don't keep trying
        if (err.statusCode === 410 || err.statusCode === 404) {
          await db.collection('push_subs').deleteOne({ _id: s._id });
        }
      }
    }

  } catch (e) {
    console.log('Queue push error:', e.message);
  }
}

app.post('/api/push/subscribe', requireDB, async (req,res) => {
  let {phone, subscription} = req.body;
  phone = String(phone||'').replace(/\D/g,'').slice(-10);

  if (!phone || !subscription || !subscription.endpoint)
    return res.json({success:false, message:'Missing phone or subscription endpoint.'});

  // Use endpoint as unique key so multiple devices per phone are all stored
  await db.collection('push_subs').updateOne(
    {endpoint: subscription.endpoint},
    {$set:{phone, subscription, endpoint: subscription.endpoint, updatedAt:new Date()}},
    {upsert:true}
  );

  res.json({success:true});
});

app.post('/api/push/unsubscribe', requireDB, async (req,res) => {
  let {phone} = req.body;
  phone = String(phone||'').replace(/\D/g,'').slice(-10);
  if (phone) await db.collection('push_subs').deleteMany({phone});
  res.json({success:true});
});

// Poll endpoint — returns undelivered messages for a specific phone
app.get('/api/push/poll', requireDB, async (req,res) => {
  let {phone} = req.query;
  phone = String(phone||'').replace(/\D/g,'').slice(-10);
  if (!phone) return res.json([]);
  try {
    const msgs = await db.collection('push_queue').find({
      $or: [{targetPhone:phone}, {targetPhone:null}],
      delivered: false,
      createdAt: {$gte: new Date(Date.now()-24*60*60*1000)}
    }).sort({createdAt:-1}).limit(10).toArray();
    res.json(msgs.map(({_id,...x})=>({...x, _id:String(_id)})));
  } catch(e) { res.json([]); }
});

app.post('/api/push/mark-delivered', requireDB, async (req,res) => {
  const {ids} = req.body;
  if (!ids||!ids.length) return res.json({success:true});
  try {
    const {ObjectId} = require('mongodb');
    await db.collection('push_queue').updateMany(
      {_id:{$in:ids.map(id=>{try{return new ObjectId(id)}catch(e){return id}})}},
      {$set:{delivered:true}}
    );
  } catch(e) {}
  res.json({success:true});
});

// ── Utility ────────────────────────────────────────────────
app.get('/api/status', (req,res) => res.json({dbConnected:!!db, server:'ok', time:new Date().toISOString()}));
app.get('/ping',       (req,res) => res.json({status:'ok', time:new Date().toISOString(), gym:'Brothers Gym Mathura 💪'}));
app.get('/health',     (req,res) => res.json({status:'healthy'}));

// ════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🏋️   Brothers Gym HTTP server started on port ' + PORT);
  console.log('\n🔍  Environment check:');
  console.log('    MONGO_URI  :', process.env.MONGO_URI  ? '✅ set' : '❌ NOT SET');
  console.log('    MONGO_USER :', process.env.MONGO_USER || '❌ NOT SET');
  console.log('    MONGO_PASS :', process.env.MONGO_PASS ? '✅ set' : '❌ NOT SET');
  console.log('    ADMIN_PASS :', process.env.ADMIN_PASSWORD ? '✅ set' : '⚠️  using default admin123');
  connectDB()
    .then(() => console.log('\n🎉  All systems go!\n'))
    .catch(err => {
      console.error('\n❌  MongoDB failed:', err.message);
    });
});