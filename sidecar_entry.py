"""PyInstaller entry point for Xray Manager sidecar.

Runs uvicorn with the FastAPI app, binding to the specified host/port.
When --port 0 is given, finds a free port automatically.
"""

import socket
import sys

import uvicorn

from main import _ARGS, _RESOLVED_PORT, app


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> None:
    port = _ARGS.port
    if port == 0:
        port = _find_free_port()

    import main as main_module
    main_module._RESOLVED_PORT = port

    uvicorn.run(app, host=_ARGS.host, port=port, log_level="info")


if __name__ == "__main__":
    main()
