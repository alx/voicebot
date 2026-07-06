#!/bin/bash

# WhatsApp Group ID Finder Script
# This script connects to WhatsApp and lists all groups with their IDs

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "Starting WhatsApp Group ID Finder..."
echo

# Check if bot directory exists
if [ ! -d "bot" ]; then
    echo "Error: bot/ directory not found"
    exit 1
fi

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    echo "Please install Node.js v18+ first"
    exit 1
fi

# Check if node_modules exists
if [ ! -d "bot/node_modules" ]; then
    echo "Installing Node.js dependencies..."
    cd bot
    npm install
    cd ..
    echo
fi

# Run the group ID finder script
cd bot
node get_group_id.js
