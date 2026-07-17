// Import xterm.js modules
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

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

// Pipeline data structure, should be loaded from a JSON file in final build
const pipelineData = {
  "pipeline": [
    {
      "module": "data-loader",
      "runtime": "python",
      "args": {
        "training": true
      },
      "printout": "Load training dataset from TSV files"
    },
    {
      "module": "tokeniser",
      "runtime": "python",
      "args": {},
      "printout": "Split text into tokens for span analysis"
    },
    {
      "module": "feature-extractor",
      "runtime": "python",
      "args": {
        "window_size": 5,
        "include_ngrams": true
      },
      "printout": "Extract string-level features from candidate spans"
    },
    {
      "module": "classifier",
      "runtime": "java",
      "args": {
        "algorithm": "coevolution",
        "classes": 10
      },
      "printout": "Apply coevolutionary rules and perceptrons to classify spans"
    },
    {
      "module": "evaluator",
      "runtime": "python",
      "args": {
        "metric": "f1_score",
        "threshold": 0.5
      },
      "printout": "Compare predictions against gold labels for evaluation"
    }
  ],
  "metadata": {
    "version": "1.0",
    "created_at": "2026-07-17",
    "description": "Propaganda detection pipeline using genetic coevolution approach"
  }
};

// Set up controls
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const clearBtn = document.getElementById('clearBtn');
const statusSpan = document.getElementById('status');

let watchInterval = null;
let currentPipelineIndex = 0;

// Function to display pipeline information
function displayPipelineInfo() {
    term.clear();
    term.writeln('\x1b[36m=== NLP Pipeline Information ===\x1b[0m');
    term.writeln('\x1b[32mVersion:\x1b[0m ' + pipelineData.metadata.version);
    term.writeln('\x1b[32mCreated at:\x1b[0m ' + pipelineData.metadata.created_at);
    term.writeln('\x1b[32mDescription:\x1b[0m ' + pipelineData.metadata.description);
    term.writeln('\x1b[36m==============================\x1b[0m');
    term.writeln('\x1b[34mTotal stages: ' + pipelineData.pipeline.length + '\x1b[0m');
    
    // Display all stages
    pipelineData.pipeline.forEach((stage, index) => {
        term.writeln('\x1b[35mStage ' + (index + 1) + ':\x1b[0m ' + stage.module);
        term.writeln('  \x1b[32mRuntime:\x1b[0m ' + stage.runtime);
        term.writeln('  \x1b[32mDescription:\x1b[0m ' + stage.printout);
    });
    
    term.writeln('\x1b[36m================================\x1b[0m');
}

// Function to display current pipeline stage
function displayCurrentStage(index) {
    if (index >= pipelineData.pipeline.length) return;
    
    const stage = pipelineData.pipeline[index];
    
    term.clear();
    term.writeln('\x1b[36m=== Pipeline Stage ' + (index + 1) + ' ===\x1b[0m');
    term.writeln('\x1b[32mModule:\x1b[0m ' + stage.module);
    term.writeln('\x1b[32mRuntime:\x1b[0m ' + stage.runtime);
    term.writeln('\x1b[32mDescription:\x1b[0m ' + stage.printout);
    
    if (Object.keys(stage.args).length > 0) {
        term.writeln('\x1b[32mArguments:\x1b[0m');
        for (const [key, value] of Object.entries(stage.args)) {
            term.writeln('  \x1b[33m' + key + ': ' + JSON.stringify(value) + '\x1b[0m');
        }
    }
    
    term.writeln('\x1b[36m=========================\x1b[0m');
}

// Start watching the pipeline
function startWatching() {
    if (watchInterval) return; // Already running
    
    currentPipelineIndex = 0;
    displayCurrentStage(currentPipelineIndex);
    
    watchInterval = setInterval(() => {
        currentPipelineIndex++;
        if (currentPipelineIndex < pipelineData.pipeline.length) {
            displayCurrentStage(currentPipelineIndex);
        } else {
            clearInterval(watchInterval);
            watchInterval = null;
            startBtn.disabled = false;
            stopBtn.disabled = true;
            statusSpan.textContent = 'Status: Completed';
            statusSpan.style.color = '#4caf50';
            term.writeln('\x1b[32mPipeline execution completed!\x1b[0m');
        }
    }, 2000); // Move to next stage every 2 seconds
    
    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusSpan.textContent = 'Status: Running Pipeline';
    statusSpan.style.color = '#4caf50';
}

// Stop watching the pipeline
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
    currentPipelineIndex = 0;
    term.writeln('Terminal cleared. Use "Start Pipeline" to view pipeline stages.');
}

// Set up event listeners
startBtn.addEventListener('click', startWatching);
stopBtn.addEventListener('click', stopWatching);
clearBtn.addEventListener('click', clearTerminal);

// Initial setup
term.writeln('NLP Pipeline Viewer Initialized');
term.writeln('This application visualizes the propaganda detection pipeline.');
term.writeln('');
displayPipelineInfo();
term.writeln('');
term.writeln('Press "Start Pipeline" to begin viewing the pipeline stages.');
term.writeln('');