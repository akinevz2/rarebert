class ExitSignal {
    constructor(code) {
        this.code = code;
    }
}

class HelpRequestedSignal extends Error {
    constructor() {
        super('Help requested');
        this.name = 'HelpRequestedSignal';
    }
}

function exit(code = 0) {
    return new ExitSignal(code);
}

export { ExitSignal, HelpRequestedSignal, exit };
export default { ExitSignal, HelpRequestedSignal, exit };
