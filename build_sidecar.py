"""Build the Python sidecar binary for Tauri using PyInstaller."""

import platform
import shutil
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
BINARIES_DIR = PROJECT_ROOT / "src-tauri" / "binaries"
SIDECAR_NAME = "xray-manager-server"

HIDDEN_IMPORTS = [
    "uvicorn",
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "fastapi",
    "starlette",
    "starlette.middleware",
    "starlette.middleware.cors",
    "starlette.staticfiles",
    "starlette.responses",
    "cryptography",
    "cryptography.hazmat.primitives",
    "cryptography.hazmat.primitives.asymmetric",
    "cryptography.hazmat.primitives.asymmetric.x25519",
    "cryptography.hazmat.primitives.serialization",
    "argon2",
    "_argon2_cffi_bindings",
    "_cffi_backend",
    "anyio",
    "anyio._backends",
    "anyio._backends._asyncio",
    "h11",
    "httptools",
    "python_multipart",
    "multipart",
]


def get_target_triple() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == "windows":
        return "x86_64-pc-windows-msvc"
    elif system == "darwin":
        arch = "aarch64" if machine == "arm64" else "x86_64"
        return f"{arch}-apple-darwin"
    elif system == "linux":
        arch = "aarch64" if machine == "aarch64" else "x86_64"
        return f"{arch}-unknown-linux-gnu"
    else:
        raise RuntimeError(f"Unsupported platform: {system}")


def build() -> None:
    triple = get_target_triple()
    output_name = f"{SIDECAR_NAME}-{triple}"

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--name", output_name,
        "--onefile",
        "--noconsole",
        "--add-data", f"config_gen.py{';' if platform.system() == 'Windows' else ':'}.",
    ]

    for imp in HIDDEN_IMPORTS:
        cmd.extend(["--hidden-import", imp])

    cmd.extend(["--collect-all", "cryptography"])
    cmd.append("sidecar_entry.py")

    print(f"Building sidecar for {triple}...")
    print(f"Command: {' '.join(cmd)}")
    subprocess.check_call(cmd, cwd=str(PROJECT_ROOT))

    # Move to Tauri binaries directory
    BINARIES_DIR.mkdir(parents=True, exist_ok=True)
    src = PROJECT_ROOT / "dist" / (output_name + (".exe" if platform.system() == "Windows" else ""))
    dst = BINARIES_DIR / (output_name + (".exe" if platform.system() == "Windows" else ""))
    shutil.copy2(src, dst)
    print(f"Sidecar built: {dst}")

    # Clean up build artifacts
    for d in ["build", "dist", "__pycache__"]:
        p = PROJECT_ROOT / d
        if p.exists():
            shutil.rmtree(p, ignore_errors=True)
    spec_file = PROJECT_ROOT / f"{output_name}.spec"
    if spec_file.exists():
        spec_file.unlink()


if __name__ == "__main__":
    build()
