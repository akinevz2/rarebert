// Proposed Runtime class implementation
//
// Shape:
//   constructor(module)             — accepts a Module instance
//   async execute(args = [])        — calls module.execute(args), inspects the ExitSignal,
//                                     calls complete() which may return a Module for re-execution (loops),
//                                     displays producedResult, and returns exitCode (a number).
//                                     Does NOT call process.exit().
//
class Runtime {
    constructor(module) {
        this.module = module;
    }

    async execute(args = []) {
        for (;;) {
            const result = await this.module.execute(args);
            const completed = await result.complete();

            if (completed && typeof completed.execute === 'function') {
                // complete() returned a Module — re-run it with empty args
                this.module = completed;
                args = [];
                continue;
            }

            const { exitCode, producedValue } = completed;

            if (producedValue !== undefined && producedValue !== null) {
                if (exitCode === 0) {
                    console.dir(producedValue);
                } else {
                    console.error(producedValue);
                }
            }

            return exitCode;
        }
    }
}

export default Runtime;
