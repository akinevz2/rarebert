import { defineConfig } from "@bunli/core";

import config from "./package.json";

const { name, version } = config;

export default defineConfig({
    name,
    version,
    description: config.description,
    // Commands are registered programmatically by launch.ts from the
    // discovered scripts/ modules (the Bunli directory-scan/generator
    // cannot parse Module-instance default exports — do not re-add
    // commands.directory).
});