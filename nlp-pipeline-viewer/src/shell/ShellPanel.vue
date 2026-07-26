<!--
  ShellPanel — xterm.js backed shell panel.

  Owns:
    * one xterm.js ``Terminal`` instance
    * one ``ShellClient`` instance
    * one buffer for the current in-progress line

  Doesn't own:
    * HTTP transport (``ShellClient`` does)
    * session lifecycle (``ShellClient`` does)
    * SSE parsing (lives in ``types.ts``)

  Input handling:
    * ``\r``         submit the buffered command
    * ``\x7f``/``\b`` backspace
    * ``\x03``        cancel the in-flight command, redraw prompt
    * printable      append + echo
-->

<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "xterm/css/xterm.css";
import { onBeforeUnmount, onMounted, ref } from "vue";

import { ShellClient } from "./ShellClient";
import { type ShellFrame } from "./types";

const PROMPT = "\x1b[1;36m$ \x1b[0m";
const BANNER = [
  "\x1b[1;33mrarebert shell\x1b[0m",
  "type a `make` command and press Enter",
  "Ctrl-C cancels the current command",
  "",
].join("\r\n");

const hostRef = ref<HTMLElement | null>(null);
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let client: ShellClient | null = null;
let inputBuffer = "";

function writePrompt(): void {
  term?.write(PROMPT);
}

function renderBanner(): void {
  if (!term) return;
  term.writeln(BANNER);
  writePrompt();
}

function handleAscii(data: string): void {
  if (!term) return;
  for (const ch of data) {
    switch (ch) {
      case "\r":
        term.write("\r\n");
        void runCurrentLine();
        break;
      case "\x7f":
      case "\b":
        if (inputBuffer.length > 0) {
          inputBuffer = inputBuffer.slice(0, -1);
          term.write("\b \b");
        }
        break;
      case "\x03":
        client?.cancel();
        term.write("^C\r\n");
        inputBuffer = "";
        writePrompt();
        break;
      default:
        if (ch >= " " && ch.length === 1) {
          inputBuffer += ch;
          term.write(ch);
        }
    }
  }
}

async function runCurrentLine(): Promise<void> {
  const line = inputBuffer;
  inputBuffer = "";
  if (!client || !term) return;
  if (!line.trim() || line.trim().startsWith("#")) {
    writePrompt();
    return;
  }
  try {
    for await (const frame of client.submit(line)) {
      applyFrame(frame);
    }
  } catch (exc) {
    term.writeln(`\x1b[31merror: ${(exc as Error).message}\x1b[0m`);
  } finally {
    writePrompt();
  }
}

function applyFrame(frame: ShellFrame): void {
  if (!term) return;
  switch (frame.event) {
    case "open":
      // The bridge already echoed the command line; no need to reprint.
      return;
    case "line":
      term.writeln((frame.payload as { line: string }).line);
      return;
    case "bytes": {
      const data = (frame.payload as { data: string }).data;
      try {
        term.write(atob(data));
      } catch {
        term.write(data);
      }
      return;
    }
    case "done":
      return;
  }
}

onMounted(() => {
  if (!hostRef.value) return;
  term = new Terminal({ convertEol: true, cursorBlink: true });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(hostRef.value);
  fit.fit();
  client = new ShellClient();
  term.onData(handleAscii);
  renderBanner();

  window.addEventListener("resize", handleResize);
});

function handleResize(): void {
  fit?.fit();
}

onBeforeUnmount(() => {
  window.removeEventListener("resize", handleResize);
  client?.cancel();
  term?.dispose();
  term = null;
  client = null;
});
</script>

<template>
  <div class="shell-host" ref="hostRef"></div>
</template>

<style scoped>
.shell-host {
  height: calc(100vh - 16px);
  background: #0b1020;
  padding: 8px;
}
</style>
