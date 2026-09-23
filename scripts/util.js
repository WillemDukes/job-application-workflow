const fs = require('fs');
const path = require('path');
const { paths } = require('./config');

async function withRetry(fn, { attempts = 3, backoffMs = 1000 } = {}) {
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i === attempts - 1) throw err;
            await new Promise(r => setTimeout(r, backoffMs * (i + 1)));
        }
    }
}

function getLogFile() {
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return path.join(paths.logs, `${dateStr}.jsonl`);
}

const logger = {
    info(msg, meta = {}) {
        const entry = { level: 'info', time: new Date().toISOString(), msg, ...meta };
        console.log(`[INFO] ${msg}`, Object.keys(meta).length ? meta : '');
        try {
            fs.mkdirSync(paths.logs, { recursive: true });
            fs.appendFileSync(getLogFile(), JSON.stringify(entry) + '\n');
        } catch (e) {}
    },
    error(msg, meta = {}) {
        const entry = { level: 'error', time: new Date().toISOString(), msg, ...meta };
        console.error(`[ERROR] ${msg}`, Object.keys(meta).length ? meta : '');
        try {
            fs.mkdirSync(paths.logs, { recursive: true });
            fs.appendFileSync(getLogFile(), JSON.stringify(entry) + '\n');
        } catch (e) {}
    }
};

async function screenshotOnFailure(page, label) {
    try {
        const shotsDir = path.join(paths.logs, 'screenshots');
        fs.mkdirSync(shotsDir, { recursive: true });
        const filepath = path.join(shotsDir, `${label}_${Date.now()}.png`);
        await page.screenshot({ path: filepath, fullPage: true });
        logger.info(`Saved failure screenshot: ${filepath}`);
    } catch (err) {
        logger.error(`Failed to take screenshot for ${label}`, { error: err.message });
    }
}

const appliedLedger = {
    has(jobUrl) {
        if (!fs.existsSync(paths.appliedJsonl)) return false;
        const content = fs.readFileSync(paths.appliedJsonl, 'utf8');
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line);
                if (entry.url === jobUrl) return true;
            } catch (e) {}
        }
        return false;
    },
    append(jobUrl, meta = {}) {
        const entry = { url: jobUrl, time: new Date().toISOString(), ...meta };
        fs.appendFileSync(paths.appliedJsonl, JSON.stringify(entry) + '\n');
    }
};

module.exports = {
    withRetry,
    logger,
    screenshotOnFailure,
    appliedLedger
};
