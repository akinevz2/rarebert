# NLP Pipeline Viewer

A web application to visualize the propaganda detection pipeline stages.

## Pipeline Structure

The pipeline is defined in a JSON file with the following structure:

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
    },
    {
      "module": "tokeniser",
      "runtime": "python",
      "printout": "Split text into tokens for span analysis",
      "args": {}
    }
  ],
  "metadata": {
    "version": "1.0",
    "created_at": "2026-07-17",
    "description": "Propaganda detection pipeline using genetic coevolution approach"
  }
}
```

## Features

- Load and display pipeline stages one at a time
- Navigate through pipeline stages with Previous/Continue/Reset buttons
- Shows module name, runtime type, description, and arguments for each stage
- Interactive slideshow interface

## How to Use

1. Click "Load Pipeline" to load the pipeline.json file
2. Use "Continue" button to advance through pipeline stages
3. Use "Previous" to go back to previous stages
4. Use "Reset" to return to the first stage

## Requirements

- Modern web browser
- No build process required - serves static files