import type { Terminal } from "@xterm/xterm";

/**
 * Pipeline configuration type definition
 */
export interface PipelineLoader {
  /**
   * Load a pipeline configuration from a file
   */
  file: string;
  term : Terminal;
}
export interface PipelineConfig {
  /**
   * Array of pipeline stages
   */
  messages: PipelineStages;
  
  /**
   * Metadata about the pipeline
   */
  metadata: {
    /**
     * Version of the pipeline
     */
    version: string;
    
    /**
     * Creation timestamp
     */
    created_at: string;
    
    /**
     * Description of the pipeline
     */
    description: string;
  };
}

export type Pipeline = Partial<PipelineConfig> & Required<PipelineLoader>;

/**
 * Individual pipeline stage configuration
 */
interface PipelineItem {
  /**
   * Name of the module
   */
  module: string;
  
  /**
   * Runtime environment for the module
   * Examples: "python", "java", "bash", "make", or etc.
   * Example usage:
   * "python" should invoke the module using the Python interpreter,
   * "java" should invoke the module using the Java runtime, 
   * "make" should invoke the module using the Make utility, and so on.
   */
  runtime: string;
  
  /**
   * Description of what this stage does
   */
  description: string;
  
  /**
   * Text output of what this stage did
   */
  printout?: string;
  
  /**
   * Arguments passed to the module
   */
  args: {
    [key: string]: any;
  };
}

export type PipelineStage = PipelineItem | string;
export type PipelineStages = ReadonlyArray<PipelineStage>;

export const pipelineConfigSchema = {
  type: "object",
  properties: {
    pipeline: {
      type: "array",
      items: {
        type: "object",
        properties: {
          module: { type: "string" },
          runtime: { type: "string" },
          description: { type: "string" },
          printout: { type: "string" },
          args: { type: "object" }
        },
        required: ["module", "runtime", "args"]
      }
    },
    metadata: {
      type: "object",
      properties: {
        version: { type: "string" },
        created_at: { type: "string" },
        description: { type: "string" }
      },
      required: ["version", "created_at", "description"]
    }
  },
  required: ["pipeline", "metadata"]
};

// function is_PipelineConfig(obj: any): obj is PipelineConfig 
function isPipelineConfig(obj: any): obj is PipelineConfig {
  return (
    obj &&
    typeof obj === "object" &&
    Array.isArray(obj.pipeline) &&
    obj.pipeline.every((stage: any) => isPipelineStage(stage)) &&
    obj.metadata &&
    typeof obj.metadata === "object" &&
    typeof obj.metadata.version === "string" &&
    typeof obj.metadata.created_at === "string" &&
    typeof obj.metadata.description === "string"
  );
} 

// function is_PipelineStage(obj: any): obj is PipelineStage 
function isPipelineStage(obj: any): obj is PipelineStage {
  return (
    obj &&
    typeof obj === "object" &&
    typeof obj.module === "string" &&
    typeof obj.runtime === "string" &&
    typeof obj.args === "object"
  );
}


export function isPipeline(obj:any): obj is PipelineConfig {
  return isPipelineConfig(obj);
}