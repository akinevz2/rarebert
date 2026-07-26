"""extra-rare-agentic-bert: REST server that executes makefile targets via HTTP."""
# NOT READY FOR PRODUCTION LOL

import json
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer


# Global state for server management
should_terminate = threading.Event()


def run_make_target(target: str) -> tuple[bool, str]:
    """Run a makefile target and return (success, output)."""
    try:
        result = subprocess.run(
            ["make", target],
            capture_output=True,
            text=True,
            timeout=300  # 5 minute timeout
        )
        success = result.returncode == 0

        if not success:
            return (False, f"Make error for '{target}': {result.stderr}")

        return (success, result.stdout)
    except subprocess.TimeoutExpired:
        return (False, f"Timeout executing make {target}")
    except Exception as e:
        return (False, str(e))


class RESTRequestHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the agentic BERT server."""

    def log_message(self, format: str, *args: object) -> None:
        """Override to suppress default logging."""
        pass

    def _send_json_response(self, status_code: int, data: dict[str, object]) -> None:
        """Send a JSON response with the given status code and data."""
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def do_POST(self) -> None:
        """Handle POST requests with make_target JSON body."""
        # Only handle root path
        if self.path != "/":
            self._send_json_response(404, {"error": "Not found"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length == 0:
                self._send_json_response(400, {"error": "Empty request body"})
                return

            raw_body = self.rfile.read(content_length)
            data = json.loads(raw_body.decode("utf-8"))

            # Parse the message
            make_target = data.get("make_target", "")
            
            if not make_target:
                self._send_json_response(400, {"error": "Missing 'make_target' field"})
                return

            # Execute the make command
            success, output = run_make_target(make_target)

            if not success:
                self._send_json_response(500, {
                    "error": f"Target '{make_target}' failed",
                    "output": output.splitlines() if output else []
                })
                return

            # Special handling for join-stages - signal server termination
            if make_target == "join-stages":
                self._send_json_response(200, {
                    "status": "success",
                    "target": make_target,
                    "output": output.splitlines() if output else []
                })
                # Signal the main thread to terminate after sending response
                threading.Thread(target=lambda: (time.sleep(0.1), should_terminate.set()), daemon=True).start()
                return

            self._send_json_response(200, {
                "status": "success",
                "target": make_target,
                "output": output.splitlines() if output else []
            })

        except json.JSONDecodeError as e:
            self._send_json_response(400, {"error": f"Invalid JSON: {str(e)}"})
        except Exception as e:
            self._send_json_response(500, {"error": str(e)})


def main() -> int:
    """Start the REST server on port 8338."""
    # Suppress broken pipe errors
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)

    host = "0.0.0.0"
    port = 8338

    try:
        server = HTTPServer((host, port), RESTRequestHandler)
        print(f"REST server starting on {host}:{port}", file=sys.stderr)
        print("Accepting make_target JSON via POST requests", file=sys.stderr)
        print("Send POST requests to http://localhost:{}/".format(port), file=sys.stderr)

        # Run until termination is requested (e.g., join-stages completed or error)
        while not should_terminate.is_set():
            server.handle_request()

    except OSError as e:
        if "Address already in use" in str(e):
            print(f"Error: Port {port} is already in use", file=sys.stderr)
            return 1
        raise
    finally:
        pass

    print("Server terminated.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
