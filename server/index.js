// ════════════════════════════════════════════════════════
//  Brothers Gym Portal — Express Backend  v6.0
//  MongoDB Atlas | Screen OTP | PWA Push | Announcements
// ════════════════════════════════════════════════════════
require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

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

const PLAN_PRICE = {monthly:800, quarterly:2100, annual:7500};
const PLAN_DAYS  = {monthly:30,  quarterly:90,   annual:365};

function sanitize(m) {
  if (!m) return null;
  const {password, _id, ...safe} = m;
  return safe;
}

async function connectDB() {
  let uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('\n❌  MONGO_URI is not set! Add it in Render → Environment.');
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
  await db.collection('push_queue').createIndex({createdAt:1},{expireAfterSeconds:86400});
  console.log('✅  MongoDB Atlas connected — brothers_gym database ready');
}

// ════════════════════════════════════════════════════════
//  OTP — always shown on screen (free, no third-party)
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

    // Notify admin
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

    // Notify admin of login
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
// Member requests password reset (sends admin notification)
app.post('/api/auth/request-password-reset', requireDB, async (req,res) => {
  const {phone, name} = req.body;
  await addNotification({type:'warn',icon:'🔑',title:`Password reset request`,
    desc:`${name||phone} (${phone}) forgot password. Go to Members → 🔑 to reset.`,adminOnly:true});
  res.json({success:true});
});

// Admin resets a member's password directly
app.post('/api/auth/admin-reset-password', requireDB, async (req,res) => {
  const {phone, newPassword, adminPassword} = req.body;
  if (adminPassword !== (process.env.ADMIN_PASSWORD||'admin123')) return res.json({success:false,message:'Unauthorized'});
  const r = await db.collection('members').updateOne({phone},{$set:{password:newPassword}});
  if (r.matchedCount===0) return res.json({success:false,message:'Member not found'});
  res.json({success:true});
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
    const {name,phone,plan,admissionDate,gender,emergency,notes,paymentStatus,password} = req.body;
    const cp = String(phone||'').replace(/\D/g,'').slice(-10);
    if (!name||!cp||!plan||!admissionDate)
      return res.json({success:false, message:'Name, phone, plan and date are required.'});

    const assignedPass = (password && password.length >= 6) ? password : 'gym123';
    const exists = await db.collection('members').findOne({phone:cp});

    if (exists) {
      // Update existing member
      const upd = {plan, admissionDate, paymentStatus: paymentStatus||'pending',
                   memberStatus: paymentStatus==='paid'?'active':'pending-payment'};
      if (gender)    upd.gender    = gender;
      if (emergency) upd.emergency = emergency;
      if (notes)     upd.notes     = notes;
      if (password && password.length >= 6) upd.password = password;
      await db.collection('members').updateOne({phone:cp}, {$set:upd});
      if (paymentStatus==='paid') {
        await addPayment({memberId:exists.id, memberName:exists.name, phone:cp, plan, amount:PLAN_PRICE[plan]||0, date:admissionDate, status:'paid'});
      }
      const updated = await db.collection('members').findOne({phone:cp});
      return res.json({success:true, message:exists.name+"'s membership updated.", member:sanitize(updated)});
    }

    // New member
    const id = 'M'+Date.now().toString().slice(-6);
    const nm = {
      id, name, phone:cp, password:assignedPass, plan, admissionDate,
      gender:gender||'', emergency:emergency||'', notes:notes||'',
      paymentStatus:paymentStatus||'pending',
      memberStatus: paymentStatus==='paid'?'active':'pending-payment',
      createdAt: new Date()
    };
    await db.collection('members').insertOne(nm);
    if (paymentStatus==='paid') {
      await addPayment({memberId:id, memberName:name, phone:cp, plan, amount:PLAN_PRICE[plan]||0, date:admissionDate, status:'paid'});
    }
    res.json({success:true, message:name+' added! Login password: '+assignedPass, member:sanitize(nm)});
  } catch(e) {
    if (e.code===11000) return res.json({success:false, message:'Phone number already exists.'});
    console.error('Add member error:', e.message);
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
    // Delete member + all their data from MongoDB
    await db.collection('members').deleteOne({id:req.params.id});
    await db.collection('payments').deleteMany({memberId:req.params.id});
    await db.collection('notifications').deleteMany({memberId:req.params.id});
    res.json({success:true});
  } catch(e) { res.json({success:false, message:'Delete failed.'}); }
});

app.post('/api/members/:id/renew', requireDB, async (req,res) => {
  try {
    const {plan, date, paymentStatus} = req.body;
    const m = await db.collection('members').findOne({id:req.params.id});
    if (!m) return res.json({success:false, message:'Member not found.'});
    await db.collection('members').updateOne({id:req.params.id}, {
      $set:{plan, admissionDate:date, paymentStatus, memberStatus:'active'}
    });
    await addPayment({memberId:m.id, memberName:m.name, phone:m.phone, plan, amount:PLAN_PRICE[plan]||0, date, status:paymentStatus});
    await addNotification({type:'success', icon:'✅', title:m.name+' membership renewed', desc:'Plan: '+plan+' from '+date, memberId:m.id});
    await queuePush({type:'renewal', title:'✅ Membership Renewed!', body:'Your '+plan+' membership is now active. Keep training! 💪', url:'/portal'}, m.phone);
    const updated = await db.collection('members').findOne({id:req.params.id});
    res.json({success:true, member:sanitize(updated)});
  } catch(e) { res.json({success:false, message:'Renewal failed.'}); }
});

// Admin confirms payment for self-signup members
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
    await addPayment({memberId:m.id, memberName:m.name, phone:m.phone, plan:usePlan, amount:PLAN_PRICE[usePlan]||0, date:today, status:'paid'});
    await addNotification({type:'success', icon:'✅', title:m.name+' membership activated!', desc:'Plan: '+usePlan+' · Confirmed by admin', memberId:m.id});
    await queuePush({type:'renewal', title:'🎉 Membership Activated!', body:'Welcome to Brothers Gym! Your '+usePlan+' membership is now active. 💪', url:'/portal'}, m.phone);
    res.json({success:true, member:sanitize(m)});
  } catch(e) { res.json({success:false, message:'Server error.'}); }
});

// ════════════════════════════════════════════════════════
//  PAYMENTS
// ════════════════════════════════════════════════════════
async function addPayment(data) {
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
      await addNotification({type:'success', icon:'💳', title:'Payment confirmed for '+p.memberName, desc:'₹'+p.amount+' — '+p.plan, memberId:p.memberId});
      await queuePush({type:'renewal', title:'💳 Payment Confirmed!', body:'Your payment of ₹'+p.amount+' has been confirmed. Membership active! 💪', url:'/portal'}, p.phone);
    }
    res.json({success:true});
  } catch(e) { res.json({success:false}); }
});

// ════════════════════════════════════════════════════════
//  NOTIFICATIONS
// ════════════════════════════════════════════════════════
async function addNotification(data) {
  try {
    // Keep max 200 notifications
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

// Check expiry — called daily, creates notifications for admin AND members
app.post('/api/notifications/check-expiry', requireDB, async (req,res) => {
  try {
    const members = await db.collection('members').find({plan:{$ne:null}, memberStatus:'active'}).toArray();
    const today = new Date(); today.setHours(0,0,0,0);
    const todayStr = today.toISOString().split('T')[0];
    let added = 0;
    for (const m of members) {
      if (!m.admissionDate || !m.plan) continue;
      const exp = new Date(m.admissionDate);
      exp.setDate(exp.getDate() + (PLAN_DAYS[m.plan]||30));
      const daysLeft = Math.ceil((exp - today) / 86400000);
      const key = 'expiry_'+m.id+'_'+todayStr;
      const exists = await db.collection('notifications').findOne({key});
      if (exists) continue;
      if (daysLeft <= 0) {
        await addNotification({key, type:'danger', icon:'🚨', title:m.name+"'s membership EXPIRED", desc:'Phone: '+m.phone+' — Collect renewal fee', memberId:m.id, adminOnly:true});
        await addNotification({key:key+'_m', type:'danger', icon:'🚨', title:'Your membership has EXPIRED', desc:'Please contact gym to renew your membership.', memberId:m.id, adminOnly:false});
        await queuePush({type:'expiry', title:'❌ Membership Expired', body:'Hi '+m.name+'! Your membership has expired. Contact gym to renew. 💪', url:'/portal'}, m.phone);
        added++;
      } else if (daysLeft <= 3) {
        await addNotification({key, type:'danger', icon:'⚠️', title:m.name+' — '+daysLeft+' day(s) left!', desc:'Phone: '+m.phone+' — Expiring very soon', memberId:m.id, adminOnly:true});
        await addNotification({key:key+'_m', type:'danger', icon:'⚠️', title:'Membership expiring in '+daysLeft+' day(s)!', desc:'Contact gym immediately to avoid interruption.', memberId:m.id, adminOnly:false});
        await queuePush({type:'expiry', title:'⚠️ Expiring in '+daysLeft+' day(s)!', body:'Hi '+m.name+'! Renew now to keep training. 💪', url:'/portal'}, m.phone);
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
  // Push to all subscribed members
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
    // Push notification to all members
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
//  PUSH NOTIFICATIONS (polling-based — no paid service)
// ════════════════════════════════════════════════════════

// Queue a push message for delivery
async function queuePush(payload, targetPhone=null) {
  if (!db) return;
  try {
    await db.collection('push_queue').insertOne({
      ...payload, targetPhone, createdAt:new Date(), delivered:false
    });
  } catch(e) {}
}

app.post('/api/push/subscribe', requireDB, async (req,res) => {
  const {phone} = req.body;
  if (!phone) return res.json({success:false});
  await db.collection('push_subs').updateOne({phone},{$set:{phone,updatedAt:new Date()}},{upsert:true});
  res.json({success:true});
});

app.post('/api/push/unsubscribe', requireDB, async (req,res) => {
  const {phone} = req.body;
  if (phone) await db.collection('push_subs').deleteOne({phone});
  res.json({success:true});
});

// Members poll this every 30s to get pending notifications
app.get('/api/push/poll', requireDB, async (req,res) => {
  const {phone} = req.query;
  if (!phone) return res.json([]);
  try {
    const msgs = await db.collection('push_queue').find({
      $or: [{targetPhone:phone}, {targetPhone:null}],
      delivered: false,
      createdAt: {$gte: new Date(Date.now()-24*60*60*1000)}
    }).sort({createdAt:-1}).limit(10).toArray();
    res.json(msgs.map(({_id,...x})=>({...x, _id:x._id||String(Math.random())})));
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
app.get('/api/sms-test', (req,res) => res.json({message:'OTP is shown on screen — no SMS service needed!', mode:'screen-otp'}));

// ════════════════════════════════════════════════════════
//  START — HTTP first, then DB
// ════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🏋️   Brothers Gym HTTP server started on port ' + PORT);
  console.log('\n🔍  Environment check:');
  console.log('    MONGO_URI  :', process.env.MONGO_URI  ? '✅ "'+process.env.MONGO_URI.substring(0,40)+'..."' : '❌ NOT SET');
  console.log('    MONGO_USER :', process.env.MONGO_USER || '❌ NOT SET');
  console.log('    MONGO_PASS :', process.env.MONGO_PASS ? '✅ set (length '+process.env.MONGO_PASS.length+')' : '❌ NOT SET');
  console.log('    ADMIN_PASS :', process.env.ADMIN_PASSWORD ? '✅ set' : '⚠️  using default admin123');
  console.log('    FAST2SMS   :', process.env.FAST2SMS_API_KEY ? '✅ set' : '⚠️  screen OTP mode');

  connectDB()
    .then(() => console.log('\n🎉  All systems go! Server + Database both running.\n'))
    .catch(err => {
      console.error('\n❌  MongoDB failed to connect!');
      console.error('    Name   :', err.name);
      console.error('    Message:', err.message);
      console.error('    Fix: Check MONGO_URI, MONGO_USER, MONGO_PASS in Render Environment\n');
    });
});