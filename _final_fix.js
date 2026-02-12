const fs = require('fs');
const content = fs.readFileSync('settings-panel.js', 'utf8');
const lines = content.split(/\r?\n/);
const newLines = [];

let skipMode = null; // 'upgradeBlock', 'checkPro', 'startPolling', 'cancelSub'
let braceCount = 0;

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 1. Detect Upgrade Block in HTML
    if (line.includes('${!isPro ?') && lines[i + 1] && lines[i + 1].includes('Upgrade to Pro')) {
        skipMode = 'upgradeBlock';
        continue;
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
        newLines.push('    async checkProStatus(userId) { return true; }'); // Replacement
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
        newLines.push('    startPolling(userId) { /* removed */ }'); // Replacement
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

    // 4. Detect handleCancelSubscription function
    if (trimmed.startsWith('async handleCancelSubscription() {')) {
        skipMode = 'cancelSub';
        braceCount = 1;
        newLines.push('    async handleCancelSubscription() { vscode.window.showInformationMessage("No subscription active (Community Version)"); }');
        continue;
    }
    if (skipMode === 'cancelSub') {
        braceCount += (line.match(/\{/g) || []).length;
        braceCount -= (line.match(/\}/g) || []).length;
        if (braceCount === 0) {
            skipMode = null;
        }
        continue;
    }

    // 5. Remove LICENSE_API usage if any remains inline
    if (line.includes('LICENSE_API')) {
        newLines.push(line.replace('LICENSE_API', "'https://example.com'")); // Neutralize
        continue;
    }

    // New: Remove the specific 'Failed to cancel subscription' message block if it somehow survived
    if (line.includes('Failed to cancel subscription')) {
        continue;
    }

    newLines.push(line);
}

const finalContent = newLines.join('\n');
fs.writeFileSync('settings-panel.js', finalContent);
console.log('Fixed settings-panel.js. New line count:', newLines.length);
