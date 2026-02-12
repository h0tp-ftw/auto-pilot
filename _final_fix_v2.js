const fs = require('fs');
const content = fs.readFileSync('settings-panel.js', 'utf8');
const lines = content.split(/\r?\n/);
const newLines = [];

let skipMode = null; // 'upgradeBlock', 'checkPro', 'startPolling', 'cancelSub'
let braceCount = 0;

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 1. Detect Upgrade Block in HTML (Robust check)
    if (line.includes('${!isPro ?')) {
        // Look ahead to see if this is the Upgrade block
        let isUpgradeBlock = false;
        for (let j = 1; j < 10; j++) {
            if (lines[i + j] && lines[i + j].includes('Upgrade to Pro')) {
                isUpgradeBlock = true;
                break;
            }
        }
        if (isUpgradeBlock) {
            skipMode = 'upgradeBlock';
            continue;
        }
    }
    if (skipMode === 'upgradeBlock') {
        if (trimmed === "` : ''}") {
            skipMode = null;
        }
        continue;
    }

    // 2. Detect checkProStatus function
    if (trimmed.startsWith('async checkProStatus(userId) {')) {
        skipMode = 'checkPro';
        braceCount = 1;
        newLines.push('    async checkProStatus(userId) { return true; }');
        continue;
    }
    if (skipMode === 'checkPro') {
        braceCount += (line.match(/\{/g) || []).length;
        braceCount -= (line.match(/\}/g) || []).length;
        if (braceCount === 0) {
            skipMode = null;
        }
        continue;
    }

    // 3. Detect startPolling function
    if (trimmed.startsWith('startPolling(userId) {')) {
        skipMode = 'startPolling';
        braceCount = 1;
        newLines.push('    startPolling(userId) { /* removed */ }');
        continue;
    }
    if (skipMode === 'startPolling') {
        braceCount += (line.match(/\{/g) || []).length;
        braceCount -= (line.match(/\}/g) || []).length;
        if (braceCount === 0) {
            skipMode = null;
        }
        continue;
    }

    newLines.push(line);
}

const finalContent = newLines.join('\n');
fs.writeFileSync('settings-panel.js', finalContent);
console.log('Fixed settings-panel.js v2. New line count:', newLines.length);
