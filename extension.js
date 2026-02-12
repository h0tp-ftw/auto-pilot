const vscode = require('vscode');
const path = require('path');

// Lazy load SettingsPanel to avoid blocking activation
let SettingsPanel = null;
function getSettingsPanel() {
    if (!SettingsPanel) {
        try {
            SettingsPanel = require('./settings-panel').SettingsPanel;
        } catch (e) {
            console.error('Failed to load SettingsPanel:', e);
        }
    }
    return SettingsPanel;
}

// states

const GLOBAL_STATE_KEY = 'auto-accept-enabled-global';
const FREQ_STATE_KEY = 'auto-accept-frequency';
const BANNED_COMMANDS_KEY = 'auto-accept-banned-commands';
const ROI_STATS_KEY = 'auto-accept-roi-stats'; // For ROI notification
const SECONDS_PER_CLICK = 5; // Conservative estimate: 5 seconds saved per auto-accept
// Locking
const LOCK_KEY = 'auto-accept-instance-lock';
const HEARTBEAT_KEY = 'auto-accept-instance-heartbeat';
const INSTANCE_ID = Math.random().toString(36).substring(7);

let isEnabled = false;
const isPro = true; // Community fork: all features unlocked
let isLockedOut = false; // Local tracking
let pollFrequency = 1000; // Default pro speed
let bannedCommands = []; // List of command patterns to block

// Background Mode state
let backgroundModeEnabled = false;
const BACKGROUND_DONT_SHOW_KEY = 'auto-accept-background-dont-show';
const BACKGROUND_MODE_KEY = 'auto-accept-background-mode';
const VERSION_7_0_KEY = 'auto-accept-version-7.0-notification-shown';
const VERSION_8_6_0_KEY = 'auto-accept-version-8.6-notification-shown';
const RELEASY_PROMO_KEY = 'auto-accept-releasy-promo-shown';

let pollTimer;
let statsCollectionTimer; // For periodic stats collection
let statusBarItem;
let statusSettingsItem;
let statusBackgroundItem; // New: Background Mode toggle
let outputChannel;
let currentIDE = 'unknown'; // 'cursor' | 'antigravity'
let globalContext;

// Handlers (used by both IDEs now)
let cdpHandler;
let relauncher;

function log(message) {
    try {
        const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
        const logLine = `[${timestamp}] ${message}`;
        console.log(logLine);
    } catch (e) {
        console.error('Logging failed:', e);
    }
}

function detectIDE() {
    const appName = vscode.env.appName || '';
    if (appName.toLowerCase().includes('cursor')) return 'Cursor';
    if (appName.toLowerCase().includes('antigravity')) return 'Antigravity';
    return 'Code'; // only supporting these 3 for now
}

async function activate(context) {
    globalContext = context;
    console.log('Auto Pilot Extension: Activator called.');

    // CRITICAL: Create status bar items FIRST before anything else
    try {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.command = 'auto-accept.toggle';
        statusBarItem.text = '$(sync~spin) Auto Pilot: Loading...';
        statusBarItem.tooltip = 'Auto Pilot is initializing...';
        context.subscriptions.push(statusBarItem);
        statusBarItem.show();

        statusSettingsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
        statusSettingsItem.command = 'auto-accept.openSettings';
        statusSettingsItem.text = '$(gear)';
        statusSettingsItem.tooltip = 'Auto Pilot Settings';
        context.subscriptions.push(statusSettingsItem);
        statusSettingsItem.show();

        // Background Mode status bar item
        statusBackgroundItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
        statusBackgroundItem.command = 'auto-accept.toggleBackground';
        statusBackgroundItem.text = '$(globe) Background: OFF';
        statusBackgroundItem.tooltip = 'Background Mode - Works on all chats';
        context.subscriptions.push(statusBackgroundItem);
        // Don't show by default - only when Auto Accept is ON

        console.log('Auto Pilot: Status bar items created and shown.');
    } catch (sbError) {
        console.error('CRITICAL: Failed to create status bar items:', sbError);
    }

    try {
        // 1. Initialize State
        isEnabled = context.globalState.get(GLOBAL_STATE_KEY, false);

        // Load frequency (all features unlocked)
        pollFrequency = context.globalState.get(FREQ_STATE_KEY, 1000);

        // Load background mode state
        backgroundModeEnabled = context.globalState.get(BACKGROUND_MODE_KEY, false);

        // Load banned commands list (default: common dangerous patterns)
        const defaultBannedCommands = [
            'rm -rf /',
            'rm -rf ~',
            'rm -rf *',
            'format c:',
            'del /f /s /q',
            'rmdir /s /q',
            ':(){:|:&};:',  // fork bomb
            'dd if=',
            'mkfs.',
            '> /dev/sda',
            'chmod -R 777 /'
        ];
        bannedCommands = context.globalState.get(BANNED_COMMANDS_KEY, defaultBannedCommands);


        // License verification removed — community fork, all features unlocked

        currentIDE = detectIDE();

        // 2. Create Output Channel
        outputChannel = vscode.window.createOutputChannel('Auto Pilot');
        context.subscriptions.push(outputChannel);

        log(`Auto Pilot: Activating...`);
        log(`Auto Pilot: Detected environment: ${currentIDE.toUpperCase()}`);

        // Setup Focus Listener - Push state to browser (authoritative source)
        vscode.window.onDidChangeWindowState(async (e) => {
            // Always push focus state to browser - this is the authoritative source
            if (cdpHandler && cdpHandler.setFocusState) {
                await cdpHandler.setFocusState(e.focused);
            }

            // When user returns and auto-accept is running, check for away actions
            if (e.focused && isEnabled) {
                log(`[Away] Window focus detected by VS Code API. Checking for away actions...`);
                // Wait a tiny bit for CDP to settle after focus state is pushed
                setTimeout(() => checkForAwayActions(context), 500);
            }
        });

        // 3. Initialize Handlers (Lazy Load) - Both IDEs use CDP now
        try {
            const { CDPHandler } = require('./main_scripts/cdp-handler');
            const { Relauncher } = require('./main_scripts/relauncher');

            cdpHandler = new CDPHandler(log);
            relauncher = new Relauncher(log);
            log(`CDP handlers initialized for ${currentIDE}.`);
        } catch (err) {
            log(`Failed to initialize CDP handlers: ${err.message}`);
            vscode.window.showErrorMessage(`Auto Accept Error: ${err.message}`);
        }

        // 4. Update Status Bar (already created at start)
        updateStatusBar();
        log('Status bar updated with current state.');

        // 5. Register Commands
        context.subscriptions.push(
            vscode.commands.registerCommand('auto-accept.toggle', () => handleToggle(context)),
            vscode.commands.registerCommand('auto-accept.relaunch', () => handleRelaunch()),
            vscode.commands.registerCommand('auto-accept.updateFrequency', (freq) => handleFrequencyUpdate(context, freq)),
            vscode.commands.registerCommand('auto-accept.toggleBackground', () => handleBackgroundToggle(context)),
            vscode.commands.registerCommand('auto-accept.updateBannedCommands', (commands) => handleBannedCommandsUpdate(context, commands)),
            vscode.commands.registerCommand('auto-accept.getBannedCommands', () => bannedCommands),
            vscode.commands.registerCommand('auto-accept.getROIStats', async () => {
                const stats = await loadROIStats(context);
                const timeSavedSeconds = stats.clicksThisWeek * SECONDS_PER_CLICK;
                const timeSavedMinutes = Math.round(timeSavedSeconds / 60);
                return {
                    ...stats,
                    timeSavedMinutes,
                    timeSavedFormatted: timeSavedMinutes >= 60
                        ? `${(timeSavedMinutes / 60).toFixed(1)} hours`
                        : `${timeSavedMinutes} minutes`
                };
            }),
            vscode.commands.registerCommand('auto-accept.openSettings', () => {
                const panel = getSettingsPanel();
                if (panel) {
                    panel.createOrShow(context.extensionUri, context);
                } else {
                    vscode.window.showErrorMessage('Failed to load Settings Panel.');
                }
            })
        );

        // URI handler not needed — no payment activation flow

        // 7. Check environment and start if enabled
        try {
            await checkEnvironmentAndStart();
        } catch (err) {
            log(`Error in environment check: ${err.message}`);
        }

        // 8. Show Version 5.0 Notification (Once)
        showVersionNotification(context);

        // Cross-promo removed — community fork

        log('Auto Pilot: Activation complete');
    } catch (error) {
        console.error('ACTIVATION CRITICAL FAILURE:', error);
        log(`ACTIVATION CRITICAL FAILURE: ${error.message}`);
        vscode.window.showErrorMessage(`Auto Pilot Extension failed to activate: ${error.message}`);
    }
}

async function ensureCDPOrPrompt(showPrompt = false) {
    if (!cdpHandler) return false;

    log('Checking for active CDP session...');
    const cdpAvailable = await cdpHandler.isCDPAvailable();
    log(`Environment check: CDP Available = ${cdpAvailable}`);

    if (cdpAvailable) {
        log('CDP is active and available.');
        return true;
    } else {
        log('CDP not found on target ports (9000 +/- 3).');
        if (showPrompt && relauncher) {
            log('Initiating CDP setup flow...');
            await relauncher.ensureCDPAndRelaunch();
        }
        return false;
    }
}

async function checkEnvironmentAndStart() {
    if (isEnabled) {
        log('Initializing Auto Accept environment...');
        const cdpReady = await ensureCDPOrPrompt(false);

        if (!cdpReady) {
            // CDP not available - reset to OFF state so user can trigger setup via toggle
            log('Auto Accept was enabled but CDP is not available. Resetting to OFF state.');
            isEnabled = false;
            await globalContext.globalState.update(GLOBAL_STATE_KEY, false);
        } else {
            await startPolling();
            // Start stats collection if already enabled on startup
            startStatsCollection(globalContext);
        }
    }
    updateStatusBar();
}

async function handleToggle(context) {
    log('=== handleToggle CALLED ===');
    log(`  Previous isEnabled: ${isEnabled}`);

    try {
        // Check CDP availability first
        const cdpAvailable = cdpHandler ? await cdpHandler.isCDPAvailable() : false;

        // If trying to enable but CDP not available, prompt for relaunch (don't change state)
        if (!isEnabled && !cdpAvailable && relauncher) {
            log('Auto Pilot: CDP not available. Prompting for setup/relaunch.');
            await relauncher.ensureCDPAndRelaunch();
            return; // Don't change state - toggle stays OFF
        }

        isEnabled = !isEnabled;
        log(`  New isEnabled: ${isEnabled}`);

        // Update state and UI IMMEDIATELY (non-blocking)
        await context.globalState.update(GLOBAL_STATE_KEY, isEnabled);
        log(`  GlobalState updated`);

        log('  Calling updateStatusBar...');
        updateStatusBar();

        // Do CDP operations in background (don't block toggle)
        if (isEnabled) {
            log('Auto Pilot: Enabled');
            // These operations happen in background
            ensureCDPOrPrompt(true).then(() => startPolling());
            startStatsCollection(context);
            incrementSessionCount(context);
        } else {
            log('Auto Pilot: Disabled');

            // Fire-and-forget: Show session summary notification (non-blocking)
            if (cdpHandler) {
                cdpHandler.getSessionSummary()
                    .then(summary => showSessionSummaryNotification(context, summary))
                    .catch(() => { });
            }

            // Fire-and-forget: collect stats and stop in background
            collectAndSaveStats(context).catch(() => { });
            stopPolling().catch(() => { });
        }

        log('=== handleToggle COMPLETE ===');
    } catch (e) {
        log(`Error toggling: ${e.message}`);
        log(`Error stack: ${e.stack}`);
    }
}

async function handleRelaunch() {
    if (!relauncher) {
        vscode.window.showErrorMessage('Relauncher not initialized.');
        return;
    }

    log('Initiating CDP Setup flow...');
    await relauncher.ensureCDPAndRelaunch();
}

async function handleFrequencyUpdate(context, freq) {
    pollFrequency = freq;
    await context.globalState.update(FREQ_STATE_KEY, freq);
    log(`Poll frequency updated to: ${freq}ms`);
    if (isEnabled) {
        await syncSessions();
    }
}

async function handleBannedCommandsUpdate(context, commands) {
    bannedCommands = Array.isArray(commands) ? commands : [];
    await context.globalState.update(BANNED_COMMANDS_KEY, bannedCommands);
    log(`Banned commands updated: ${bannedCommands.length} patterns`);
    if (bannedCommands.length > 0) {
        log(`Banned patterns: ${bannedCommands.slice(0, 5).join(', ')}${bannedCommands.length > 5 ? '...' : ''}`);
    }
    if (isEnabled) {
        await syncSessions();
    }
}

async function handleBackgroundToggle(context) {
    log('Background toggle clicked');

    // Background mode: Check if we should show first-time dialog
    const dontShowAgain = context.globalState.get(BACKGROUND_DONT_SHOW_KEY, false);

    if (!dontShowAgain && !backgroundModeEnabled) {
        // First-time enabling: Show confirmation dialog
        const choice = await vscode.window.showInformationMessage(
            'Turn on Background Mode?\n\n' +
            'This lets Auto Pilot work on all your open chats at once. ' +
            'It will switch between tabs to click Accept for you.\n\n' +
            'You might see tabs change quickly while it works.',
            { modal: true },
            'Enable',
            "Don't Show Again & Enable",
            'Cancel'
        );

        if (choice === 'Cancel' || !choice) {
            log('Background mode cancelled by user');
            return;
        }

        if (choice === "Don't Show Again & Enable") {
            await context.globalState.update(BACKGROUND_DONT_SHOW_KEY, true);
            log('Background mode: Dont show again set');
        }

        // Enable it
        backgroundModeEnabled = true;
        await context.globalState.update(BACKGROUND_MODE_KEY, true);
        log('Background mode enabled');
    } else {
        // Simple toggle
        backgroundModeEnabled = !backgroundModeEnabled;
        await context.globalState.update(BACKGROUND_MODE_KEY, backgroundModeEnabled);
        log(`Background mode toggled: ${backgroundModeEnabled}`);

        // Hide overlay in background if being disabled
        if (!backgroundModeEnabled && cdpHandler) {
            cdpHandler.hideBackgroundOverlay().catch(() => { });
        }
    }

    // Update UI immediately
    updateStatusBar();

    // Sync sessions in background (don't block)
    if (isEnabled) {
        syncSessions().catch(() => { });
    }
}



async function syncSessions() {
    if (cdpHandler && !isLockedOut) {
        log(`CDP: Syncing sessions (Mode: ${backgroundModeEnabled ? 'Background' : 'Simple'})...`);
        try {
            await cdpHandler.start({
                isPro,
                isBackgroundMode: backgroundModeEnabled,
                pollInterval: pollFrequency,
                ide: currentIDE,
                bannedCommands: bannedCommands
            });
        } catch (err) {
            log(`CDP: Sync error: ${err.message}`);
        }
    }
}

async function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    log('Auto Pilot: Monitoring session...');

    // Initial trigger
    await syncSessions();

    // Polling now primarily handles the Instance Lock and ensures CDP is active
    pollTimer = setInterval(async () => {
        if (!isEnabled) return;

        // Check for instance locking - only the first extension instance should control CDP
        const lockKey = `${currentIDE.toLowerCase()}-instance-lock`;
        const activeInstance = globalContext.globalState.get(lockKey);
        const myId = globalContext.extension.id;

        if (activeInstance && activeInstance !== myId) {
            const lastPing = globalContext.globalState.get(`${lockKey}-ping`);
            if (lastPing && (Date.now() - lastPing) < 15000) {
                if (!isLockedOut) {
                    log(`CDP Control: Locked by another instance (${activeInstance}). Standby mode.`);
                    isLockedOut = true;
                    updateStatusBar();
                }
                return;
            }
        }

        // We are the leader or lock is dead
        globalContext.globalState.update(lockKey, myId);
        globalContext.globalState.update(`${lockKey}-ping`, Date.now());

        if (isLockedOut) {
            log('CDP Control: Lock acquired. Resuming control.');
            isLockedOut = false;
            updateStatusBar();
        }

        await syncSessions();
    }, 5000);
}

async function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    if (statsCollectionTimer) {
        clearInterval(statsCollectionTimer);
        statsCollectionTimer = null;
    }
    if (cdpHandler) await cdpHandler.stop();
    log('Auto Accept: Polling stopped');
}

// --- ROI Stats Collection ---

function getWeekStart() {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday
    const diff = now.getDate() - dayOfWeek;
    const weekStart = new Date(now.setDate(diff));
    weekStart.setHours(0, 0, 0, 0);
    return weekStart.getTime();
}

async function loadROIStats(context) {
    const defaultStats = {
        weekStart: getWeekStart(),
        clicksThisWeek: 0,
        blockedThisWeek: 0,
        sessionsThisWeek: 0
    };

    let stats = context.globalState.get(ROI_STATS_KEY, defaultStats);

    // Check if we need to reset for a new week
    const currentWeekStart = getWeekStart();
    if (stats.weekStart !== currentWeekStart) {
        log(`ROI Stats: New week detected. Showing summary and resetting.`);

        // Show weekly summary notification if there were meaningful stats
        if (stats.clicksThisWeek > 0) {
            await showWeeklySummaryNotification(context, stats);
        }

        // Reset for new week
        stats = { ...defaultStats, weekStart: currentWeekStart };
        await context.globalState.update(ROI_STATS_KEY, stats);
    }

    return stats;
}

async function showWeeklySummaryNotification(context, lastWeekStats) {
    const timeSavedSeconds = lastWeekStats.clicksThisWeek * SECONDS_PER_CLICK;
    const timeSavedMinutes = Math.round(timeSavedSeconds / 60);

    let timeStr;
    if (timeSavedMinutes >= 60) {
        timeStr = `${(timeSavedMinutes / 60).toFixed(1)} hours`;
    } else {
        timeStr = `${timeSavedMinutes} minutes`;
    }

    const message = `📊 Last week, Auto Accept saved you ${timeStr} by auto-clicking ${lastWeekStats.clicksThisWeek} buttons!`;

    let detail = '';
    if (lastWeekStats.sessionsThisWeek > 0) {
        detail += `Recovered ${lastWeekStats.sessionsThisWeek} stuck sessions. `;
    }
    if (lastWeekStats.blockedThisWeek > 0) {
        detail += `Blocked ${lastWeekStats.blockedThisWeek} dangerous commands.`;
    }

    const choice = await vscode.window.showInformationMessage(
        message,
        { detail: detail.trim() || undefined },
        'View Details'
    );

    if (choice === 'View Details') {
        const panel = getSettingsPanel();
        if (panel) {
            panel.createOrShow(context.extensionUri, context);
        }
    }
}

// --- SESSION SUMMARY NOTIFICATION ---
// Called when user finishes a session (e.g., leaves conversation view)
async function showSessionSummaryNotification(context, summary) {
    log(`[Notification] showSessionSummaryNotification called with: ${JSON.stringify(summary)}`);
    if (!summary || summary.clicks === 0) {
        log(`[Notification] Session summary skipped: no clicks`);
        return;
    }
    log(`[Notification] Showing session summary for ${summary.clicks} clicks`);

    const lines = [
        `✅ This session:`,
        `• ${summary.clicks} actions auto-accepted`,
        `• ${summary.terminalCommands} terminal commands`,
        `• ${summary.fileEdits} file edits`,
        `• ${summary.blocked} interruptions blocked`
    ];

    if (summary.estimatedTimeSaved) {
        lines.push(`\n⏱ Estimated time saved: ~${summary.estimatedTimeSaved} minutes`);
    }

    const message = lines.join('\n');

    vscode.window.showInformationMessage(
        `🤖 Auto Accept: ${summary.clicks} actions handled this session`,
        { detail: message },
        'View Stats'
    ).then(choice => {
        if (choice === 'View Stats') {
            const panel = getSettingsPanel();
            if (panel) panel.createOrShow(context.extensionUri, context);
        }
    });
}

// --- "AWAY" ACTIONS NOTIFICATION ---
// Called when user returns after window was minimized/unfocused
async function showAwayActionsNotification(context, actionsCount) {
    log(`[Notification] showAwayActionsNotification called with: ${actionsCount}`);
    if (!actionsCount || actionsCount === 0) {
        log(`[Notification] Away actions skipped: count is 0 or undefined`);
        return;
    }
    log(`[Notification] Showing away actions notification for ${actionsCount} actions`);

    const message = `🚀 Auto Accept handled ${actionsCount} action${actionsCount > 1 ? 's' : ''} while you were away.`;
    const detail = `Agents stayed autonomous while you focused elsewhere.`;

    vscode.window.showInformationMessage(
        message,
        { detail },
        'View Dashboard'
    ).then(choice => {
        if (choice === 'View Dashboard') {
            const panel = getSettingsPanel();
            if (panel) panel.createOrShow(context.extensionUri, context);
        }
    });
}

// Background upsell removed — community fork, all features unlocked
async function showBackgroundModeUpsell(context) {
    return; // No-op: all features free
}

// --- AWAY MODE POLLING ---
// Check for "away actions" when user returns (called periodically)
let lastAwayCheck = Date.now();
async function checkForAwayActions(context) {
    log(`[Away] checkForAwayActions called. cdpHandler=${!!cdpHandler}, isEnabled=${isEnabled}`);
    if (!cdpHandler || !isEnabled) {
        log(`[Away] Skipping check: cdpHandler=${!!cdpHandler}, isEnabled=${isEnabled}`);
        return;
    }

    try {
        log(`[Away] Calling cdpHandler.getAwayActions()...`);
        const awayActions = await cdpHandler.getAwayActions();
        log(`[Away] Got awayActions: ${awayActions}`);
        if (awayActions > 0) {
            log(`[Away] Detected ${awayActions} actions while user was away. Showing notification...`);
            await showAwayActionsNotification(context, awayActions);
        } else {
            log(`[Away] No away actions to report`);
        }
    } catch (e) {
        log(`[Away] Error checking away actions: ${e.message}`);
    }
}

async function collectAndSaveStats(context) {
    if (!cdpHandler) return;

    try {
        // Get stats from browser and reset them
        const browserStats = await cdpHandler.resetStats();

        if (browserStats.clicks > 0 || browserStats.blocked > 0) {
            const currentStats = await loadROIStats(context);
            currentStats.clicksThisWeek += browserStats.clicks;
            currentStats.blockedThisWeek += browserStats.blocked;

            await context.globalState.update(ROI_STATS_KEY, currentStats);
            log(`ROI Stats collected: +${browserStats.clicks} clicks, +${browserStats.blocked} blocked (Total: ${currentStats.clicksThisWeek} clicks, ${currentStats.blockedThisWeek} blocked)`);
        }
    } catch (e) {
        // Silently fail - stats collection should not interrupt normal operation
    }
}

async function incrementSessionCount(context) {
    const stats = await loadROIStats(context);
    stats.sessionsThisWeek++;
    await context.globalState.update(ROI_STATS_KEY, stats);
    log(`ROI Stats: Session count incremented to ${stats.sessionsThisWeek}`);
}

function startStatsCollection(context) {
    if (statsCollectionTimer) clearInterval(statsCollectionTimer);

    // Collect stats every 30 seconds and check for away actions
    statsCollectionTimer = setInterval(() => {
        if (isEnabled) {
            collectAndSaveStats(context);
            checkForAwayActions(context); // Check if user returned from away
        }
    }, 30000);

    log('ROI Stats: Collection started (every 30s)');
}


function updateStatusBar() {
    if (!statusBarItem) return;

    if (isEnabled) {
        let statusText = 'ON';
        let tooltip = `Auto Accept is running.`;
        let bgColor = undefined;
        let icon = '$(check)';

        const cdpConnected = cdpHandler && cdpHandler.getConnectionCount() > 0;

        if (cdpConnected) {
            tooltip += ' (CDP Connected)';
        }

        if (isLockedOut) {
            statusText = 'PAUSED (Multi-window)';
            bgColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            icon = '$(sync~spin)';
        }

        statusBarItem.text = `${icon} Auto Pilot: ${statusText}`;
        statusBarItem.tooltip = tooltip;
        statusBarItem.backgroundColor = bgColor;

        // Show Background Mode toggle when Auto Accept is ON
        if (statusBackgroundItem) {
            if (backgroundModeEnabled) {
                statusBackgroundItem.text = '$(sync~spin) Background: ON';
                statusBackgroundItem.tooltip = 'Background Mode is on. Click to turn off.';
                statusBackgroundItem.backgroundColor = undefined;
            } else {
                statusBackgroundItem.text = '$(globe) Background: OFF';
                statusBackgroundItem.tooltip = 'Click to turn on Background Mode (works on all your chats).';
                statusBackgroundItem.backgroundColor = undefined;
            }
            statusBackgroundItem.show();
        }

    } else {
        statusBarItem.text = '$(circle-slash) Auto Pilot: OFF';
        statusBarItem.tooltip = 'Click to enable Auto Pilot.';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

        // Hide Background Mode toggle when Auto Accept is OFF
        if (statusBackgroundItem) {
            statusBackgroundItem.hide();
        }
    }
}

// Re-implement checkInstanceLock correctly with context
async function checkInstanceLock() {
    if (!globalContext) return true; // Should not happen

    const lockId = globalContext.globalState.get(LOCK_KEY);
    const lastHeartbeat = globalContext.globalState.get(HEARTBEAT_KEY, 0);
    const now = Date.now();

    // 1. If no lock or lock is stale (>10s), claim it
    if (!lockId || (now - lastHeartbeat > 10000)) {
        await globalContext.globalState.update(LOCK_KEY, INSTANCE_ID);
        await globalContext.globalState.update(HEARTBEAT_KEY, now);
        return true;
    }

    // 2. If we own the lock, update heartbeat
    if (lockId === INSTANCE_ID) {
        await globalContext.globalState.update(HEARTBEAT_KEY, now);
        return true;
    }

    // 3. Someone else owns the lock and it's fresh
    return false;
}

// verifyLicense removed — community fork, no license server

// handleProActivation removed — community fork

async function showVersionNotification(context) {
    // Check if 8.6.0 notification has been shown
    const hasShown8_6 = context.globalState.get(VERSION_8_6_0_KEY, false);
    if (!hasShown8_6) {
        // Show 8.6.0 notification
        const title = "🚀 What's new in Auto Accept 8.6.0";
        const body = `Simpler setup. More control.

✅ Manual CDP Setup — Platform-specific scripts give you full control over shortcut configuration

📋 Copy-to-Clipboard — Easy script transfer to your terminal

🔧 Platform Support — Windows PowerShell, macOS Terminal, and Linux Bash scripts

🛡️ Enhanced Security — No automatic file modification, you run scripts when ready

⚡ Same Great Features — All the Auto Accept functionality you love, now with clearer setup`;
        const btnDashboard = "View Dashboard";
        const btnGotIt = "Got it";

        // Mark as shown immediately to prevent loops/multiple showings
        await context.globalState.update(VERSION_8_6_0_KEY, true);

        const selection = await vscode.window.showInformationMessage(
            `${title}\n\n${body}`,
            { modal: true },
            btnGotIt,
            btnDashboard
        );

        if (selection === btnDashboard) {
            const panel = getSettingsPanel();
            if (panel) panel.createOrShow(context.extensionUri, context);
        }
        return;
    }

    // Legacy: Check if 7.0 notification has been shown (for backward compatibility)
    const hasShown7_0 = context.globalState.get(VERSION_7_0_KEY, false);
    if (hasShown7_0) return;

    // Show 7.0 notification (only for users who haven't seen any notification)
    const title = "🚀 What's new in Auto Accept 7.0";
    const body = `Smarter. Faster. More reliable.

✅ Smart Away Notifications — Get notified only when actions happened while you were truly away.

📊 Session Insights — See exactly what happened when you turn off Auto Accept: file edits, terminal commands, and blocked interruptions.

⚡ Improved Background Mode — Faster, more reliable multi-chat handling.

🛡️ Enhanced Stability — Complete analytics rewrite for rock-solid tracking.`;
    const btnDashboard = "View Dashboard";
    const btnGotIt = "Got it";

    // Mark as shown immediately to prevent loops/multiple showings
    await context.globalState.update(VERSION_7_0_KEY, true);

    const selection = await vscode.window.showInformationMessage(
        `${title}\n\n${body}`,
        { modal: true },
        btnGotIt,
        btnDashboard
    );

    if (selection === btnDashboard) {
        const panel = getSettingsPanel();
        if (panel) panel.createOrShow(context.extensionUri, context);
    }
}


function deactivate() {
    stopPolling();
    if (cdpHandler) {
        cdpHandler.stop();
    }
}

module.exports = { activate, deactivate };
