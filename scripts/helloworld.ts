#!/usr/bin/env node

import { defineCommand } from "@bunli/core";

export default defineCommand({
    name: "helloworld",
    description: "A hello world command using bunli",
    handler: async () => {
        console.log("Hello from helloworld.ts - bunli command working!");
    }
});