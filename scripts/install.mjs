#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { home } from '../lib/projects.mjs';
import { Module } from '../lib/modules.mjs';
import { cli } from '../lib/cli.mjs';
import { backend } from '../lib/backend.mjs';

const DEFAULT_PREFIX = path.join(os.homedir(), '.local', 'rarebert');
const DEFAULT_BIN_DIR = path.join(os.homedir(), '.local', 'bin');
const IS_WIN = process.platform === 'win32';
const NPM_BIN = IS_WIN ? 'npm' : 'npm';
const CARGO_BIN = IS_WIN ? 'cargo' : 'cargo';

function getCargoHome() {
    const cargoHome = process.env.CARGO_HOME;
    return cargoHome ? path.resolve(cargoHome) : path.join(os.homedir(), '.cargo');
}

function getTargetDirectory() {
    const customTargetDir = process.env.CARGO_TARGET_DIR;
    if (customTargetDir) {
        return path.resolve(customTargetDir);
    }

    const cargoHome = getCargoHome();
    const cargoConfig = path.join(cargoHome, 'config.toml');
    if (fs.existsSync(cargoConfig)) {
        const configContent = fs.readFileSync(cargoConfig, 'utf8');
        const targetMatch = configContent.match(/\[target\.([\w\-]+)\]\s*target-dir\s*=\s*"([^"]+)"\s*/);
        if (targetMatch) {
            return path.resolve(targetMatch[2]);
        }
    }

    const defaultConfig = path.join(cargoHome, 'config.toml');
    if (fs.existsSync(defaultConfig)) {
        const configContent = fs.readFileSync(defaultConfig, 'utf8');
        const globalMatch = configContent.match(/^target-directory\s*=\s*"([^"]+)"\s*$/m);
        if (globalMatch) {
            return path.resolve(globalMatch[1]);
        }
    }

    return path.join(home.root, 'target');
}

function getBinaryLocation() {
    const targetDir = getTargetDirectory();
    const exeExt = IS_WIN ? '.exe' : '';
    const defaultBinPath = path.join(targetDir, 'release', `rumshell${exeExt}`);

    if (fs.existsSync(defaultBinPath)) {
        return defaultBinPath;
    }

    const cargoHome = getCargoHome();
    const metadataBinPath = path.join(cargoHome, 'bin', 'rumshell' + exeExt);
    if (fs.existsSync(metadataBinPath)) {
        return metadataBinPath;
    }

    const defaultConfigDir = path.join(home.root, 'target');
    if (fs.existsSync(defaultConfigDir)) {
        const binaries = fs.readdirSync(defaultConfigDir, { withFileTypes: true })
            .filter(d => d.isFile() && (d.name.endsWith(exeExt) || d.name.includes('rumshell')))
            .map(d => path.join(defaultConfigDir, d.name));
        
        if (binaries.length > 0) {
            return binaries[0];
        }
    }

    return defaultBinPath;
}

function getRustTargetTriple() {
    const customTarget = process.env.CARGO_TARGET;
    if (customTarget) return customTarget;

    const cargoHome = getCargoHome();
    const cargoConfig = path.join(cargoHome, 'config.toml');
    if (fs.existsSync(cargoConfig)) {
        const configContent = fs.readFileSync(cargoConfig, 'utf8');
        const targetMatch = configContent.match(/\[target\.([\w\-]+)\]/m);
        if (targetMatch) {
            return targetMatch[1];
        }
    }

    return IS_WIN ? 'x86_64-pc-windows-gnu' : 'x86_64-unknown-linux-gnu';
}

const meta = {
    name: 'install',
    description: `Install rarebert: uses cargo's target directory and symlinks to cargo's bin directory. npm prefix defaults to ${DEFAULT_PREFIX}, binary symlinked into ${DEFAULT_BIN_DIR}. Supports CARGO_HOME and CARGO_TARGET_DIR environment variables.`,
    usage: 'node index.js install [--prefix <dir>] [--bin-dir <dir>] [--force]',
    options: [
        { flag: '--prefix <dir>', description: 'npm prefix to install into' },
        {
            flag: '--bin-dir <dir>',
            description: 'directory for the rarebert and rumshell symlinks (default: ~/.local/bin)'
        },
        { flag: '--force', description: 'overwrite an existing prefix directory' }
    ]
};

function resolvePrefix(opts) {
    if (opts.prefix) return path.resolve(opts.prefix);
    return DEFAULT_PREFIX;
}

function resolveBinDir(opts) {
    if (opts.binDir) return path.resolve(opts.binDir);
    return DEFAULT_BIN_DIR;
}

function linkBinary(binSrc, binDir, name) {
    fs.mkdirSync(binDir, { recursive: true });
    const linkPath = path.join(binDir, name);
    const exeExt = process.platform === 'win32' ? '.exe' : '';

    if (fs.existsSync(linkPath) || fs.existsSync(linkPath + exeExt) || fs.isSymbolicLinkSync?.(linkPath)) {
        try { fs.unlinkSync(linkPath); } catch {}
        try { fs.unlinkSync(linkPath + exeExt); } catch {}
    }

    if (process.platform === 'win32') {
        fs.copyFileSync(binSrc, linkPath + exeExt);
    } else {
        fs.symlinkSync(binSrc, linkPath);
    }
    return linkPath;
}

function buildRumshell() {
    console.log('install: building rumshell (cargo build --release)...');
    const targetTriple = getRustTargetTriple();
    
    const cargoArgs = ['build', '--release'];
    if (process.env.CARGO_TARGET_DIR) {
        cargoArgs.push('--target-dir', process.env.CARGO_TARGET_DIR);
    }
    if (process.env.CARGO_TARGET) {
        cargoArgs.push('--target', process.env.CARGO_TARGET);
    }
    
    const result = spawnSync(CARGO_BIN, cargoArgs, {
        cwd: home.root,
        stdio: 'inherit',
        shell: IS_WIN
    });

    if (result.status !== 0) {
        console.error(`install: cargo build exited with status ${result.status ?? 0}`);
        throw new Error('rumshell build failed');
    }

    const rumshellBin = getBinaryLocation();
    
    console.log(`install: rumshell binary located at: ${rumshellBin}`);
    if (!fs.existsSync(rumshellBin)) {
        throw new Error(`rumshell binary not found at ${rumshellBin}`);
    }
    
    return rumshellBin;
}

async function main(opts, positional) {
    const prefix = resolvePrefix(opts);
    const binDir = resolveBinDir(opts);
    const force = !!opts.force;

    if (fs.existsSync(prefix) && !force && fs.readdirSync(prefix).length > 0) {
        const overwrite = await cli.confirm(`Prefix "${prefix}" is non-empty. Continue?`, false);
        if (!overwrite) cli.ok('Not installed.');
    }

    fs.mkdirSync(prefix, { recursive: true });
    console.log(`install: prefix -> ${prefix}`);

    const result = spawnSync(NPM_BIN, ['install', '--prefix', prefix, '--ignore-scripts'], {
        cwd: home.root,
        stdio: 'inherit',
        shell: IS_WIN
    });

    if (result.status !== 0) {
        console.error(`install: npm install exited with status ${result.status ?? 0}`);
        cli.fail('install failed');
    }

    // Symlink rarebert CLI
    const rarebertLink = linkBinary(path.join(home.root, 'index.js'), binDir, 'rarebert');
    console.log(`install: linked rarebert -> ${rarebertLink}`);

    // Build and symlink rumshell Rust binary
    try {
        const rumshellBin = buildRumshell();
        const targetDir = getTargetDirectory();
        const cargoHome = getCargoHome();
        
        console.log(`install: rumshell binary location -> ${rumshellBin}`);
        console.log(`install: cargo home -> ${cargoHome}`);
        console.log(`install: target directory -> ${targetDir}`);
        
        const rumshellLink = linkBinary(rumshellBin, binDir, 'rumshell');
        console.log(`install: linked rumshell -> ${rumshellLink}`);
        
        if (path.dirname(rumshellLink) !== binDir) {
            console.log('Warning: Symlink created at different location than expected binDir');
        }
    } catch (e) {
        console.error(`install: ${e.message}`);
        cli.fail('rumshell build failed, rarebert still installed');
        return;
    }

    if (process.env.PATH?.split(path.delimiter).includes(binDir)) {
        console.log(`'rarebert' and 'rumshell' are on your PATH.`);
    } else {
        console.log(`\nAdd "${binDir}" to your PATH to use 'rarebert' and 'rumshell'.`);
    }

    console.log('\n=== onboarding ===');
    const onboardOk = await backend.ensureConfig();
    if (!onboardOk) {
        console.log('Run `make onboard` to complete configuration later.');
    }

    cli.ok(`Done. Installed to ${prefix}`);
}

export { main, resolvePrefix, DEFAULT_PREFIX };

const module = new Module('install.mjs', main, meta);

export default module;
module.supportsDirectRunning(import.meta.url);
