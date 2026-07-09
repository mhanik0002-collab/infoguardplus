require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const path = require('path');

if (!process.env.MONGODB_URI) {
    console.error("ERROR: MONGODB_URI is not defined in the environment variables.");
    console.error("Please set MONGODB_URI in Render.com env vars to connect to MongoDB.");
    process.exit(1);
}

const app = express();
const PORT = 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
    secret: 'clicksafe_secret_key',
    resave: false,
    saveUninitialized: true
}));

// Mongoose Models
const Program = mongoose.model('Program', new mongoose.Schema({ name: String }));
const Module = mongoose.model('Module', new mongoose.Schema({ name: String, program_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Program' } }));
const User = mongoose.model('User', new mongoose.Schema({
    full_name: String,
    email: String,
    password: { type: String, default: '123456' },
    role: { type: String, enum: ['admin', 'volunteer', 'student'] },
    status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Approved' },
    gender: String,
    address: String,
    phone: String,
    institution: String,
    profile_pic: { type: String, default: 'default.png' },
    program_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Program' },
    session_id: String
}));
const Attendance = mongoose.model('Attendance', new mongoose.Schema({
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    module_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Module' },
    program_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Program' },
    status: String,
    date: String
}));
const Score = mongoose.model('Score', new mongoose.Schema({
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    module_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Module' },
    score: Number
}));
const Leave = mongoose.model('Leave', new mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    role: String,
    date: String,
    message: String,
    status: { type: String, default: 'Pending' },
    created_at: { type: Date, default: Date.now }
}));
const Notification = mongoose.model('Notification', new mongoose.Schema({
    message: String,
    type: { type: String, enum: ['student', 'volunteer', 'admin', 'all'] },
    created_at: { type: Date, default: Date.now }
}));
const Feedback = mongoose.model('Feedback', new mongoose.Schema({
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    message: String,
    created_at: { type: Date, default: Date.now }
}));

async function initAdmin() {
    try {
        const admin = await User.findOne({ role: 'admin' });
        if (!admin) {
            await User.create({
                email: 'admin@infoguardplus.org',
                password: '123456',
                role: 'admin',
                full_name: 'InfoGuard+ Administrator',
                status: 'Approved'
            });
            console.log('Default admin created.');
        }
    } catch (err) {
        console.error('Error initializing admin:', err);
    }
}

mongoose.connect(process.env.MONGODB_URI).then(() => {
    console.log('Connected to MongoDB.');
    initAdmin();
}).catch(err => {
    console.error('MongoDB connection error:', err);
});

const requireAuth = (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    next();
};

const requireRole = (...roles) => (req, res, next) => {
    if (!roles.includes(req.session.user.role)) return res.redirect('/app?page=dashboard&msg=Access Denied');
    next();
};

async function appHandler(req, res) {
    try {
        const success_msg = req.query.msg || '';
        const page = req.query.page || 'dashboard';
        const user = req.session.user;

        const allowedPages = {
            admin: ['dashboard', 'manage_programs', 'manage_modules', 'manage_volunteers', 'manage_students', 'manage_attendance', 'take_attendance', 'manage_exams', 'notifications', 'notify', 'feedback', 'request_absence'],
            volunteer: ['dashboard', 'take_attendance', 'manage_attendance', 'manage_exams', 'view_attendance', 'request_absence', 'volunteer_notifs', 'feedback'],
            student: ['dashboard', 'request_absence', 'student_notifs', 'my_attendance', 'exam_results', 'feedback']
        };

        if (user.role !== 'admin' && (!allowedPages[user.role] || !allowedPages[user.role].includes(page))) {
            return res.redirect('/app?page=dashboard&msg=Access Denied');
        }

        if (req.method === 'GET' && req.query.delete && req.query.table && req.query.id && user.role === 'admin') {
            const { table, id } = req.query;
            if (table === 'programs') await Program.findByIdAndDelete(id);
            if (table === 'modules') await Module.findByIdAndDelete(id);
            if (table === 'volunteers' || table === 'students') await User.findByIdAndDelete(id);
            return res.redirect(`/app?page=${page}&msg=Record deleted successfully.`);
        }

        if (req.method === 'POST') {
            const action = req.body.action;
            let sm = 'Action completed successfully.';
            
            if (action === 'add_program' && user.role === 'admin') {
                await Program.create({ name: req.body.name });
                sm = 'Program added successfully.';
            } else if (action === 'add_module' && user.role === 'admin') {
                await Module.create({ name: req.body.name, program_id: req.body.program_id });
                sm = 'Module added successfully.';
            } else if (action === 'add_volunteer' && user.role === 'admin') {
                await User.create({ ...req.body, role: 'volunteer', status: 'Approved' });
                sm = 'Volunteer added successfully.';
            } else if (action === 'add_student' && user.role === 'admin') {
                await User.create({ ...req.body, role: 'student', status: 'Approved' });
                sm = 'Student added successfully.';
            } else if (action === 'update_volunteer_status' && user.role === 'admin') {
                await User.findByIdAndUpdate(req.body.volunteer_id, { status: req.body.status });
                await Notification.create({ message: `Your volunteer application was ${req.body.status.toLowerCase()}.`, type: 'volunteer' });
                sm = `Volunteer status updated to ${req.body.status}.`;
            } else if (action === 'save_attendance') {
                const { date, program_id, module_id, attendance } = req.body;
                await Attendance.deleteMany({ date, module_id, program_id });
                if (attendance) {
                    for (let sid of Object.keys(attendance)) {
                        await Attendance.create({ student_id: sid, module_id, program_id, status: attendance[sid], date });
                    }
                }
                sm = 'Attendance saved successfully.';
            } else if (action === 'save_scores') {
                const { module_id, score } = req.body;
                if (score) {
                    for (let sid of Object.keys(score)) {
                        if (score[sid] !== '') {
                            await Score.findOneAndUpdate({ student_id: sid, module_id }, { score: score[sid] }, { upsert: true, new: true });
                            await Notification.create({ message: 'Your quiz score for a module has been published.', type: 'student' });
                        }
                    }
                }
                sm = 'Scores saved successfully.';
            } else if (action === 'request_absence') {
                await Leave.create({ user_id: user._id, role: user.role, date: req.body.date, message: req.body.message });
                await Notification.create({ message: `${user.full_name} submitted an absence request.`, type: 'admin' });
                sm = 'Absence request submitted.';
            } else if (action === 'update_leave' && user.role === 'admin') {
                const leave = await Leave.findByIdAndUpdate(req.body.leave_id, { status: req.body.status });
                if (leave) await Notification.create({ message: `Your absence request was ${req.body.status.toLowerCase()}.`, type: leave.role });
                sm = `Absence request ${req.body.status}.`;
            } else if (action === 'send_notification' && user.role === 'admin') {
                await Notification.create({ message: req.body.message, type: req.body.audience });
                sm = 'Notification sent successfully.';
            } else if (action === 'send_feedback') {
                await Feedback.create({ student_id: user._id, message: req.body.message });
                sm = 'Feedback sent successfully.';
            }

            return res.redirect(`/app?page=${page}&msg=${encodeURIComponent(sm)}`);
        }

        const data = { user, page, success_msg, fetched_students: [], exam_students: [], existing_scores: {}, existing_attendance: {} };
        data.programs = await Program.find();
        data.modules = await Module.find().populate('program_id');

        const notifs = await Notification.find({ type: { $in: [user.role, 'all'] } });
        data.unread_count = notifs.length;

        if (page === 'dashboard') {
            data.total_students = await User.countDocuments({ role: 'student' });
            data.total_volunteers = await User.countDocuments({ role: 'volunteer' });
            data.total_programs = await Program.countDocuments();
            data.total_modules = await Module.countDocuments();
            data.att_count = await Attendance.countDocuments();
            if (user.role === 'student') {
                data.total_present = await Attendance.countDocuments({ student_id: user._id, status: 'Present' });
                data.total_total = await Attendance.countDocuments({ student_id: user._id });
            }
            if (user.role === 'admin') {
                data.pending_volunteers = await User.countDocuments({ role: 'volunteer', status: 'Pending' });
            }
        } else if (page === 'manage_volunteers') {
            const vols = await User.find({ role: 'volunteer' });
            data.volunteers = vols.sort((a, b) => (a.status === 'Pending' ? -1 : 1));
        } else if (page === 'manage_students') {
            data.students = await User.find({ role: 'student' }).populate('program_id');
        } else if (page === 'manage_attendance' || page === 'take_attendance') {
            if (req.query.fetch_program && req.query.fetch_date && req.query.fetch_module) {
                data.fetch_date = req.query.fetch_date;
                data.fetch_program = req.query.fetch_program;
                data.fetch_module = req.query.fetch_module;
                data.fetched_students = await User.find({ role: 'student', program_id: req.query.fetch_program });
                const atts = await Attendance.find({ date: req.query.fetch_date, module_id: req.query.fetch_module });
                atts.forEach(a => data.existing_attendance[a.student_id] = a.status);
            }
        } else if (page === 'manage_exams') {
            if (req.query.fetch_program && req.query.fetch_module) {
                data.fetch_program = req.query.fetch_program;
                data.fetch_module = req.query.fetch_module;
                data.exam_students = await User.find({ role: 'student', program_id: req.query.fetch_program });
                const sc = await Score.find({ module_id: req.query.fetch_module });
                sc.forEach(s => data.existing_scores[s.student_id] = s.score);
            }
        } else if (page === 'notifications') {
            data.leaves = await Leave.find().populate('user_id').sort('-created_at');
            data.pending_volunteers_list = await User.find({ role: 'volunteer', status: 'Pending' });
        } else if (page === 'volunteer_notifs' || page === 'student_notifs') {
            data.notifs = await Notification.find({ type: { $in: [user.role, 'all'] } }).sort('-created_at');
        } else if (page === 'request_absence') {
            data.my_leaves = await Leave.find({ user_id: user._id }).sort('-created_at');
        } else if (page === 'view_attendance') {
            data.logs = await Attendance.find().populate('student_id module_id').sort('-date').limit(50);
        } else if (page === 'my_attendance') {
            data.my_att = await Attendance.find({ student_id: user._id }).populate('module_id').sort('-date');
        } else if (page === 'exam_results') {
            data.scores = await Score.find({ student_id: user._id }).populate('module_id');
        }

        res.render('app', data);
    } catch (err) {
        console.error(err);
        res.status(500).send("An error occurred while loading the page.");
    }
}

app.get('/', (req, res) => res.redirect('/app'));
app.get('/login', (req, res) => res.render('login', { error: req.query.error, success: req.query.success }));
app.post('/login', async (req, res) => {
    try {
        const user = await User.findOne({ email: req.body.email, password: req.body.password });
        if (!user) return res.redirect('/login?error=Invalid credentials.');
        if (user.role === 'volunteer' && user.status === 'Pending') return res.redirect('/login?error=Your volunteer application is still pending admin approval.');
        if (user.status === 'Rejected') return res.redirect('/login?error=Your volunteer application was not approved. Contact InfoGuard+ for details.');
        req.session.user = user;
        res.redirect('/app?page=dashboard');
    } catch (err) {
        res.redirect('/login?error=Database Error.');
    }
});
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});
app.get('/register', async (req, res) => {
    const programs = await Program.find();
    res.render('register', { error: req.query.error, programs });
});
app.post('/register', async (req, res) => {
    try {
        const role = req.body.role;
        if (role !== 'student' && role !== 'volunteer') return res.redirect('/register?error=Invalid role');
        
        if (role === 'student') {
            await User.create({ ...req.body, role: 'student', status: 'Approved' });
            return res.redirect('/login?success=Registration successful! You can log in now.');
        } else {
            // Address concatenates motivation per the prompt instructions constraint
            await User.create({ ...req.body, role: 'volunteer', status: 'Pending' });
            await Notification.create({ message: `New volunteer application from ${req.body.full_name} awaiting review.`, type: 'admin' });
            return res.redirect('/login?success=Your volunteer application has been submitted for InfoGuard+ admin review.');
        }
    } catch (err) {
        res.redirect('/register?error=Database Error.');
    }
});

app.get('/app', requireAuth, appHandler);
app.post('/app', requireAuth, appHandler);

app.use((req, res) => {
    res.status(404).send(`Route Not Found: ${req.method} ${req.url}`);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});
