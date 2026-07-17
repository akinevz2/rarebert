/**
 * Pipeline configuration type definition
 */
interface PipelineConfig {
  /**
   * Array of pipeline stages
   */
  pipeline: PipelineStage[];
  
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

/**
 * Individual pipeline stage configuration
 */
interface PipelineStage {
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
  description?: string;
  
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