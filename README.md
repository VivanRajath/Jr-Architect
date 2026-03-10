# Jr Architect 🚀

Jr Architect is a powerful system that instantly clones any GitHub repository and provisions a live Docker container for it. It automatically detects the project's runtime (Node.js, Python, Go, Rust, React, Next.js, etc.) and starts the appropriate development server. It also features a fully-fledged browser-based IDE for making live code edits.

## Features ✨

### Automatic Runtime Detection
Simply paste a GitHub URL! The engine inspects `package.json`, `requirements.txt`, `go.mod`, etc., or matches keywords in `README.md`/`INSTRUCTIONS.md` to determine the correct Docker image, port, and startup commands. It features specialized extraction for standard frameworks like Next.js, Vite, FastAPI, Django, Flask, Express, and specialized support for Lyzr workflow applications.

### Dual Modes
*   **Prompt Mode (⚡):** Instantly start a sandbox, get a live preview link, and view the container logs directly from the landing page. Perfect for quickly running and sharing apps.
*   **Dev Mode (🖥):** Dive into a full Cloud IDE experience!
    *   **File Explorer:** Browse the cloned repository, create, and delete files.
    *   **Monaco Editor:** A VS Code-like code editor with syntax highlighting and file-saving capabilities.
    *   **Terminal:** An interactive shell to run bash commands directly inside the running Docker container.
    *   **Live Preview:** See your web app running side-by-side with your code.
    *   **AI Agent Chat:** Integrated AI assistant that can help write code, explore files, and execute terminal commands.

## Prerequisites 🛠

Ensure you have the following installed on your host machine:

*   **Docker:** Required to spin up the isolated sandbox containers.
*   **Go (1.20+):** Required to compile and run the backend server.
*   **Python (3.10+):** Required to run the AI coding agent backend.

## Project Structure 📁

*   `main.go`: The core Go server handling HTTP endpoints, Docker sandbox provisioning, asynchronous Dev Mode execution, and WebSocket/API proxies.
*   `detector.go`: The robust runtime detection logic.
*   `index.html`: The UI containing both the landing page and the IDE layout.
*   `ide.js` & `ide.css`: The frontend logic and styling for the Cloud IDE.
*   `sandbox-images/`: Dockerfile definitions for the various supported runtimes (node, python, go, rust, static, etc.).
*   `agent/`: The Python-based AI assistant service (`main.py`, `requirements.txt`).

## Getting Started 🚀

### 1. Start the AI Agent Service

The agent handles chat requests and AI modifications within the IDE.

```bash
cd agent
python -m venv venv
# Activate virtual environment (Windows)
.\venv\Scripts\activate
# Activate virtual environment (Mac/Linux)
# source venv/bin/activate
pip install -r requirements.txt
python main.py
```

*The agent defaults to running on port 8001.*

### 2. Run the Main Backend

The main Go application compiles the server, automatically triggers the pre-building of Docker images in the `sandbox-images/` directory, and serves the UI.

```bash
# In the root repository directory
go build -o sandbox-runner.exe
./sandbox-runner.exe
```

*The UI will be served at `http://localhost:9000`.*

## How it Works 🧠

1.  **Request:** User inputs a GitHub URL on `localhost:9000` and clicks Run.
2.  **Detection & Execution:**
    *   In **Dev Mode**, control is immediately returned to the IDE UI allowing instantaneous visual feedback.
    *   The `main.go` backend uses `git clone` to fetch the repo into a temporary local directory.
    *   `detectRuntimeConfig` scans the repository to figure out the framework.
    *   It executes `docker run` binding the appropriate internal port (e.g., 3000 for Next.js) to a dynamically assigned free port on the host.
3.  **Interaction:** The IDE uses `/file` and `/files` APIs to interact with the local file system slice mounted inside the container, and `docker exec` routes handle the terminal functionality.

## Automatic Cleanup 🧹

Containers spawned by Jr Architect are entirely transient. `main.go` sets up a background goroutine to automatically stop and wipe the Docker container, as well as the locally cloned Git repository directory after **10 minutes** of uptime limits.
