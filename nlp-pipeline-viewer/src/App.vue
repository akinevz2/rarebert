<!--
  App.vue — thin mount.  All real work lives in:
    * ``ShellClient`` (transport)
    * ``ShellPanel``  (xterm.js UI)
    * ``useGracefulShutdown`` (HMR-driven exit)
-->

<script setup lang="ts">
import ShellPanel from "./shell/ShellPanel.vue";
import { useGracefulShutdown } from "./composables/useGracefulShutdown";

useGracefulShutdown();
</script>

<template>
  <ShellPanel />
</template>

<style>
html,
body,
#app {
  margin: 0;
  padding: 0;
  height: 100%;
  background: #0b1020;
}
</style>
