// Import xterm.js modules
import { useMemo, useEffect, type FunctionComponent } from 'react';
import { Terminal } from '@xterm/xterm';
import { isPipeline, type Pipeline, type PipelineConfig, type PipelineLoader, type PipelineStage, type PipelineStages } from './pipeline-types';
import type { FunctionalComponent } from 'vue';

type Message = Readonly<PipelineStage | { message: string | Message }>;

const flushErrorToTerminal = (term: Terminal, error: any) => {
    try {
        term.writeln('\x1b[31mError: ' + error.message + '\x1b[0m');
        if (error.stack) {
            term.writeln('\x1b[31mStack Trace:\x1b[0m');
            term.writeln('\x1b[31m' + error.stack + '\x1b[0m');
        }
    } catch (error) {
        window.alert('An error occurred(please see console): ' + ((error instanceof Error) ? error.message : 'Unknown error'));
    }
    finally {
        console.error('Error:', error.message);
    }
    console.error('Failed to flush error to terminal:', error);
    return error;
}

const performPipelineErrorDisplay = (errorMessage: string) => (<pre>{errorMessage}</pre>)

// Create terminal instance
export const globalTerm = new Terminal({
    cols: 120,
    rows: 30,
    fontSize: 14,
    fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
    theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4'
    }
});

// load the pipeline configuration from the specified file
type DisplayProps = {
    term: Terminal;
    pipeline: Required<Pipeline>;
};

const React = {
    "useEffect": useEffect,
    "useMemo": useMemo,
}

export const Display: FunctionalComponent<DisplayProps> = (displayProps: DisplayProps, children: any) => {


    const { term } = displayProps;

    const termMemo = React.useMemo(() => {
        return term;
    }, [term]);

    const file = "/pipeline.json";
    let loader: PipelineLoader = {
        file, term
    };

    const PerformPipelineActionCompleter: FunctionalComponent<
        {
            pipeline: Pipeline & PipelineConfig,
        }> = ({ pipeline }) => {
            const { metadata } = pipeline;
            if (!metadata) {
                return <p>Pipeline metadata is missing</p>;
            }
            if (!pipeline.messages) {
                const { version, created_at, description } = metadata;
                return (
                    <div>
                        <h2>Pipeline Metadata</h2>
                        <h3>Pipeline Data: currently empty</h3>
                        <p><strong>Version:</strong> {version}</p>
                        <p><strong>Created At:</strong> {created_at}</p>
                        <p><strong>Description:</strong> {description}</p>
                    </div>
                );
            }
            console.dir("Metadata specification: ", pipeline.metadata);

            const { file } = pipeline;
            console.log("Printing pipeline from file spec: ", file);

            const messages = pipeline.messages;

            if (!messages)
                return;

            console.debug("Pipeline data: ", messages);

            const [message, ...rest] = messages;
            if (!rest) return <p>Pipeline incomplete: {JSON.stringify({ message })}</p>;

            if (Array.isArray(messages)) {
                if (typeof message === 'string') {
                    return <section>
                        <h4>Pipeline Message: {message}</h4>
                        {rest.map((msg, index) => (
                            <p key={index}>Pipeline Stage {index + 1}: {msg}</p>
                        ))}
                    </section>;
                }
                return messages.map((msg, index) => (
                    <il>
                        <li key={index}>Pipeline Stage {index + 1}: {JSON.stringify(msg)}</li>
                    </il>
                ));
            }
            return <ul><li key="0">Pipeline is empty</li></ul>;
        }

    const pipelineEffect: () => PipelineConfig = async () => {
        // Perform any necessary setup or cleanup here
        // For example, you can set up event listeners or fetch data
        const fileHandle = loader.file;
        if (!fileHandle) {
            return "No file handle specified, check pipeline.file";
        }
        // branch b we have to return PipelineConfig
        const loadPipelineConfig: (pipelineLoader: PipelineLoader) => Promise<PipelineConfig> = (pipelineData) => {
            const pipelineFetch = fetch(fileHandle).then((data) => {
                const temp = data.json();
                return temp
            }, (err) => new Error(`Failed to fetch pipeline configuration from ${fileHandle}: ${err.message}`))
                .then((data) => (isPipeline(data)) ? data as Pipeline : data);

            return pipelineFetch.then(async (response) => {
                if (!response.ok) {
                    throw new Error(`HTTP error status !! ${response.status}`);
                }
                const data = await response.json();
                if (!isPipeline(data)) {
                    const errorMessage = 'Invalid Pipeline: ' + JSON.stringify(data);
                    return flushErrorToTerminal(termMemo, new Error(errorMessage));
                }
                return data;
            }).catch((error) => {
                return error;
            }).then((value: Partial<Pipeline>) => {
                // hole:
                if (!value.message) {
                    return value as PipelineConfig;
                }
                const { message } = value;
                if (message) flushErrorToTerminal(termMemo, new Error(message));
                const errorMessage = 'Invalid Pipeline: ' + JSON.stringify(pipelineData);
                flushErrorToTerminal(termMemo, new Error(errorMessage));
                // hole:
                return new Error(errorMessage);
            });
        }
        const pipelineConfig: PipelineConfig = await loadPipelineConfig(loader);
        // const
    }

    const { metadata: pipelineMetadata, messages: data }: PipelineConfig = pipelineEffect();
    if (pipelineMetadata) {
        const { created_at } = pipelineMetadata;
        console.dir({ created_at })
        return <PerformPipelineActionCompleter metadata={pipelineMetadata} />;
    }

    return <PerformPipelineActionCompleter pipeline={null} />;
};
