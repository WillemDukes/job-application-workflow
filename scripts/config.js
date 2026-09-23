const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

// Tiny .env parser
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const match = trimmed.match(/^([^=]+)=(.*)$/);
            if (match) {
                const key = match[1].trim();
                const value = match[2].trim().replace(/^["'](.*)["']$/, '$1'); // remove quotes if present
                process.env[key] = value;
            }
        }
    });
}

// Load JSON configurations
function loadJson(filename) {
    const filePath = path.join(ROOT, filename);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Missing configuration file: ${filename}. Please run 'npm run setup' first to create it from the example file.`);
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const profile = loadJson('profile.json');
if (!Array.isArray(profile.certification_keywords)) {
    profile.certification_keywords = [];
}
const profilePrivate = loadJson('profile_private.json');
const screeningAnswers = loadJson('screening_answers.json');
const employers = loadJson('employers.json');

// Export resolved absolute paths
const paths = {
    resumes: path.join(ROOT, 'resumes'),
    documents: path.join(ROOT, 'documents'),
    runs: path.join(ROOT, 'runs'),
    generated: path.join(ROOT, 'generated'),
    outbox: path.join(ROOT, 'outbox'),
    logs: path.join(ROOT, 'logs'),
    appliedJsonl: path.join(ROOT, 'applied.jsonl')
};

const BROWSER_PROFILE_DIR = process.env.JOB_AUTOMATION_HOME || path.join(os.homedir(), '.job-automation', 'browser-profile');

function getPath(obj, dotted) {
    const parts = dotted.split('.');
    let cur = obj;
    for (const part of parts) {
        if (cur === undefined || cur === null) return undefined;
        cur = cur[part];
    }
    return cur;
}

function isEmptyOrPlaceholder(val) {
    if (val === undefined || val === null || val === '') return true;
    if (typeof val === 'string' && val.startsWith('<')) return true;
    return false;
}

// Fields that must be present, non-empty, and not a leftover "<...>"
// placeholder. Booleans/strings are both accepted for authorized_to_work_us
// since a hand-edited profile.json might use either.
const REQUIRED_FIELDS = [
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
    'work_basics.authorized_to_work_us'
];

function validateProfileReport() {
    const errors = [];
    const warnings = [];

    for (const field of REQUIRED_FIELDS) {
        const val = getPath(profile, field);
        if (field === 'work_basics.authorized_to_work_us') {
            const ok = typeof val === 'boolean'
                || (typeof val === 'string' && /^(y|yes|n|no|true|false)$/i.test(val));
            if (!ok) {
                errors.push(`Missing or invalid required field: ${field} (must be boolean or yes/no)`);
            }
            continue;
        }
        if (isEmptyOrPlaceholder(val)) {
            errors.push(`Missing or empty required field: ${field}`);
        }
    }

    // At least one resume file must be configured AND exist on disk.
    const resumeDocx = getPath(profile, 'documents.resume_docx_master');
    const resumePdf = getPath(profile, 'documents.resume_pdf');
    const candidates = [resumeDocx, resumePdf].filter((v) => !isEmptyOrPlaceholder(v));
    if (candidates.length === 0) {
        errors.push('Missing required field: documents.resume_docx_master or documents.resume_pdf (set at least one)');
    } else {
        const found = candidates.some((rel) => fs.existsSync(path.resolve(ROOT, rel)));
        if (!found) {
            errors.push(`Resume file not found on disk (checked: ${candidates.map((c) => path.resolve(ROOT, c)).join(', ')})`);
        }
    }

    // Everything else that still looks like a placeholder is a warning, not
    // a hard failure - it just means that optional field was never filled in.
    function walk(obj, prefix = '') {
        if (!obj || typeof obj !== 'object') return;
        for (const key of Object.keys(obj)) {
            if (key.startsWith('_')) continue;
            const val = obj[key];
            const fullPath = prefix ? `${prefix}.${key}` : key;
            if (REQUIRED_FIELDS.includes(fullPath)) continue;
            if (typeof val === 'string') {
                if (val.startsWith('<')) {
                    warnings.push(`Placeholder value left in optional field: ${fullPath} (${val})`);
                }
            } else if (Array.isArray(val)) {
                val.forEach((item, i) => walk(item, `${fullPath}[${i}]`));
            } else if (val && typeof val === 'object') {
                walk(val, fullPath);
            }
        }
    }
    walk(profile);

    return { errors, warnings };
}

function validateProfile() {
    const { errors } = validateProfileReport();
    if (errors.length > 0) {
        throw new Error("Profile validation failed. Please fill out all required fields:\n- " + errors.join('\n- '));
    }
}

module.exports = {
    ROOT,
    profile,
    profilePrivate,
    screeningAnswers,
    employers,
    paths,
    BROWSER_PROFILE_DIR,
    validateProfile,
    validateProfileReport
};
