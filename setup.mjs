import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'node:readline/promises';
import { spawnSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const isHelp = args.includes('--help') || args.includes('-h');
const isNonInteractive = args.includes('--non-interactive');
const isSkipInstall = args.includes('--skip-install');
const isReconfigure = args.includes('--reconfigure');

if (isHelp) {
  console.log("Usage: node setup.mjs [--help|-h] [--non-interactive] [--skip-install] [--reconfigure]");
  process.exit(0);
}

console.log("Node version:", process.version);
const majorVersion = parseInt(process.versions.node.split('.')[0], 10);
if (majorVersion < 20) {
  console.error("Error: Node.js 20 or higher is required.");
  console.error("Please download it from https://nodejs.org/");
  process.exit(1);
}

const py = spawnSync('python', ['--version']);
const py3 = spawnSync('python3', ['--version']);
if (py.error && py3.error) console.warn("Warning: python or python3 not found on PATH.");

const claude = spawnSync('claude', ['--version']);
if (claude.error) console.warn("Warning: claude (Claude Code) not found on PATH.");

const git = spawnSync('git', ['--version']);
if (git.error) console.warn("Warning: git not found on PATH.");

if (!isSkipInstall) {
  console.log("Installing npm dependencies...");
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // shell:true on win32 works around a Node/Windows spawnSync EINVAL when
  // invoking a .cmd file directly (seen on Node 24.x). Args here are fixed
  // literals, not user input, so the shell-injection risk is negligible.
  const npmRes = spawnSync(npmCmd, ['install'], { stdio: 'inherit', cwd: __dirname, shell: process.platform === 'win32' });
  if (npmRes.status !== 0) {
    console.error("npm install failed. Re-run manually: npm install");
    process.exit(1);
  }
  console.log("Installing Playwright browsers...");
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const pwArgs = ['playwright', 'install', 'chromium'];
  if (process.platform === 'linux') pwArgs.push('--with-deps');
  const pwRes = spawnSync(npxCmd, pwArgs, { stdio: 'inherit', cwd: __dirname, shell: process.platform === 'win32' });
  if (pwRes.status !== 0) {
    console.error(`Playwright install failed. Re-run manually: npx ${pwArgs.join(' ')}`);
    process.exit(1);
  }
}

const existingProfilePath = path.join(__dirname, 'profile.json');
let existingProfile = {};
if (fs.existsSync(existingProfilePath)) {
  existingProfile = JSON.parse(fs.readFileSync(existingProfilePath, 'utf8'));
}

const existingPrivatePath = path.join(__dirname, 'profile_private.json');
let existingPrivate = {};
if (fs.existsSync(existingPrivatePath)) {
  existingPrivate = JSON.parse(fs.readFileSync(existingPrivatePath, 'utf8'));
}

const answersPath = path.join(__dirname, 'setup.answers.json');
let answers = {};
if (isNonInteractive) {
  if (!fs.existsSync(answersPath)) {
    console.error(`Error: --non-interactive requires ${answersPath} to exist.`);
    process.exit(1);
  }
  answers = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
}

let rl;
if (!isNonInteractive) {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
}

function openUrl(url) {
  let cmd, cmdArgs;
  if (process.platform === 'win32') {
    cmd = 'cmd';
    cmdArgs = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    cmdArgs = [url];
  } else {
    cmd = 'xdg-open';
    cmdArgs = [url];
  }
  try {
    const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => console.log('Open this URL manually: ' + url));
    child.unref();
  } catch {
    console.log('Open this URL manually: ' + url);
  }
}

function getDef(obj, p, def = '') {
  if (!obj || (isReconfigure && obj === existingProfile)) return def;
  const parts = p.split('.');
  let current = obj;
  for (const part of parts) {
    if (current && current[part] !== undefined) current = current[part];
    else return def;
  }
  return current || def;
}

async function ask(key, prompt, defaultValue) {
  if (isNonInteractive) return answers[key] || '';
  const promptText = defaultValue ? `${prompt} [${defaultValue}]: ` : `${prompt}: `;
  const answer = await rl.question(promptText);
  return answer || defaultValue || '';
}

async function askPassword(key, prompt) {
  if (isNonInteractive) return answers[key] || '';
  process.stdout.write(prompt + ': ');
  return new Promise((resolve) => {
    let password = '';
    const onData = (char) => {
      char = char.toString();
      switch (char) {
        case '\n': case '\r': case '\u0004':
          process.stdin.removeListener('data', onData);
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          resolve(password);
          break;
        case '\u0003': process.exit(); break;
        case '\b': case '\x7f':
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write('\b \b');
          }
          break;
        default:
          password += char;
          process.stdout.write('*');
          break;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

console.log("\n--- Identity ---");
const legal_name = await ask('legal_name', 'Full legal name', getDef(existingProfile, 'identity.legal_name'));
const preferred_name = await ask('preferred_name', 'Preferred name', getDef(existingProfile, 'identity.preferred_name'));
const email = await ask('email', 'Email', getDef(existingProfile, 'identity.email'));
const school_email = await ask('school_email', 'School email (optional)', getDef(existingProfile, 'identity.school_email'));
const phone = await ask('phone', 'Phone', getDef(existingProfile, 'identity.phone'));
const school_student_id = await ask('school_student_id', 'Student ID (optional)', getDef(existingProfile, 'identity.school_student_id'));
const street = await ask('street', 'Street address', getDef(existingProfile, 'identity.local_address.street'));
const city = await ask('city', 'City', getDef(existingProfile, 'identity.local_address.city'));
const state = await ask('state', 'State', getDef(existingProfile, 'identity.local_address.state'));
const zip = await ask('zip', 'Zip/postal code', getDef(existingProfile, 'identity.local_address.zip'));
const county = await ask('county', 'County (optional)', getDef(existingProfile, 'identity.local_address.county'));
const country = await ask('country', 'Country', getDef(existingProfile, 'identity.local_address.country'));

console.log("\n--- Links ---");
const linkedin = await ask('linkedin', 'LinkedIn URL', getDef(existingProfile, 'identity.linkedin'));
const github = await ask('github', 'GitHub or portfolio URL (optional)', getDef(existingProfile, 'identity.links.github'));

console.log("\n--- Academic ---");
const school = await ask('school', 'School name', getDef(existingProfile, 'academic.school'));
const handshake_url = await ask('handshake_url', 'Handshake base URL (optional, e.g. https://schoolname.joinhandshake.com)', getDef(existingProfile, 'platforms.handshake.base_url'));
const degree = await ask('degree', 'Degree', getDef(existingProfile, 'academic.degree'));
const major = await ask('major', 'Major', getDef(existingProfile, 'academic.major'));
const graduation = await ask('graduation', 'Expected graduation, as forms show it (e.g. May 2028)', getDef(existingProfile, 'academic.expected_graduation'));
const gpa = await ask('gpa', 'GPA (optional)', getDef(existingProfile, 'academic.gpa'));

console.log("\n--- Location ---");
const default_radius_miles = await ask('default_radius_miles', 'Default job-search radius in miles', getDef(existingProfile, 'location.default_radius_miles', '10'));

console.log("\n--- Work eligibility ---");
const work_auth = await ask('work_auth', 'Work authorization status (US citizen / permanent resident / visa - specify)', getDef(existingProfile, 'work_basics.work_auth', 'US citizen'));
const authorized_to_work_us = await ask('authorized_to_work_us', 'Authorized to work in the US? (y/n)', getDef(existingProfile, 'work_basics.authorized_to_work_us') === false ? 'n' : 'y');
const sponsorship = await ask('sponsorship', 'Needs visa sponsorship (y/n)', getDef(existingProfile, 'work_basics.requires_sponsorship') ? 'y' : 'n');

console.log("\n--- Job targets ---");
const target_titles = await ask('target_titles', 'Target job titles (comma-separated list)', answers.target_titles || 'Software Engineer');
const target_locations = await ask('target_locations', 'Target locations (comma-separated list)', answers.target_locations || city);
const open_remote = await ask('open_remote', 'Open to remote (y/n)', answers.open_remote || 'y');
const start_date = await ask('start_date', 'Earliest start date', getDef(existingProfile, 'availability.earliest_start_date', 'immediately'));
const min_salary = await ask('min_salary', 'Minimum acceptable salary (optional)', getDef(existingProfile, 'work_basics.minimum_hourly_rate'));
const hours_pref = await ask('hours_pref', 'Hours preference (full-time/part-time/either)', getDef(existingProfile, 'availability.preferred_hours_per_week', 'either'));

console.log("\n--- Documents ---");
let resume_path = getDef(existingProfile, 'documents.resume_docx_master') || getDef(existingProfile, 'documents.resume_pdf');
while (true) {
  resume_path = await ask('resume_path', 'Resume file path (.docx or .pdf, leave blank to skip)', resume_path);
  if (!resume_path || fs.existsSync(resume_path)) break;
  console.log("File not found.");
  if (isNonInteractive) break;
}
let resume_docx_master = '';
let resume_pdf = '';
if (resume_path && fs.existsSync(resume_path)) {
  const destDir = path.join(__dirname, 'resumes');
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  const ext = path.extname(resume_path);
  const outPath = path.join(destDir, 'Resume' + ext);
  if (path.resolve(resume_path) !== path.resolve(outPath)) {
    fs.copyFileSync(resume_path, outPath);
  }
  resume_path = 'resumes/Resume' + ext;
  if (ext.toLowerCase() === '.pdf') {
    resume_pdf = resume_path;
  } else {
    resume_docx_master = resume_path;
  }
}

let cover_letter_path = getDef(existingProfile, 'documents.cover_letter_docx');
while (true) {
  cover_letter_path = await ask('cover_letter_path', 'Cover letter template file path (optional, leave blank to skip)', cover_letter_path);
  if (!cover_letter_path || fs.existsSync(cover_letter_path)) break;
  console.log("File not found.");
  if (isNonInteractive) break;
}
if (cover_letter_path && fs.existsSync(cover_letter_path)) {
  const destDir = path.join(__dirname, 'documents');
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  const ext = path.extname(cover_letter_path);
  const outPath = path.join(destDir, 'Cover Letter Template' + ext);
  if (path.resolve(cover_letter_path) !== path.resolve(outPath)) {
    fs.copyFileSync(cover_letter_path, outPath);
  }
  cover_letter_path = 'documents/Cover Letter Template' + ext;
}

console.log("\n--- Work history ---");
const work_history = (!isReconfigure && Array.isArray(existingProfile.work_history)) ? [...existingProfile.work_history] : [];
if (!isNonInteractive) {
  while (true) {
    const addJob = await ask('add_job', 'Add a past job? y/n', 'n');
    if (addJob.toLowerCase() !== 'y') break;
    const wh_employer = await ask('wh_employer', 'Employer');
    const wh_title = await ask('wh_title', 'Title');
    const wh_location = await ask('wh_location', 'City, State');
    const wh_start = await ask('wh_start', 'Start (YYYY-MM)');
    const wh_end = await ask('wh_end', 'End (YYYY-MM or "present")');
    const wh_supervisor_name = await ask('wh_supervisor_name', 'Supervisor name (optional)');
    const wh_supervisor_phone = await ask('wh_supervisor_phone', 'Supervisor phone (optional)');
    const wh_reason = await ask('wh_reason', 'Reason for leaving (optional)');
    const wh_may_contact = await ask('wh_may_contact', 'May contact this employer? y/n', 'y');
    work_history.push({
      employer: wh_employer,
      title: wh_title,
      location: wh_location,
      start: wh_start,
      end: wh_end,
      supervisor_name: wh_supervisor_name,
      supervisor_phone: wh_supervisor_phone,
      reason_for_leaving: wh_reason,
      may_contact: wh_may_contact.toLowerCase() === 'y'
    });
  }
} else if (Array.isArray(answers.work_history)) {
  answers.work_history.forEach(job => work_history.push(job));
}

console.log("\n--- Private section ---");
console.log("This data is saved separately in profile_private.json, kept out of git.");
const dob = await ask('dob', 'Date of birth (optional)', getDef(existingPrivate, 'date_of_birth'));
const perm_address = await ask('perm_address', 'Permanent address (optional)', getDef(existingPrivate, 'permanent_address'));

const ats_accounts = getDef(existingPrivate, 'accounts', []);
if (!isNonInteractive) {
  while (true) {
    const addAccount = await ask('add_account', 'Add an ATS account login? y/n', 'n');
    if (addAccount.toLowerCase() !== 'y') break;
    const site = await ask('ats_site', 'Site');
    const username = await ask('ats_username', 'Username');
    const password = await askPassword('ats_password', 'Password');
    ats_accounts.push({ site, username, password });
  }
} else {
  if (answers.ats_accounts) answers.ats_accounts.forEach(acc => ats_accounts.push(acc));
}

async function confirmOverwrite(filePath, newContent) {
  if (!fs.existsSync(filePath)) return true;
  if (isNonInteractive) return true;
  const fileName = path.basename(filePath);
  console.log(`\nChanges to ${fileName} pending...`);
  const ans = await ask('overwrite', `Overwrite existing ${fileName}? y/n`, 'n');
  return ans.toLowerCase() === 'y';
}

function writeJsonSync(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// Prepare objects
let profileOut = {};
if (fs.existsSync(path.join(__dirname, 'profile.example.json'))) {
  profileOut = JSON.parse(fs.readFileSync(path.join(__dirname, 'profile.example.json')));
} else {
  profileOut = { identity: { local_address: {}, links: {} }, academic: {}, work_basics: {}, availability: {}, documents: {} };
}
profileOut.identity = profileOut.identity || {};
profileOut.identity.legal_name = legal_name;
profileOut.identity.preferred_name = preferred_name;
profileOut.identity.email = email;
if (school_email) profileOut.identity.school_email = school_email;
profileOut.identity.phone = phone;
if (school_student_id) profileOut.identity.school_student_id = school_student_id;
profileOut.identity.local_address = profileOut.identity.local_address || {};
profileOut.identity.local_address.street = street;
profileOut.identity.local_address.city = city;
profileOut.identity.local_address.state = state;
profileOut.identity.local_address.zip = zip;
if (county) profileOut.identity.local_address.county = county;
profileOut.identity.local_address.country = country;
profileOut.identity.school = school;
if (linkedin) profileOut.identity.linkedin = linkedin;
profileOut.identity.links = profileOut.identity.links || {};
if (github) profileOut.identity.links.github = github;

profileOut.location = profileOut.location || {};
profileOut.location.commute_miles = profileOut.location.commute_miles || {};
if (default_radius_miles) profileOut.location.default_radius_miles = parseInt(default_radius_miles, 10) || 10;

profileOut.academic = profileOut.academic || {};
profileOut.academic.school = school;
profileOut.academic.degree = degree;
profileOut.academic.major = major;
profileOut.academic.expected_graduation = graduation;
if (gpa) profileOut.academic.gpa = gpa;

profileOut.platforms = profileOut.platforms || {};
profileOut.platforms.handshake = profileOut.platforms.handshake || {};
if (handshake_url) profileOut.platforms.handshake.base_url = handshake_url;

profileOut.work_basics = profileOut.work_basics || {};
profileOut.work_basics.work_auth = work_auth;
profileOut.work_basics.authorized_to_work_us = authorized_to_work_us.toLowerCase() === 'y';
profileOut.work_basics.requires_sponsorship = sponsorship.toLowerCase() === 'y';
if (min_salary) profileOut.work_basics.minimum_hourly_rate = min_salary;

profileOut.availability = profileOut.availability || {};
profileOut.availability.earliest_start_date = start_date;
profileOut.availability.preferred_hours_per_week = hours_pref;

profileOut.documents = profileOut.documents || {};
if (resume_docx_master) profileOut.documents.resume_docx_master = resume_docx_master;
if (resume_pdf) profileOut.documents.resume_pdf = resume_pdf;
if (cover_letter_path) profileOut.documents.cover_letter_docx = cover_letter_path;

profileOut.work_history = work_history;

let privateOut = {};
if (fs.existsSync(path.join(__dirname, 'profile_private.example.json'))) {
  privateOut = JSON.parse(fs.readFileSync(path.join(__dirname, 'profile_private.example.json')));
} else {
  privateOut = { accounts: {} };
}
if (dob) privateOut.date_of_birth = dob;
if (perm_address) privateOut.permanent_address = perm_address;
privateOut.accounts = ats_accounts;

// Placeholder cleanup: any leftover "<...>" string from the example templates
// that the wizard did not overwrite becomes "", so a stale placeholder never
// silently gets typed into a real application field. Required fields (see
// validateProfile in scripts/config.js) are left alone here - if still a
// placeholder, validateProfile will throw on it instead. _comment/_note/_readme
// style keys (anything starting with "_") are documentation, not data, so they
// are never touched.
const REQUIRED_PLACEHOLDER_PATHS = new Set([
  'identity.legal_name',
  'identity.email',
  'identity.phone',
  'identity.local_address.street',
  'identity.local_address.city',
  'identity.local_address.state',
  'identity.local_address.zip',
  'identity.school',
  'academic.major',
  'academic.expected_graduation',
  'work_basics.authorized_to_work_us',
  'documents.resume_docx_master',
  'documents.resume_pdf'
]);
function cleanPlaceholders(obj, prefix = '') {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (key.startsWith('_')) continue;
    const val = obj[key];
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (typeof val === 'string') {
      if (val.startsWith('<') && !REQUIRED_PLACEHOLDER_PATHS.has(fullPath)) {
        obj[key] = '';
      }
    } else if (Array.isArray(val)) {
      val.forEach((item) => cleanPlaceholders(item, fullPath));
    } else if (val && typeof val === 'object') {
      cleanPlaceholders(val, fullPath);
    }
  }
}
cleanPlaceholders(profileOut);
cleanPlaceholders(privateOut);

let answersOut = {};
if (fs.existsSync(path.join(__dirname, 'screening_answers.example.json'))) {
  answersOut = JSON.parse(fs.readFileSync(path.join(__dirname, 'screening_answers.example.json')));
} else {
  answersOut = { contact: { email: {}, first_name: {}, last_name: {}, full_name: {}, phone: {}, linkedin: {}, preferred_name: {} }, eligibility: { visa_sponsorship: {}, authorized_to_work_us: {} }, academic: { expected_graduation_year: {} }, preferences: { preferred_location: {} }, address: { city: {}, state: {}, zip: {}, country: {} }, availability: { start_date: {}, hours_preference: {} }, education: { school_name: {}, area_of_study: {} }, compensation: { desired_salary: {} } };
}
const ensureNode = (obj, pathParts) => {
  let curr = obj;
  for (const part of pathParts) {
    if (!curr[part]) curr[part] = {};
    curr = curr[part];
  }
  return curr;
};

// Map some screening answers based on provided values
const mapAns = (pathArray, val) => {
  if (val) ensureNode(answersOut, pathArray).answer = val;
};
mapAns(['contact', 'email'], email);
const [first, ...lastParts] = legal_name.split(' ');
const last = lastParts.join(' ');
mapAns(['contact', 'first_name'], first);
mapAns(['contact', 'last_name'], last);
mapAns(['contact', 'full_name'], legal_name);
mapAns(['contact', 'phone'], phone);
if (linkedin) mapAns(['contact', 'linkedin'], linkedin);
mapAns(['contact', 'preferred_name'], preferred_name);
const legalLastWord = legal_name.trim().split(/\s+/).pop();
if (preferred_name && legalLastWord) mapAns(['contact', 'phonetic_name'], `${preferred_name} ${legalLastWord}`);
mapAns(['eligibility', 'visa_sponsorship'], sponsorship.toLowerCase() === 'y' ? 'Yes' : 'No');
mapAns(['eligibility', 'authorized_to_work_us'], 'Yes');
mapAns(['academic', 'expected_graduation_year'], graduation);
mapAns(['preferences', 'preferred_location'], target_locations.split(',').map(s=>s.trim()));
mapAns(['address', 'city'], city);
mapAns(['address', 'state'], state);
mapAns(['address', 'zip'], zip);
mapAns(['address', 'country'], country);
mapAns(['availability', 'start_date'], start_date);
mapAns(['availability', 'hours_preference'], hours_pref);
mapAns(['education', 'school_name'], school);
mapAns(['education', 'area_of_study'], major);
if (min_salary) mapAns(['compensation', 'desired_salary'], min_salary);

let employersOut = {};
if (fs.existsSync(path.join(__dirname, 'employers.example.json'))) {
  employersOut = JSON.parse(fs.readFileSync(path.join(__dirname, 'employers.example.json')));
} else {
  employersOut = { default: { angle: "Dependable student with strong work ethic.", email_pattern: "{first}.{last}@{domain}", pattern_confidence: "unknown" } };
}

let targetsOut = "";
if (fs.existsSync(path.join(__dirname, 'targets.example.csv'))) {
  targetsOut = fs.readFileSync(path.join(__dirname, 'targets.example.csv'), 'utf8');
} else {
  targetsOut = "target_role,location\n";
  const titles = target_titles.split(',').map(s=>s.trim());
  const locs = target_locations.split(',').map(s=>s.trim());
  for (const t of titles) {
    if (t) targetsOut += `"${t}","${locs[0] || ''}"\n`;
  }
}

const filesWritten = [];

if (await confirmOverwrite(existingProfilePath, profileOut)) {
  writeJsonSync(existingProfilePath, profileOut);
  filesWritten.push('profile.json');
}
if (await confirmOverwrite(existingPrivatePath, privateOut)) {
  writeJsonSync(existingPrivatePath, privateOut);
  filesWritten.push('profile_private.json');
}
if (await confirmOverwrite(path.join(__dirname, 'screening_answers.json'), answersOut)) {
  writeJsonSync(path.join(__dirname, 'screening_answers.json'), answersOut);
  filesWritten.push('screening_answers.json');
}
if (await confirmOverwrite(path.join(__dirname, 'employers.json'), employersOut)) {
  writeJsonSync(path.join(__dirname, 'employers.json'), employersOut);
  filesWritten.push('employers.json');
}
if (await confirmOverwrite(path.join(__dirname, 'targets.csv'), targetsOut)) {
  fs.writeFileSync(path.join(__dirname, 'targets.csv'), targetsOut);
  filesWritten.push('targets.csv');
}

let envOut = "";
if (fs.existsSync(path.join(__dirname, '.env.example'))) {
  envOut = fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8');
} else {
  envOut = `JOB_AUTOMATION_HOME=${path.join(os.homedir(), '.job-automation').replace(/\\/g, '/')}\n`;
}
if (await confirmOverwrite(path.join(__dirname, '.env'), envOut)) {
  fs.writeFileSync(path.join(__dirname, '.env'), envOut);
  filesWritten.push('.env');
}

if (process.platform !== 'win32') {
  if (fs.existsSync(existingPrivatePath)) fs.chmodSync(existingPrivatePath, 0o600);
  if (fs.existsSync(path.join(__dirname, '.env'))) fs.chmodSync(path.join(__dirname, '.env'), 0o600);
}

// Connector step
console.log("\n--- Connector Setup ---");
console.log("1. If Claude Code is missing, install it via: npm install -g @anthropic-ai/claude-code");
console.log("2. Enable the Gmail and Hunter connectors at https://claude.ai/settings/connectors");
console.log("   (These must be toggled in the claude.ai web UI and cannot be automated.)");
console.log("3. Run `claude` once inside this directory so it picks up the project CLAUDE.md.");

openUrl('https://claude.ai/settings/connectors');

const connectorsDone = await ask('connectors_done', 'Have you completed the connector setup above? y/n', 'n');
if (connectorsDone.toLowerCase() === 'y') {
  if (fs.existsSync(existingProfilePath)) {
    const p = JSON.parse(fs.readFileSync(existingProfilePath, 'utf8'));
    p.connectors_configured = true;
    writeJsonSync(existingProfilePath, p);
  }
}

if (rl) rl.close();

console.log("\n--- Final Summary ---");
console.log("Files written or updated:");
filesWritten.forEach(f => console.log(` - ${f}`));

const packagePath = path.join(__dirname, 'package.json');
if (fs.existsSync(packagePath)) {
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (pkg.scripts && pkg.scripts.check) {
    console.log("\nRunning npm run check...");
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const checkRes = spawnSync(npmCmd, ['run', 'check'], { stdio: 'inherit', cwd: __dirname, shell: process.platform === 'win32' });
    if (checkRes.status !== 0) {
      console.log("npm run check failed. You may want to run it manually later.");
    }
  }
}

console.log("\n--- Daily Workflow Commands ---");
console.log("1. node scripts/handshake_scan.js --dry-run (Review targets)");
console.log("2. node scripts/apply_batch.js --dry-run (Prep applications)");
console.log("3. node scripts/apply_watch.js --url <form> (Watch/debug)");
