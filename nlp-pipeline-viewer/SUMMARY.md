# NLP Pipeline Viewer - Summary

## Current Functionality

The NLP Pipeline Viewer is a web application that provides an interactive visualization of the propaganda detection pipeline. It allows users to step through each stage of the pipeline and view detailed information about each component.

### Key Features

1. **Pipeline Loading**: Automatically loads `pipeline.json` from the filesystem
2. **Interactive Navigation**: 
   - Load Pipeline button to initialize the viewer
   - Continue button to advance to next pipeline stage
   - Previous button to go back to previous stages  
   - Reset button to return to first stage
3. **Detailed Stage Display**:
   - Module name
   - Runtime environment (python, java, make, etc.)
   - Description of what the stage does
   - Arguments passed to the module
4. **Visual Interface**:
   - Clean, readable display format
   - Progress tracking (Stage X/Y)
   - Color-coded elements for better readability

### Pipeline Structure

The application expects a JSON structure like:

```json
{
  "pipeline": [
    {
      "module": "data-loader",
      "runtime": "python",
      "printout": "Load training dataset from TSV files",
      "args": {
        "training": true
      }
    }
  ],
  "metadata": {
    "version": "1.0",
    "created_at": "2026-07-17",
    "description": "Propaganda detection pipeline using genetic coevolution approach"
  }
}
```

### Technical Implementation

- **Frontend**: Pure HTML/JavaScript with no build process required
- **Dependencies**: Uses xterm.js for terminal-like display (though not actively used in this version)
- **Server**: Simple static file server using http-server
- **Structure**: 
  - `src/pipeline-types.ts` - TypeScript definitions for pipeline structure
  - `README.md` - Documentation
  - `index.html` - Main application entry point

### Usage

1. Run `npm run dev` to start the development server
2. Open http://127.0.0.1:3000 in a web browser
3. Click "Load Pipeline" to load the configuration
4. Use "Continue" button to step through pipeline stages

### Next Steps

The application is ready for integration with a Makefile runner that would:
1. Execute each pipeline stage using `make`
2. Write output to JSON log files
3. The frontend would then read from these JSON logs for real-time visualization

This implementation fulfills all requirements including the "Continue" button functionality and proper TypeScript type definitions.