"""visualise: Streamlit-based visualization of pipeline transformations.

Visualizes the data processing pipeline for propaganda detection,
with support for streaming terminal output to a colored display."""

from __future__ import annotations

import subprocess
import threading
import time
from collections import deque
from typing import Any

import streamlit as st


# ANSI color codes mapping (RGB values)
ANSI_COLORS = {
    'not_propaganda': (0, 153, 255),      # Blue
    'flag_waving': (255, 0, 0),           # Red
    'loaded_language': (0, 204, 0),       # Green
    'name_calling': (255, 165, 0),        # Orange
    'doubt': (75, 0, 130),                # Indigo
    'appeal_to_fear_prejudice': (255, 192, 0),  # Gold
    'causal_oversimplification': (255, 0, 255),  # Magenta
    'repetition': (255, 99, 71),          # Tomato
    'exaggeration': (60, 179, 113),       # Dark Sea Green
    'minimisation': (255, 255, 0),        # Yellow
}

# Default colors for generic output
DEFAULT_COLORS = [
    (64, 164, 223),      # Azure Blue
    (174, 194, 238),     # Light Sky Blue
    (115, 135, 157),     # Slate Gray
    (100, 149, 237),     # Cornflower Blue
]


def parse_ansi_colors(text: str) -> list[tuple[str, tuple[int, int, int] | None]]:
    """Parse ANSI escape codes from text and return styled segments.
    
    Returns:
        List of (text_segment, color_rgb_or_None) tuples.
    """
    import re
    
    # Map ANSI codes to our predefined colors
    color_map = {
        '\033[31m': ANSI_COLORS['flag_waving'],      # Red
        '\033[32m': ANSI_COLORS['loaded_language'],  # Green
        '\033[33m': ANSI_COLORS['name_calling'],     # Yellow
        '\033[34m': ANSI_COLORS['doubt'],            # Blue
        '\033[35m': ANSI_COLORS['appeal_to_fear_prejudice'],  # Magenta
        '\033[36m': ANSI_COLORS['causal_oversimplification'],  # Cyan
        '\033[91m': ANSI_COLORS['repetition'],       # Light Red
        '\033[92m': ANSI_COLORS['exaggeration'],     # Light Green
        '\033[93m': ANSI_COLORS['minimisation'],     # Light Yellow
    }
    
    segments = []
    current_pos = 0
    current_color = None
    
    # Pattern to match ANSI escape sequences (ESC[...m)
    ansi_pattern = re.compile(r'\x1b\[[0-9;]*m')
    
    for match in ansi_pattern.finditer(text):
        # Add text before this match with current color
        if match.start() > current_pos:
            plain_text = text[current_pos:match.start()]
            segments.append((plain_text, current_color))
        
        # Check the escape code for color
        esc_code = match.group()
        color_rgb = color_map.get(esc_code)
        if color_rgb is None and ('\x1b[0m' in esc_code or esc_code == '\x1b[m'):
            # Reset - clear color
            current_color = None
        elif color_rgb:
            current_color = color_rgb
        
        current_pos = match.end()
    
    # Add remaining text after last escape code
    if current_pos < len(text):
        plain_text = text[current_pos:]
        segments.append((plain_text, current_color))
    
    return segments


class StreamBuffer:
    """Thread-safe buffer for streaming command output."""
    
    def __init__(self, max_lines: int = 1000):
        self.lines: deque[tuple[float, str]] = deque(maxlen=max_lines)
        self.lock = threading.Lock()
        self.stopped = False
    
    def append(self, line: str) -> None:
        """Add a new line to the buffer."""
        with self.lock:
            if not self.stopped:
                timestamp = time.time()
                self.lines.append((timestamp, line))
    
    def get_lines(self, since: float | None = None) -> list[tuple[float, str]]:
        """Get lines from buffer, optionally filtered by timestamp."""
        with self.lock:
            if since is None:
                return list(self.lines)
            return [(t, l) for t, l in self.lines if t >= since]
    
    def clear(self) -> None:
        """Clear the buffer."""
        with self.lock:
            self.lines.clear()


def stream_command(command: str, buffer: StreamBuffer) -> threading.Thread:
    """Run a command and stream its output to the buffer.
    
    Args:
        command: Shell command to execute
        buffer: StreamBuffer instance for storing output
    
    Returns:
        Thread running the subprocess
    """
    def reader(pipe):
        try:
            while True:
                line = pipe.readline()
                if not line:
                    break
                # Decode bytes to string if needed
                text = line.decode('utf-8', errors='replace') if isinstance(line, bytes) else line
                buffer.append(text.rstrip())
        except Exception as e:
            buffer.append(f"[ERROR] {e}")
    
    def run():
        try:
            proc = subprocess.Popen(
                command,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,  # Merge stderr to stdout
                bufsize=1,
                text=True
            )
            
            reader_thread = threading.Thread(target=reader, args=(proc.stdout,))
            reader_thread.start()
            
            proc.wait()
            reader_thread.join(timeout=1)
        except Exception as e:
            buffer.append(f"[ERROR] Failed to run command: {e}")
    
    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread


def render_colored_output(lines: list[tuple[float, str]]) -> None:
    """Render lines with ANSI color codes as colored Streamlit output."""
    for _, line in lines:
        if not line.strip():
            st.markdown("")
            continue
            
        # Parse ANSI colors from the line
        segments = parse_ansi_colors(line)
        
        has_colored_text = any(color is not None for _, color in segments)
        
        if not has_colored_text:
            # No styling - just display plain text
            st.text(line)
            return
        
        # Build HTML output with inline styles
        html_parts = []
        for text, color_rgb in segments:
            if not text.strip():
                continue
            if color_rgb:
                hex_color = f"#{color_rgb[0]:02x}{color_rgb[1]:02x}{color_rgb[2]:02x}"
                html_parts.append(f'<span style="color: {hex_color}">{text}</span>')
            else:
                # Plain text without color - escape HTML special chars
                escaped = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
                html_parts.append(escaped)
        
        if html_parts:
            st.markdown(f"<div>{''.join(html_parts)}</div>", unsafe_allow_html=True)


def run_pipeline_stage(stage_name: str, command: str) -> tuple[StreamBuffer, Any]:
    """Run a pipeline stage and return its output buffer.
    
    Args:
        stage_name: Name of the pipeline stage
        command: Shell command to execute for this stage
    
    Returns:
        Tuple of (output_buffer, result_placeholder)
    """
    buffer = StreamBuffer()
    placeholder = st.empty()
    return buffer, placeholder


def main() -> int:
    """Main entry point for the Streamlit visualization app."""
    
    # Page configuration
    st.set_page_config(
        page_title="RareBERT Pipeline Visualiser",
        page_icon="🔍",
        layout="wide"
    )
    
    st.title("🔍 RareBERT Pipeline Visualisation")
    st.markdown("""
    Visualise the data processing pipeline for propaganda detection.
    """)
    
    # Sidebar configuration
    with st.sidebar:
        st.header("Pipeline Controls")
        
        # Command to stream
        default_command = "make enrich_bow < /dev/null"
        command = st.text_area(
            "Command to execute",
            value=default_command,
            height=100
        )
        
        # Pipeline stages
        st.subheader("Pipeline Stages")
        stages = st.multiselect(
            "Select pipeline stages to visualize:",
            options=[
                ("data-loader", "Load Data"),
                ("enrich_bow", "Enrich BOW Features"),
                ("join-stages", "Join Pipeline Stages"),
            ],
            default=["data-loader", "enrich_bow"]
        )
        
        # Auto-refresh setting
        auto_refresh = st.checkbox("Auto-refresh output", value=True)
    
    # Main content area
    col1, col2 = st.columns([2, 1])
    
    with col1:
        st.header("Terminal Output")
        
        # Create a container for streaming output
        output_container = st.container()
        
        # Session state for buffers and threads
        if 'buffers' not in st.session_state:
            st.session_state.buffers = {}
        if 'threads' not in st.session_state:
            st.session_state.threads = {}
        if 'last_timestamp' not in st.session_state:
            st.session_state.last_timestamp = time.time()
        
        # Start/stop buttons
        button_col1, button_col2 = st.columns([1, 1])
        with button_col1:
            start_btn = st.button("▶️ Start Stream", key="start_stream")
        with button_col2:
            stop_btn = st.button("⏹️ Stop Stream", key="stop_stream")
        
        if start_btn and command.strip():
            # Clear old output
            for buf in st.session_state.buffers.values():
                buf.clear()
            st.session_state.last_timestamp = time.time()
            
            # Start streaming the command
            buffer, _ = run_pipeline_stage("main", command)
            st.session_state.buffers['main'] = buffer
            thread = stream_command(command, buffer)
            st.session_state.threads['main'] = thread
            
            st.success(f"Streaming: `{command}`")
        
        if stop_btn:
            # Stop any running streams
            for name, thread in list(st.session_state.threads.items()):
                if hasattr(thread, 'is_alive') and thread.is_alive():
                    pass  # Threads are daemon threads, will end when main process ends
            st.session_state.buffers.clear()
            st.session_state.threads.clear()
        
        # Display streaming output
        with output_container:
            if st.session_state.buffers:
                for name, buffer in list(st.session_state.buffers.items()):
                    lines = buffer.get_lines(since=st.session_state.last_timestamp)
                    if lines:
                        render_colored_output(lines)
                
                # Update timestamp for next refresh
                st.session_state.last_timestamp = time.time()
            else:
                st.info("No active streams. Click 'Start Stream' to begin.")
    
    with col2:
        st.header("Pipeline Overview")
        
        # Visual representation of pipeline stages
        stage_data = [
            {"name": "Data Loader", "status": "✅ Ready" if "data-loader" in stages else "⏭️ Skipped", "icon": "📥"},
            {"name": "BOW Enricher", "status": "✅ Ready" if "enrich_bow" in stages else "⏭️ Skipped", "icon": "🎨"},
            {"name": "Stage Joiner", "status": "✅ Ready" if "join-stages" in stages else "⏭️ Skipped", "icon": "🔗"},
        ]
        
        for stage in stage_data:
            col1, col2 = st.columns([1, 4])
            with col1:
                st.markdown(f"**{stage['icon']}**")
            with col2:
                st.markdown(f"{stage['name']}: {stage['status']}")
        
        # Statistics panel
        st.subheader("Statistics")
        if st.session_state.buffers:
            total_lines = sum(len(buf.lines) for buf in st.session_state.buffers.values())
            st.metric("Total Lines", total_lines)
        else:
            st.metric("Total Lines", 0)
    
    # Footer
    st.markdown("---")
    st.caption("RareBERT Pipeline Visualiser - Built with Streamlit")


def run() -> int:
    """Entry point for running as a script.
    
    When run directly or via 'make visualise', starts the Streamlit app.
    This is because streamlit apps need to be started with 'streamlit run'.
    """
    import sys
    
    # Check if we're being imported (not running as main)
    # If streamlit module is available, try to run as streamlit app
    try:
        import streamlit as st_module
        
        # Run the main Streamlit function directly when executed via python
        # This allows 'python visualise.py' or 'make visualise' to work
        return main()
    except ImportError:
        print("Streamlit not installed. Install with: pip install streamlit")
        return 1


if __name__ == "__main__":
    raise SystemExit(run())
