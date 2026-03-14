## Quick Start - Run Without Docker (One Command)

Run the setup and start all agents with a single command:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/devashish234073/cloud-pc-templates-marketplace/refs/heads/main/cloud-pc-templates/setup_and_run.sh)
```

This will:
- Install all system dependencies (Node.js 20.x, Angular CLI, git, curl, unzip)
- Clone the repository
- Start all JS agents on ports 3000-3100
- Launch the Angular app on port 4200

---

## Alternative: Run Locally

1. Clone the repository:
```bash
git clone https://github.com/devashish234073/cloud-pc-templates-marketplace
cd cloud-pc-templates-marketplace/cloud-pc-templates
```

2. Run the setup script:
```bash
./setup_and_run.sh
```

---

## Run with Docker

Create and run a Docker image using the Dockerfile:

```bash
git clone https://github.com/devashish234073/cloud-pc-templates-marketplace
cd cloud-pc-templates-marketplace/cloud-pc-templates
docker build -t cloud-pc-templates-agents .
docker run -p 3005-3050:3005-3050 -p 4200:4200 cloud-pc-templates-agents
```

Or run directly from DockerHub:
```bash
docker run -p 3005-3050:3005-3050 -p 4200:4200 devashish234073/cloud-pc-templates-agents
```

---

## Run on Termux (Android)

**One-liner to run everything on Android via Termux:**

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/devashish234073/cloud-pc-templates-marketplace/refs/heads/main/cloud-pc-templates/setup_and_run_in_termux.sh)
```

Or locally after cloning:
```bash
bash setup_and_run_in_termux.sh
```

This will:
- Install all dependencies via Termux's pkg package manager (Node.js, Angular CLI, git, curl, unzip)
- Clone the repository
- Start all JS agents on ports 3000-3100
- Launch the Angular app on port 4200

<img width="1391" height="715" alt="image" src="https://github.com/user-attachments/assets/24c73b6f-1ce1-4adf-be7e-3e0a75dd382d" />

<img width="1764" height="829" alt="image" src="https://github.com/user-attachments/assets/aa1bb46b-0875-4e58-bb19-7362ea1de111" />

