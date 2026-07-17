// Import xterm.js modules
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const pipeline = new Pipeline({
    "file": "./pipeline.json",
})

// Create terminal instance
const term = new Terminal({
    cols: 120,
    rows: 30,
    fontSize: 14,
    fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
    theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4'
    }
});

// Create fit addon and apply it
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

// Attach terminal to DOM element
const terminalContainer = document.getElementById('terminal');
term.open(terminalContainer);
fitAddon.fit();

// Set up controls
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const clearBtn = document.getElementById('clearBtn');
const statusSpan = document.getElementById('status');

let watchInterval = null;
let logContent = '';

// Function to update the terminal with new content
function updateTerminal(content) {
    // Clear terminal
    term.clear();
    
    // Add content line by line
    const lines = content.split('\n').filter(line => line.trim() !== '');
    lines.forEach(line => {
        // Parse and color code different parts of the log entry
        if (line.includes('make ')) {
            // Color make commands
            term.writeln('\x1b[36m' + line + '\x1b[0m'); // Cyan for make commands
        } else if (line.includes('ERROR')) {
            // Color error messages
            term.writeln('\x1b[31m' + line + '\x1b[0m'); // Red for errors
        } else if (line.includes('SUCCESS')) {
            // Color success messages
            term.writeln('\x1b[32m' + line + '\x1b[0m'); // Green for success
        } else if (line.includes('INFO')) {
            // Color info messages
            term.writeln('\x1b[34m' + line + '\x1b[0m'); // Blue for info
        } else if (line.includes('[DEBUG]')) {
            // Color debug messages
            term.writeln('\x1b[35m' + line + '\x1b[0m'); // Magenta for debug
        } else {
            // Regular content
            term.writeln(line);
        }
    });
}

// Function to read and display log file content
function refreshLog() {
    try {
        // In a real implementation, we would fetch from the actual log file
        // For now, let's simulate reading from the .log file in the rarebert directory
        
        const fs = require('fs');
        const path = require('path');
        
        const logPath = path.join('/workspaces/development/personal/rarebert/.log');
        
        if (fs.existsSync(logPath)) {
            const content = fs.readFileSync(logPath, 'utf8');
            
            // Only update if content changed
            if (content !== logContent) {
                logContent = content;
                updateTerminal(content);
            }
        } else {
            // If no log file exists, show a message
            term.clear();
            term.writeln('\x1b[33mNo log file found at ' + logPath + '\x1b[0m');
        }
    } catch (error) {
        console.error('Error reading log file:', error);
        term.writeln('\x1b[31mError reading log file: ' + error.message + '\x1b[0m');
    }
}

// Start watching the log
function startWatching() {
    if (watchInterval) return; // Already running
    
    refreshLog(); // Initial load
    watchInterval = setInterval(refreshLog, 1000); // Refresh every second
    
    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusSpan.textContent = 'Status: Watching';
    statusSpan.style.color = '#4caf50';
}

// Stop watching the log
function stopWatching() {
    if (watchInterval) {
        clearInterval(watchInterval);
        watchInterval = null;
        
        startBtn.disabled = false;
        stopBtn.disabled = true;
        statusSpan.textContent = 'Status: Stopped';
        statusSpan.style.color = '#f44336';
    }
}

// Clear the terminal
function clearTerminal() {
    term.clear();
    logContent = '';
}

// Set up event listeners
startBtn.addEventListener('click', startWatching);
stopBtn.addEventListener('click', stopWatching);
clearBtn.addEventListener('click', clearTerminal);

// Initial setup
term.writeln('NLP Pipeline Viewer Initialized');
term.writeln('Press "Start Watching" to begin monitoring the pipeline logs.');
term.writeln('');

// If you want to test without running a server, uncomment this line:
// startWatching();