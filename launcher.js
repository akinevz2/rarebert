#!/usr/bin/env node
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get command line arguments
const args = global.process.argv.slice(2);
let rumshellPath = null;
let remainingArgs = [];

// Parse --rumshell=PATH argument or first non-flag argument
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--rumshell=')) {
    rumshellPath = args[i].replace('--rumshell=', '');
  } else if (!args[i].startsWith('-')) {
    if (!rumshellPath) {
      rumshellPath = args[i];
    }
    remainingArgs = remainingArgs.concat(args.slice(i + 1));
    break;
  }
}

function findRumshellBinary() {
  // Check if path was explicitly provided
  if (rumshellPath) {
    try {
      const resolvedPath = path.resolve(rumshellPath);
      
      if (global.process.platform === 'win32') {
        const exePath = resolvedPath.endsWith('.exe') 
          ? resolvedPath 
          : resolvedPath + '.exe';
        
        try {
          spawnSync(exePath, { detached: false }, { stdio: 'ignore' });
          return exePath;
        } catch (error) {
          // Binary exists but doesn't work - return path anyway
          return exePath;
        }
      }
      
      try {
        spawnSync(resolvedPath, { detached: false }, { stdio: 'ignore' });
        return resolvedPath;
      } catch (error) {
        return resolvedPath;
      }
    } catch (error) {
      return null;
    }
  }

  // Check default locations relative to launcher location
  const relativeLocations = [
    'target/release/rumshell.exe',
    'rumshell.exe',
    '../rumshell/rumshell.exe',
    '../../rumshell/rumshell.exe',
    'dist/rumshell.exe'
  ];

  // Try all locations
  for (const location of relativeLocations) {
    try {
      const resolvedPath = path.join(__dirname, location);
      
      if (global.process.platform === 'win32') {
        const exePath = resolvedPath.endsWith('.exe') 
          ? resolvedPath 
          : resolvedPath + '.exe';
        
        try {
          spawnSync(exePath, { detached: false }, { stdio: 'ignore' });
          return exePath;
        } catch (error) {
          return exePath;
        }
      }
      
      try {
        spawnSync(resolvedPath, { detached: false }, { stdio: 'ignore' });
        return resolvedPath;
      } catch (error) {
        return resolvedPath;
      }
    } catch (error) {}
  }

  return null;
}

async function runRumshell() {
  const globalProcess = global.process;
  const rumshellBin = findRumshellBinary();

  if (!rumshellBin) {
    console.error('Error: Could not find rumshell binary');
    console.error('Please specify rumshell path with --rumshell=<path>');
    console.error('\nUsage:');
    console.error('  node launcher.js --rumshell=<path> [command...]');
    console.error('\nExample:');
    console.error('  node launcher.js --rumshell=target/release/rumshell.exe run test.rum');
    globalProcess.exit(1);
  }

  const commandArgs = remainingArgs.length > 0 ? remainingArgs : [];

  console.log(`Launching: ${rumshellBin}`);
  console.log(`Arguments: ${commandArgs.join(' ')}`);

  try {
    const rumshellProcess = spawn(rumshellBin, commandArgs, {
      stdio: 'inherit',
      shell: globalProcess.platform === 'win32'
    });

    rumshellProcess.on('error', (error) => {
      console.error('Error launching rumshell:', error);
      globalProcess.exit(1);
    });

    rumshellProcess.on('exit', (code) => {
      globalProcess.exit(code ?? 1);
    });
  } catch (error) {
    console.error('Failed to start rumshell:', error);
    globalProcess.exit(1);
  }
}

// Run the script
runRumshell().catch(error => {
  console.error('Script error:', error);
  global.process.exit(1);
});