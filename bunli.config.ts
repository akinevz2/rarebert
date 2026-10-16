import { defineConfig } from "@bunli/core";

import config from "./package.json";

const { name, version } = config;

export default defineConfig({
    name,
    version,
    commands: {
        directory: "./scripts",
    },
});