#!/bin/bash

# Setup and Run Script - Equivalent to Dockerfile without Docker
# This script installs dependencies, clones the repository, and runs all agents

set -e  # Exit on any error

echo "=========================================="
echo "Cloud PC Templates Agents Setup"
echo "=========================================="

# Check if running on Ubuntu/Debian
if ! command -v apt-get &> /dev/null; then
    echo "Error: This script requires apt-get (Ubuntu/Debian-based system)"
    exit 1
fi

# Step 1: Update package manager
echo "Step 1: Updating package manager..."
sudo apt-get update

# Step 2: Install system dependencies
echo "Step 2: Installing system dependencies..."
sudo apt-get install -y curl git unzip ca-certificates

# Step 3: Install Node.js 20.x (if not already installed)
echo "Step 3: Checking Node.js installation..."
if ! command -v node &> /dev/null; then
    echo "Node.js not found. Installing Node.js 20.x..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
    echo "Node.js installed successfully"
else
    echo "Node.js is already installed: $(node --version)"
fi

# Step 4: Install Angular CLI globally
echo "Step 4: Installing Angular CLI globally..."
if ! command -v ng &> /dev/null; then
    echo "Angular CLI not found. Installing..."
    npm install -g @angular/cli || sudo -E npm install -g @angular/cli
    echo "Angular CLI installed successfully"
else
    echo "Angular CLI is already installed: $(ng version --minimal)"
fi

# Step 5: Create workspace directory
echo "Step 5: Setting up workspace..."
WORKSPACE_DIR="$HOME/workspace"
mkdir -p "$WORKSPACE_DIR"
cd "$WORKSPACE_DIR"

# Step 6: Clone repository if not already cloned
echo "Step 6: Cloning repository..."
if [ ! -d "cloud-pc-templates-marketplace" ]; then
    git clone https://github.com/devashish234073/cloud-pc-templates-marketplace
    echo "Repository cloned successfully"
else
    echo "Repository already exists, skipping clone"
fi

# Step 7: Navigate to JS-AGENTS directory
cd "$WORKSPACE_DIR/cloud-pc-templates-marketplace/JS-AGENTS"
echo "Working in directory: $(pwd)"

# Step 8: Process and run all agents
echo ""
echo "=========================================="
echo "Starting Agents..."
echo "=========================================="

# Array to store background process PIDs
declare -a PIDS

# Process all .js files
for file in *.js; do
    if [ -f "$file" ]; then
        if [ "$file" = "angularConnector.js" ]; then
            echo "Detected angularConnector.js - setting up Angular project..."
            
            # Create Angular project if it doesn't exist
            if [ ! -d "angular-app" ]; then
                ng new angular-app --defaults --skip-git
            fi
            
            # Copy angularConnector.js to angular-app
            if [ -f angularConnector.js ]; then
                cp angularConnector.js angular-app/
            fi
            
            # Navigate to angular-app and start it
            cd angular-app
            echo "Running angularConnector.js inside Angular project..."
            node angularConnector.js &
            PIDS+=($!)
            cd ..
        else
            echo "Starting: $file"
            node "$file" &
            PIDS+=($!)
        fi
    fi
done

# Step 9: Process all .zip files
echo ""
echo "Processing ZIP files..."
for zip in *.zip; do
    if [ -f "$zip" ]; then
        echo "Processing zip: $zip"
        
        # Extract zip file
        unzip -o "$zip" -d "${zip%.zip}"
        
        # Navigate to extracted directory
        cd "${zip%.zip}"
        
        # If package.json exists, run npm install and npm start
        if [ -f package.json ]; then
            npm install
            echo "Running npm start in: ${zip%.zip}"
            npm start &
            PIDS+=($!)
        fi
        
        cd ..
    fi
done

# Step 10: Wait for all background processes
echo ""
echo "=========================================="
echo "All agents started"
echo "=========================================="
echo "Agent ports available:"
echo "  - Port range: 3000-3100"
echo "  - Angular app: 4200"
echo ""
echo "Press Ctrl+C to stop all agents"
echo "=========================================="

# Wait for all background jobs
wait "${PIDS[@]}"
