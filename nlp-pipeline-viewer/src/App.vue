<script setup lang="ts">
// Import xterm.js modules
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
// Import CSS directly - this is the recommended approach for Vite/Vue projects
import "xterm/css/xterm.css";
import { ref, onMounted, watch, nextTick, onUnmounted, reactive } from "vue";

// Define types for our pipeline data (matching pipeline.json structure)
interface PipelineStage {
  module: string;
  runtime: string;
  printout?: string;
  args?: Record<string, unknown>;
}

interface PipelineData {
  stages: PipelineStage[];
  metadata?: {
    version?: string;
    created_at?: string;
    description?: string;
  };
}

const terminalRef = ref<HTMLElement | null>(null);
const terminal = ref<Terminal | null>(null);
const pipelineData = ref<PipelineData | null>(null);
const currentStageIndex = ref(0);
const isPlaying = ref(false);
const isComplete = ref(false);
const isLoading = ref(true);

// State for stage printing behavior
const printState = reactive({
  lines: [] as string[],
  currentIndex: 0,
  isPrinting: false,
  intervalId: null as ReturnType<typeof setInterval> | null,
});

// Watch for terminal resize
onUnmounted(() => {
  if (terminal.value) {
    terminal.value.dispose();
  }
});

// Load pipeline data on mount
onMounted(async () => {
  try {
    const response = await fetch("/pipeline.json");
    const data: PipelineData = await response.json();
    pipelineData.value = data;
    isLoading.value = false;
  } catch (error) {
    console.error("Failed to load pipeline data:", error);
    isLoading.value = false;
  }
});

// Initialize terminal once when pipelineData is loaded
watch(
  [() => pipelineData.value, () => terminal.value],
  async ([data]) => {
    // Only initialize if not already initialized and we have data
    if (!terminalRef.value || !data || terminal.value) return;

    await nextTick();

    const newTerminal = new Terminal({
      rows: 24,
      cols: 80,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    newTerminal.loadAddon(fitAddon);
    // Cast to HTMLElement for Vue template ref compatibility
    newTerminal.open(terminalRef.value as unknown as HTMLElement);
    fitAddon.fit();

    terminal.value = newTerminal;
    isPlaying.value = true;
  },
  { immediate: false },
);

const getPipelineOutputLines = (stage: PipelineStage): string[] => {
  const outputLines: string[] = [];

  // Add the module name as header
  outputLines.push(`=== ${stage.module} ===`);

  if (stage.printout) {
    outputLines.push(stage.printout);
  }

  if (stage.args && Object.keys(stage.args).length > 0) {
    const argsStr = JSON.stringify(stage.args, null, 2);
    outputLines.push(`Arguments: ${argsStr}`);
  }

  return outputLines;
};

// Start printing lines one by one for a stage
const startStagePrinting = (stageIndex: number) => {
  if (!terminal.value || !pipelineData.value) return;

  const currentStage = pipelineData.value.stages[stageIndex];
  if (!currentStage) return;

  printState.lines = getPipelineOutputLines(currentStage);
  printState.currentIndex = 0;
  printState.isPrinting = true;

  // Clear terminal for new stage output (but don't replace lines during printing)
  terminal.value.clear();

  const interval = setInterval(() => {
    if (printState.currentIndex < printState.lines.length) {
      terminal.value!.writeln(printState.lines[printState.currentIndex]);
      printState.currentIndex++;

      // Scroll to bottom
      terminal.value!.scrollToBottom();
    } else {
      clearInterval(interval);
      printState.isPrinting = false;
    }
  }, 600); // 600ms per line

  printState.intervalId = interval;
};

// Stop the current printing interval
const stopStagePrinting = () => {
  if (printState.intervalId) {
    clearInterval(printState.intervalId);
    printState.intervalId = null;
  }
  printState.isPrinting = false;
};

// Watch for stage index changes to display output
watch(
  () => currentStageIndex.value,
  async (index) => {
    if (!terminal.value || !pipelineData.value || isComplete.value) return;

    stopStagePrinting();

    const currentStage = pipelineData.value.stages[index];
    if (!currentStage) {
      isComplete.value = true;
      return;
    }

    startStagePrinting(index);
  },
  { immediate: false, deep: true },
);

// Initialize the first stage when data loads
watch(
  () => pipelineData.value?.stages.length,
  (length) => {
    if (
      length &&
      length > 0 &&
      currentStageIndex.value === 0 &&
      !isComplete.value
    ) {
      // First stage will be started by the watch above
    }
  },
  { immediate: false },
);

const handleInitialize = () => {
  // If complete and button says "Reload", reload the page
  if (isComplete.value) {
    window.location.reload();
    return;
  }

  // Reset everything to initial state
  if (terminal.value) {
    terminal.value.dispose();
  }

  currentStageIndex.value = 0;
  isComplete.value = false;
  isPlaying.value = false;

  // Reinitialize terminal
  nextTick(() => {
    if (terminalRef.value && pipelineData.value) {
      const newTerminal = new Terminal({
        rows: 24,
        cols: 80,
        convertEol: true,
      });

      const fitAddon = new FitAddon();
      newTerminal.loadAddon(fitAddon);
      newTerminal.open(terminalRef.value as unknown as HTMLElement);
      fitAddon.fit();

      terminal.value = newTerminal;

      // Start printing first stage
      startStagePrinting(0);
    }
  });
};

const handleContinue = () => {
  if (!pipelineData.value || isComplete.value) return;

  stopStagePrinting();

  const stages = pipelineData.value.stages;

  if (currentStageIndex.value < stages.length - 1) {
    currentStageIndex.value++;
  } else {
    // Show final completion message with metadata
    if (terminal.value && pipelineData.value) {
      terminal.value.clear();
      terminal.value.writeln("=== Pipeline Complete ===");

      if (pipelineData.value.metadata?.description) {
        terminal.value.writeln(pipelineData.value.metadata.description);
      }

      isComplete.value = true;
    }
  }
};

const handleSkip = () => {
  if (!terminal.value || !pipelineData.value) return;

  // Print all lines at once and scroll to bottom
  const currentStage = pipelineData.value.stages[currentStageIndex.value];
  if (currentStage && printState.isPrinting) {
    stopStagePrinting();
    terminal.value.clear();

    const outputLines = getPipelineOutputLines(currentStage);
    outputLines.forEach((line) => {
      terminal.value!.writeln(line);
    });
    terminal.value.scrollToBottom();
  }
};
</script>

<template>
  <div class="app">
    <div ref="terminalRef" style="height: 500px"></div>

    <div class="button-container" style="margin-top: 10px">
      <!-- Initialize/Reset button -->
      <button
        @click="handleInitialize"
        :disabled="!pipelineData || isComplete"
        style="margin-right: 10px; padding: 8px 16px"
      >
        {{
          !pipelineData ? "Initializing..." : isComplete ? "Reload" : "Reset"
        }}
      </button>

      <!-- Continue button - disabled while printing -->
      <button
        @click="handleContinue"
        :disabled="printState.isPrinting || isComplete"
        style="margin-right: 10px; padding: 8px 16px"
      >
        Continue
      </button>

      <!-- Skip button - always available when stage is running -->
      <button
        @click="handleSkip"
        :disabled="
          !printState.isPrinting ||
          currentStageIndex >= (pipelineData?.stages.length || 0) - 1
        "
        style="padding: 8px 16px"
      >
        Skip
      </button>
    </div>

    <div
      v-if="isComplete && pipelineData"
      style="margin-top: 10px; color: green"
    >
      Pipeline execution completed!
    </div>
  </div>
</template>

<style scoped>
.app {
  padding: 20px;
}

.button-container button:not(:disabled) {
  cursor: pointer;
}

.button-container button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
